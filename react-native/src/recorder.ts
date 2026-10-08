import { resolveOptions, type AnyReplayNativeOptions, type ResolvedOptions } from './config.js';
import {
  MemoryStore, SESSION_IDLE_MS, beginNewSession, forgetVisitor, inCooldown, isSampledIn, reserveSeq,
  resolveIdentity, startCooldown, touchSession, type Identity,
} from './session.js';
import { Transport } from './transport.js';
import { diff, isEmpty, serialise, type CapturedElement } from './tree.js';
import { EVENT, SOURCE, userAgent, type MobileNode, type RecordedEvent, type SessionMeta } from './wire.js';
import { PLATFORM, SDK_NAME, SDK_VERSION } from './version.js';
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
  /**
   * The device. `tablet` is an iPad (`Platform.isPad`) or an Android device
   * whose shorter side is at least 600 dp — Android's own line between a
   * phone and a tablet (`smallestScreenWidthDp`).
   */
  platform(): { os: string; version: string; model?: string; tablet?: boolean };
  locale(): string | undefined;
  /** The current element registry and the id of its root. */
  snapshot(): { elements: Map<number, CapturedElement>; rootId: number; layers?: number[] } | null;
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
  /** Records a tap, in screen points, when the finger lifts. */
  touch(x: number, y: number): void;
  /**
   * The app is back in the foreground. After 30 idle minutes that is a new
   * session; otherwise the next tick sends a whole screen (it may have changed
   * while the app was away) and anything held back by an outage is retried.
   */
  foreground(): void;
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
  /** `force` is the background flush: it goes even while backing off from a failure. */
  flush(options?: { force?: boolean }): Promise<void>;
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
  /**
   * Refusals so far. `begin` waits for the store; a refusal that lands in
   * that wait leaves the recorder asking again (it is an answer, not a
   * `stop()`), so `begin` tells it happened by this count changing, not by
   * the status.
   */
  let refusals = 0;
  /** `consent(true)` arrived while a `begin` was already running: run it again once that one is done. */
  let regrant = false;
  let previous: MobileNode | null = null;
  let ticker: unknown = null;
  let flusher: unknown = null;
  /**
   * Screens shown in this session. The one the app starts on is the first,
   * whether or not anything has named it yet — which is why naming it (the
   * navigation binding reports the initial route as soon as it attaches) must
   * not count it a second time.
   */
  let screenCount = 1;
  /** The current screen's name, kept even before recording starts, so a session can say where it begins. */
  let currentScreen: string | null = null;
  /** Whether the screen counted as the first has been named yet. */
  let firstScreenNamed = false;
  /** The canvas size last sent in a Meta, so a rotation sends a new one. */
  let lastSize: { width: number; height: number } | null = null;
  /**
   * The next tick re-sends the Meta size and screen name before its full
   * snapshot: events the tree depends on were dropped, and the reader may
   * have lost the canvas and the screen as well as the tree.
   */
  let resync = false;
  /** When this session last emitted an event: what the 30-minute idle rule measures. */
  let lastActivity = 0;
  /** The meta the current session's first chunk carries, until a chunk has been accepted. */
  let sessionMeta: SessionMeta | undefined;
  /**
   * Traits given to `identify` before there was a session to attach them to.
   * Held in memory only and sent the moment recording starts, so
   * `consent(true)` followed by `identify` on the next line works even though
   * consent has to read the store first — and an identity never leaves the
   * device for a person who has not agreed.
   */
  let pendingTraits: IdentifyTraits | undefined;
  /**
   * The traits last attached to a session, so the session that replaces it
   * after a long absence belongs to the same person: it is the same person,
   * on the same launch, who came back.
   */
  let knownTraits: IdentifyTraits | undefined;
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
      body: JSON.stringify({
        projectKey: options.projectKey, sessionId: who.sessionId, ...traits,
        ...(options.appId ? { appId: options.appId } : {}),
      }),
    }).catch(() => { /* identity is best-effort and never surfaces to the app */ });
  };

  const emit = (event: RecordedEvent): void => {
    lastActivity = event.timestamp;
    transport?.push(event);
    void touchSession(store, event.timestamp).catch(() => {});
  };

  const screenSize = (): { width: number; height: number } => {
    const size = host.screen();
    return { width: Math.round(size.width), height: Math.round(size.height) };
  };

  /** The canvas, in a Meta event: the player needs it before anything to draw on it. */
  const emitSize = (size: { width: number; height: number }): void => {
    lastSize = size;
    emit({ type: EVENT.meta, timestamp: host.now(), data: { width: size.width, height: size.height } });
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
      // An error from before recording started — a crash during boot — is
      // still an error in this session, and the session list finds sessions
      // with errors by this flag, not by reading their events.
      if (item.tag === ERROR_TAG) transport.mergeFlags({ hasError: true });
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

    // Rotation, split screen, a foldable opening: a new canvas, and a whole
    // new screen on it, since the layout has changed everywhere.
    const size = screenSize();
    if (resync || !lastSize || size.width !== lastSize.width || size.height !== lastSize.height) {
      // Nothing delivered yet and the opening events dropped: the recording
      // now starts here, and says so (META-006 wants `startedAt` near the
      // first event the reader sees).
      if (resync && transport?.lostOpening && sessionMeta) {
        sessionMeta = { ...sessionMeta, startedAt: host.now() };
        transport.setMeta(sessionMeta);
      }
      emitSize(size);
      previous = null;
      if (resync && currentScreen) {
        emit({ type: EVENT.meta, timestamp: host.now(), data: { href: currentScreen } });
      }
      resync = false;
    }

    const captured = host.snapshot();
    if (!captured) return;

    const tree = serialise(captured.elements, captured.rootId, size, captured.layers);

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
   * A channel to ingest for one session, and the session's opening events:
   * its meta, the canvas, the screen it starts on. Used when recording
   * starts and again when a long absence starts a new session.
   */
  const openSession = (who: Identity): void => {
    identity = who;
    const channel: Transport = new Transport(
      {
        ingestUrl: options.ingestUrl,
        projectKey: options.projectKey,
        sessionId: who.sessionId,
        visitorId: who.visitorId,
        maxEventsPerChunk: options.maxEventsPerChunk,
        maxBufferedEvents: options.maxBufferedEvents,
        initialSeq: who.nextSeq,
        appId: options.appId,
        now: () => host.now(),
        debug: options.debug,
      },
      {
        // Every hook first checks it still belongs to the current session: a
        // session that ended keeps trying to send its tail, and must not
        // reserve numbers in, or stop, the one that replaced it.
        onSeqReserved: (next) => {
          if (channel === transport) void reserveSeq(store, next).catch(() => {});
        },
        onDropped: () => {
          if (channel === transport) resync = true;
        },
        onStopped: (reason) => {
          if (channel !== transport) return;
          status = 'stopped';
          halt();
          // Only the verdict about the session itself is remembered across
          // launches, as in the browser SDK: an outage is transient and a
          // wrong key is one request per launch to notice it is fixed, but a
          // full quota is neither.
          if (reason === 'rejected_402') void startCooldown(store, host.now()).catch(() => {});
          if (options.debug) console.warn(`[anyreplay] recording stopped: ${reason}`);
        },
      },
      host.fetch,
    );
    transport = channel;

    const device = host.platform();
    const size = screenSize();
    sessionMeta = {
      startedAt: host.now(),
      lang: host.locale(),
      userAgent: userAgent(device.os, device.version, device.model, { tablet: device.tablet, sdkVersion: SDK_VERSION }),
      screenWidth: size.width,
      screenHeight: size.height,
      // What this SDK is and what it runs in, stored once with the session.
      // The model only where React Native offers it without a native module
      // (Android's `Platform.constants.Model`); iOS leaves it out.
      platform: PLATFORM,
      sdk: { name: SDK_NAME, version: SDK_VERSION },
      ...(options.appVersion ? { appVersion: options.appVersion } : {}),
      ...(device.model ? { deviceModel: device.model.slice(0, 64) } : {}),
      ...(currentScreen ? { url: currentScreen } : {}),
    };
    channel.setMeta(sessionMeta);
    channel.mergeFlags({ pageCount: screenCount });

    // A Meta event first, so the player knows the canvas it is drawing on
    // before it receives anything to draw; then the screen, when the app has
    // named it already — the navigation binding often does before consent.
    emitSize(size);
    if (currentScreen) emit({ type: EVENT.meta, timestamp: host.now(), data: { href: currentScreen } });
    previous = null;
    resync = false;
  };

  /**
   * Ends the session and starts the next one, for a person who came back
   * after the idle window: a new id, numbering from 0, its own meta and a
   * whole screen — the same as a launch would have made.
   *
   * What the old session still had buffered is given one last try and then
   * let go; it is half an hour old, and the new session must not wait on it.
   */
  const startNextSession = (): void => {
    if (!identity || !transport) return;
    const old = transport;
    void old.flush({ force: true }).catch(() => {});
    recentTaps.length = 0;
    screenCount = 1;
    firstScreenNamed = currentScreen !== null;
    const next = beginNewSession(store, identity.visitorId, host.now());
    openSession(next);
    tick();
    if (knownTraits) sendIdentity(next, knownTraits);
  };

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
    const epoch = refusals;
    try {
      const who = await resolveIdentity(store, host.now());
      if (refusals !== epoch || !mayStart()) {
        // Refused, or stopped, while the store was answering. The id it just
        // wrote is one the refusal meant to remove.
        if (refusals !== epoch || status === 'stopped') await forgetVisitor(store);
        return;
      }
      identity = who;

      if (!isSampledIn(who.visitorId, options.sampleRate)) {
        status = 'sampled-out';
        return;
      }

      if (await inCooldown(store, host.now()).catch(() => false)) {
        // Ingest refused a session from this app moments ago — a full quota,
        // a reached cap. That answer will not have changed a launch later.
        status = 'stopped';
        if (options.debug) console.warn('[anyreplay] not recording: ingest refused a new session recently');
        return;
      }
      if (refusals !== epoch) {
        identity = undefined;
        await forgetVisitor(store);
        return;
      }
      if (!mayStart()) return;

      status = 'recording';
      openSession(who);

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
        onError: () => transport?.mergeFlags({ hasError: true }),
      });

      tick();
      drainPending();
      ticker = host.setInterval(tick, options.snapshotIntervalMs);
      flusher = host.setInterval(() => { void transport?.flush(); }, options.flushIntervalMs);
      if (pendingTraits) {
        sendIdentity(who, pendingTraits);
        knownTraits = pendingTraits;
        pendingTraits = undefined;
      }
    } finally {
      starting = false;
      // Refused and accepted again while this one was running: the latest
      // answer is a yes, and this run gave up on the refused one.
      if (regrant) {
        regrant = false;
        if (mayStart()) void begin().catch(() => { /* never surfaces to the app */ });
      }
    }
  };

  if (options.requireConsent) status = 'awaiting-consent';
  else await begin();

  return {
    status: () => status,
    sessionId: () => identity?.sessionId ?? null,

    consent: (granted) => {
      if (granted) {
        if (starting) regrant = true;
        void begin().catch(() => { /* never surfaces to the app */ });
        return;
      }
      refusals += 1;
      regrant = false;
      // A refusal stops this launch and undoes what an earlier acceptance
      // stored — on this launch or on one last month. Stopping first, so no
      // flush reserves a chunk number after the keys are gone.
      halt();
      transport?.stop('consent_withdrawn');
      // Nothing was recording yet (still asking, or asked and sampled out):
      // the refusal is an answer, not a `stop()`. The recorder goes back to
      // waiting, so a person who says no and later yes on the same launch is
      // recorded from then on, as a new visitor with a fresh sampling draw
      // (contract §3.5). A recording that had started stays stopped (§3.6).
      if (mayStart() || status === 'sampled-out') {
        status = 'awaiting-consent';
        identity = undefined;
      }
      pendingTraits = undefined;
      // What was tagged while asking belongs to the answer that was refused.
      pending.length = 0;
      void forgetVisitor(store).catch(() => {});
    },

    identify: (traits) => {
      if (!traits.userId && !traits.email) return;
      if (identity && transport) {
        sendIdentity(identity, traits);
        knownTraits = traits;
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
      if (typeof name !== 'string' || name.length === 0) return;
      currentScreen = name.slice(0, 2048);
      // The screen the app starts on is already counted; naming it is not a
      // second screen. Before recording starts there is nothing to count yet.
      if (!firstScreenNamed) firstScreenNamed = true;
      else if (status === 'recording') screenCount += 1;
      if (status !== 'recording') return;
      previous = null;
      transport?.mergeFlags({ pageCount: screenCount });
      emit({ type: EVENT.meta, timestamp: host.now(), data: { href: currentScreen } });
    },

    touch: (x, y) => {
      if (status !== 'recording') return;
      const t = host.now();
      // Rounded once, and the rage rule below reads the same numbers the
      // wire carries, so the conformance checker re-deriving it from the
      // recording can never disagree at the edge of the 30-point square.
      const tap = { x: Math.round(x), y: Math.round(y), t };
      emit({
        type: EVENT.incremental,
        timestamp: t,
        data: { source: SOURCE.mouseInteraction, type: 2, x: tap.x, y: tap.y },
      });

      recentTaps.push(tap);
      while (recentTaps.length > 0 && t - recentTaps[0]!.t > RAGE_WINDOW_MS) recentTaps.shift();
      // Counted around the tap that just landed, not around the oldest in the
      // window — the browser SDK's rule. Measured from the oldest, one stray
      // tap elsewhere a moment earlier hid the burst on the button that is
      // not answering, which is the very burst the flag exists for.
      const near = recentTaps.filter(
        (other) => Math.abs(other.x - tap.x) < RAGE_RADIUS_PT && Math.abs(other.y - tap.y) < RAGE_RADIUS_PT,
      );
      if (near.length >= RAGE_COUNT) transport?.mergeFlags({ hasRageClick: true });
    },

    foreground: () => {
      if (status !== 'recording' || !transport) return;
      if (host.now() - lastActivity >= SESSION_IDLE_MS) {
        startNextSession();
        return;
      }
      // The screen may have changed while the app was away, and a diff against
      // what was there before it left could describe a tree nobody saw.
      previous = null;
      // Coming back is usually when the network has too.
      transport.retryNow();
      void transport.flush().catch(() => {});
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
    flush: (flushOptions) => transport?.flush(flushOptions) ?? Promise.resolve(),
  };
}
