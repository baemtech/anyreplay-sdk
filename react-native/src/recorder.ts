import { resolveOptions, type AnyReplayNativeOptions, type ResolvedOptions } from './config.js';
import {
  MemoryStore, forgetVisitor, isSampledIn, reserveSeq, resolveIdentity, touchSession, type Identity,
} from './session.js';
import { Transport } from './transport.js';
import { diff, isEmpty, serialise, type CapturedElement } from './tree.js';
import { EVENT, SOURCE, userAgent, type MobileNode, type RecordedEvent } from './wire.js';
import {
  ERROR_TAG, TRACK_TAG, errorPayload, startDiagnostics, validateTrack, type DiagnosticsHandle,
} from './events.js';

export type RecorderStatus = 'idle' | 'awaiting-consent' | 'recording' | 'sampled-out' | 'stopped';

/**
 * Everything the recorder needs from the platform, in one place.
 *
 * React Native is reached through this and nowhere else, which is what lets the
 * whole recorder be tested in plain Node — including the parts that decide what
 * a customer's users have recorded about them, which are exactly the parts
 * worth testing without a simulator in the loop.
 */
export interface Host {
  now(): number;
  screen(): { width: number; height: number };
  platform(): { os: string; version: string; model?: string };
  locale(): string | undefined;
  /** The current element registry and the id of its root. */
  snapshot(): { elements: Map<number, CapturedElement>; rootId: number } | null;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  fetch: typeof fetch;
}

export interface IdentifyTraits {
  userId?: string;
  email?: string;
}

export interface RecorderHandle {
  status(): RecorderStatus;
  sessionId(): string | null;
  consent(granted: boolean): void;
  identify(traits: IdentifyTraits): void;
  /** Records a screen change. Called by the navigation binding. */
  screen(name: string): void;
  /** Records a touch, in screen points. */
  touch(x: number, y: number): void;
  /**
   * Tags this moment of the recording. Same contract as the browser SDK:
   * `name` is 1–64 characters of `[A-Za-z0-9_.:-]`, `properties` a plain JSON
   * object of at most 4 KB. Anything else is dropped with a warning in debug
   * mode, never an exception.
   */
  track(name: string, properties?: Record<string, unknown>): void;
  /** Records an error the app caught itself, or a rejection its tracker saw. */
  trackError(error: unknown): void;
  stop(): void;
  flush(): Promise<void>;
}

/**
 * Events tagged before recording starts. Matches the browser SDK, for the same
 * reason: an app's boot sequence fits, a loop does not.
 */
const MAX_PENDING_EVENTS = 32;

/** Rage tap: several taps in nearly the same spot in quick succession. */
const RAGE_COUNT = 3;
const RAGE_WINDOW_MS = 1000;
const RAGE_RADIUS_PT = 30;

export async function createRecorder(
  raw: AnyReplayNativeOptions,
  host: Host,
): Promise<RecorderHandle> {
  const options: ResolvedOptions = resolveOptions(raw);
  const store = options.storage ?? new MemoryStore();

  let status: RecorderStatus = 'idle';
  /**
   * Who this is, and the channel to ingest. Neither exists until the recorder
   * is allowed to record — see `begin`. With `requireConsent` that is the
   * moment `consent(true)` is called; otherwise it is before `init` resolves.
   */
  let identity: Identity | undefined;
  let transport: Transport | undefined;
  let starting = false;
  let previous: MobileNode | null = null;
  let ticker: unknown = null;
  let flusher: unknown = null;
  let screenCount = 1;
  /**
   * Traits given to `identify` before there was a session to attach them to.
   * Held in memory only and sent the moment recording starts, so
   * `consent(true)` followed by `identify` on the next line works even though
   * consent has to read the store first — and an identity never leaves the
   * device for a person who has not agreed.
   */
  let pendingTraits: IdentifyTraits | undefined;
  /** Patched globals wait here to be put back; see `events.ts`. */
  let diagnostics: DiagnosticsHandle | undefined;
  /**
   * Events tagged before there is a transport — while consent is pending, or
   * during the first `await` of `begin()` — wait here.
   *
   * In memory only: something tracked before consent must leave no trace a
   * refusal would have to clean up. Enough for an app's boot sequence; an app
   * that tags more than this before recording starts is looping, and keeping
   * the oldest ones tells the story better than the newest.
   */
  const pending: { tag: string; payload: unknown }[] = [];

  const sendIdentity = (who: Identity, traits: IdentifyTraits): void => {
    void host.fetch(`${options.ingestUrl}/v1/ingest/identify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectKey: options.projectKey, sessionId: who.sessionId, ...traits }),
    }).catch(() => { /* identity is best-effort and never surfaces to the app */ });
  };

  const emit = (event: RecordedEvent): void => {
    transport?.push(event);
    void touchSession(store, event.timestamp);
  };

  /** A tagged moment, in rrweb's Custom event shape — the same one a page sends. */
  const emitCustom = (tag: string, payload: unknown): void => {
    if (status === 'stopped' || status === 'sampled-out') return;
    if (status === 'recording' && transport) {
      emit({ type: EVENT.custom, timestamp: host.now(), data: { tag, payload } });
      return;
    }
    if (pending.length >= MAX_PENDING_EVENTS) {
      if (options.debug) console.warn(`[anyreplay] dropped ${tag}: too many events before recording started`);
      return;
    }
    pending.push({ tag, payload });
  };

  /**
   * Sends what was tagged before there was a transport.
   *
   * Stamped now rather than when it was tagged: a recording's clock starts
   * with its first event, and an event stamped before that would replay off
   * the left edge of the timeline.
   */
  const drainPending = (): void => {
    if (pending.length === 0 || status !== 'recording' || !transport) return;
    for (const item of pending.splice(0, pending.length)) {
      emit({ type: EVENT.custom, timestamp: host.now(), data: { tag: item.tag, payload: item.payload } });
    }
  };

  const recentTaps: { x: number; y: number; t: number }[] = [];

  /**
   * Reads the screen and sends what changed.
   *
   * The first read of a session is a whole snapshot because there is nothing to
   * compare against; every read after it is a diff, and on a typical screen the
   * diff is a handful of numbers. That ratio is the entire cost argument for
   * this design over recording video.
   */
  const tick = (): void => {
    if (status !== 'recording') return;
    const captured = host.snapshot();
    if (!captured) return;

    const tree = serialise(captured.elements, captured.rootId, host.screen());

    if (!previous) {
      emit({ type: EVENT.fullSnapshot, timestamp: host.now(), data: { node: tree } });
      previous = tree;
      return;
    }

    const mutation = diff(previous, tree);
    previous = tree;
    if (isEmpty(mutation)) return;

    emit({
      type: EVENT.incremental,
      timestamp: host.now(),
      data: { source: SOURCE.mutation, ...mutation },
    });
  };

  const halt = (): void => {
    if (ticker !== null) { host.clearInterval(ticker); ticker = null; }
    if (flusher !== null) { host.clearInterval(flusher); flusher = null; }
    diagnostics?.stop();
    diagnostics = undefined;
  };

  const mayStart = (): boolean => status === 'idle' || status === 'awaiting-consent';

  /**
   * Everything that leaves a trace happens here, and nothing before it.
   *
   * Resolving the identity writes the visitor id to the app's storage;
   * opening the transport is what makes a request possible; the ticker is
   * what reads the screen. With `requireConsent` all of it waits for
   * `consent(true)`, because an identifier kept on the device is the very
   * thing the consent is for. Nor is an id a previous launch stored taken as
   * evidence of consent: it may predate a refusal, or have been written by a
   * version of this recorder that stored it without asking. Only the app
   * knows the current answer, and it says so by calling `consent`.
   *
   * Sampling is still decided from the visitor id, so it is the same answer
   * for the same person on every launch. What moves is *when*: a person is
   * sampled on first consent rather than on first launch, and one who
   * refuses is forgotten, so a later acceptance is a fresh draw.
   */
  const begin = async (): Promise<void> => {
    if (starting || !mayStart()) return;
    starting = true;
    try {
      const who = await resolveIdentity(store, host.now());
      if (!mayStart()) {
        // Refused, or stopped, while the store was answering. The id it just
        // wrote is one the refusal meant to remove.
        if (status === 'stopped') await forgetVisitor(store);
        return;
      }
      identity = who;

      if (!isSampledIn(who.visitorId, options.sampleRate)) {
        status = 'sampled-out';
        return;
      }

      const channel = new Transport(
        {
          ingestUrl: options.ingestUrl,
          projectKey: options.projectKey,
          sessionId: who.sessionId,
          visitorId: who.visitorId,
          maxEventsPerChunk: options.maxEventsPerChunk,
          maxConsecutiveFailures: options.maxConsecutiveFailures,
          maxBufferedEvents: options.maxBufferedEvents,
          initialSeq: who.nextSeq,
          now: () => host.now(),
        },
        {
          onSeqReserved: (next) => { void reserveSeq(store, next).catch(() => {}); },
          onStopped: (reason) => {
            status = 'stopped';
            halt();
            if (options.debug) console.warn(`[anyreplay] recording stopped: ${reason}`);
          },
        },
        host.fetch,
      );
      transport = channel;
      status = 'recording';

      const device = host.platform();
      const size = host.screen();
      channel.setMeta({
        startedAt: host.now(),
        lang: host.locale(),
        userAgent: userAgent(device.os, device.version, device.model),
        screenWidth: Math.round(size.width),
        screenHeight: Math.round(size.height),
      });
      channel.mergeFlags({ pageCount: screenCount });

      // A Meta event first, so the player knows the canvas it is drawing on
      // before it receives anything to draw.
      emit({
        type: EVENT.meta,
        timestamp: host.now(),
        data: { width: Math.round(size.width), height: Math.round(size.height) },
      });

      /*
       * Errors and console lines, once there is somewhere to put them.
       *
       * Started here rather than at `init` so nothing global is patched for a
       * visitor who is sampled out, has refused, or whose session never
       * began — and so `ErrorUtils`' single handler slot is only taken while
       * a recording is actually running.
       */
      diagnostics = startDiagnostics({
        errors: options.recordErrors,
        console: options.recordConsole,
        emit: emitCustom,
        onError: () => channel.mergeFlags({ hasError: true }),
      });

      tick();
      drainPending();
      ticker = host.setInterval(tick, options.snapshotIntervalMs);
      flusher = host.setInterval(() => { void channel.flush(); }, options.flushIntervalMs);
      if (pendingTraits) {
        sendIdentity(who, pendingTraits);
        pendingTraits = undefined;
      }
    } finally {
      starting = false;
    }
  };

  if (options.requireConsent) status = 'awaiting-consent';
  else await begin();

  return {
    status: () => status,
    sessionId: () => identity?.sessionId ?? null,

    consent: (granted) => {
      if (granted) {
        void begin().catch(() => { /* never surfaces to the app */ });
        return;
      }
      // A refusal stops this launch and undoes what an earlier acceptance
      // stored — on this launch or on one last month. Stopping first, so no
      // flush reserves a chunk number after the keys are gone.
      halt();
      transport?.stop('consent_withdrawn');
      if (mayStart()) status = 'stopped';
      pendingTraits = undefined;
      void forgetVisitor(store).catch(() => {});
    },

    identify: (traits) => {
      if (!traits.userId && !traits.email) return;
      if (identity && transport) {
        sendIdentity(identity, traits);
        return;
      }
      // No session yet. While consent is pending, or being acted on, the
      // traits wait; a person who is sampled out or stopped has no session
      // to attach them to.
      if (mayStart()) pendingTraits = traits;
    },

    /**
     * A screen change is this platform's page view.
     *
     * The tree is forgotten so the next tick sends a whole snapshot: after a
     * navigation almost nothing is the same, and a diff against the old screen
     * would be larger than the snapshot it replaced.
     */
    screen: (name) => {
      if (status !== 'recording') return;
      screenCount += 1;
      previous = null;
      transport?.mergeFlags({ pageCount: screenCount });
      emit({ type: EVENT.meta, timestamp: host.now(), data: { href: name } });
    },

    touch: (x, y) => {
      if (status !== 'recording') return;
      const t = host.now();
      emit({
        type: EVENT.incremental,
        timestamp: t,
        data: { source: SOURCE.mouseInteraction, type: 2, x: Math.round(x), y: Math.round(y) },
      });

      recentTaps.push({ x, y, t });
      while (recentTaps.length > 0 && t - recentTaps[0]!.t > RAGE_WINDOW_MS) recentTaps.shift();
      if (recentTaps.length >= RAGE_COUNT) {
        const first = recentTaps[0]!;
        const clustered = recentTaps.every(
          (tap) => Math.abs(tap.x - first.x) < RAGE_RADIUS_PT && Math.abs(tap.y - first.y) < RAGE_RADIUS_PT,
        );
        if (clustered) transport?.mergeFlags({ hasRageClick: true });
      }
    },

    track: (name, properties) => {
      const payload = validateTrack(name, properties);
      if (typeof payload === 'string') {
        if (options.debug) console.warn(`[anyreplay] track() ignored: ${payload}`);
        return;
      }
      emitCustom(TRACK_TAG, payload);
    },

    /**
     * An error the app caught itself.
     *
     * Routed through the diagnostics handle while one exists, so it shares the
     * per-session ceiling and the `hasError` flag with the errors the global
     * handler sees. Before recording starts there is no handle, and the error
     * is queued like any other tagged moment — which is the case that matters,
     * because a crash during boot is the one an app most wants recorded.
     */
    trackError: (error) => {
      if (!options.recordErrors) return;
      if (diagnostics) {
        diagnostics.rejection(error);
        return;
      }
      emitCustom(ERROR_TAG, errorPayload('error', error));
    },

    stop: () => {
      halt();
      transport?.stop('stopped_by_app');
      // Stopped before it ever started: a later consent(true) must not start
      // what the app has already said it does not want.
      if (mayStart()) status = 'stopped';
      pendingTraits = undefined;
    },
    flush: () => transport?.flush() ?? Promise.resolve(),
  };
}
