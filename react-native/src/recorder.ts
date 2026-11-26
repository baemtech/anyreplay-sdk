import type { DetectedIdentity } from './app-identity.js';
import { resolveOptions, type AnyReplayNativeOptions, type ResolvedOptions } from './config.js';
import {
  CLIP_AT_KEY, CLIP_RING_KEY, CONFIG_KEY, CRASH_CLIP_KEY, CRASH_RECORDING_KEY, MemoryStore, NATIVE_CRASH_KEY,
  SESSION_IDLE_MS, beginNewSession,
  forgetVisitor, inCooldown, isSampledIn, reserveSeq, resolveIdentity, startCooldown, touchSession, uuidv4,
  type Identity,
} from './session.js';
import {
  CLIP_AFTERMATH_MS, CLIP_COOLDOWN_MS, ClipRing, boundTail, clipUpload, parsePending, persistNow,
  remoteCrashClip, removeKey, splitChunks, uploadPending, type PendingUpload,
} from './crash.js';
import { deliverNativeCrash, serialiseRing, type NativeCrashSource } from './native-crash.js';
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
  /**
   * The app's id and version as read from the app, for an `init` that named
   * neither (see app-identity.ts). Read by `init`, not by the recorder.
   */
  appIdentity?(): DetectedIdentity | undefined;
  /**
   * The package's native module, which writes down crashes in the app's own
   * native code for the next launch (native-crash.ts). Missing in Expo Go and
   * in an app built before the package was added: then there are none.
   */
  nativeCrash?: NativeCrashSource;
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

  /**
   * Crash clip mode: the visitor is sampled out, has consented, and the
   * project wants crash clips. The screen is read into this ring instead of
   * a transport, and nothing leaves the device unless the app crashes; see
   * crash.ts.
   */
  let clip: ClipRing | null = null;
  /** A clip being finished: what it holds so far, while the aftermath is recorded. */
  let aftermath: { sessionId: string; events: RecordedEvent[]; persisted: boolean } | null = null;
  let clipTimer: unknown = null;
  /** When this visitor's last clip was made (also in the store, for the next launch). */
  let lastClipAt = 0;
  const clipping = (): boolean => status === 'sampled-out' && clip !== null;

  /**
   * Traits for the current session that wait for its first accepted chunk.
   *
   * Ingest attaches traits to a session that exists and answers `202
   * { applied: false }` to one that does not (contract §8.2). `identify` on
   * the line after `init` — the usual place, after a stored login is read —
   * went out before the first chunk had made the session, nothing sent it
   * again, and the session was never linked to anyone (found by the Flutter
   * SDK's device test). The traits now wait for the first chunk ingest
   * accepts; after that, `identify` goes straight out. Reset with every
   * session, so the session after a long absence waits for its own.
   */
  let traitsAwaitingSession: IdentifyTraits | undefined;
  /** Traits ingest answered `applied: false` to: tried once more after the next accepted chunk. */
  let traitsToRetry: IdentifyTraits | undefined;
  /** Whether a chunk of the current session has been accepted, so the session exists. */
  let sessionDelivered = false;

  const postIdentity = (who: Identity, traits: IdentifyTraits, retryIfUnapplied: boolean): void => {
    void host.fetch(`${options.ingestUrl}/v1/ingest/identify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectKey: options.projectKey, sessionId: who.sessionId, ...traits,
        ...(options.appId ? { appId: options.appId } : {}),
      }),
    }).then(async (response) => {
      if (!retryIfUnapplied || response.status !== 202) return;
      const reply = await response.json() as { applied?: unknown };
      // The row was not there after all (a server that lost a race): one more
      // try after the next accepted chunk — unless newer traits have been
      // given since, or the session has changed.
      if (reply.applied === false && identity === who && !traitsAwaitingSession && !traitsToRetry) {
        traitsToRetry = traits;
      }
    }).catch(() => { /* identity is best-effort and never surfaces to the app */ });
  };

  const sendIdentity = (who: Identity, traits: IdentifyTraits): void => {
    traitsToRetry = undefined;
    if (!sessionDelivered) {
      // Two calls before the session exists send what both said, once.
      traitsAwaitingSession = { ...traitsAwaitingSession, ...traits };
      return;
    }
    postIdentity(who, traits, true);
  };

  /** A chunk of the current session was accepted: it exists, and what waited for it goes. */
  const noteDelivered = (): void => {
    if (!identity) return;
    sessionDelivered = true;
    const waiting = traitsAwaitingSession;
    const retry = traitsToRetry;
    traitsAwaitingSession = undefined;
    traitsToRetry = undefined;
    if (waiting) postIdentity(identity, waiting, true);
    else if (retry) postIdentity(identity, retry, false);
  };

  const emit = (event: RecordedEvent): void => {
    if (clipping()) {
      clip!.push(event);
      aftermath?.events.push(event);
      return;
    }
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
    if (status === 'sampled-out' && clipping()) {
      emit({ type: EVENT.custom, timestamp: host.now(), data: { tag, payload } });
      return;
    }
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
    if (status !== 'recording' && !clipping()) return;

    // A crash clip is kept in segments that each open with a whole screen,
    // so the oldest can be dropped without breaking what follows it.
    if (clip && clipping() && clip.needsSegment(host.now())) {
      // The segment that just ended is complete: the ring as it stands goes
      // to the store, for a launch that ends in a native crash.
      if (clip.segmentCount > 0) persistRing();
      clip.startSegment(host.now());
      resync = true;
    }

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

  /**
   * Writes the clip's ring to the store, for the next launch to send if this
   * one ends in a native crash, which no JavaScript survives (native-crash.ts).
   * Only with the native module: without it there is nothing to say a crash
   * happened. A ring over the cap is not kept, and an older one goes with it,
   * so a stale ring is never sent with a later crash.
   */
  const persistRing = (): void => {
    if (!host.nativeCrash || !clip) return;
    const text = serialiseRing(clip.events(), describeSession(), host.now());
    if (text) void store.setItem(CLIP_RING_KEY, text).catch(() => {});
    else void removeKey(store, CLIP_RING_KEY).catch(() => {});
  };

  /** Forgets the last launch's native crash and stops writing new ones down: a refusal, or `stop()`. */
  const dropNativeCrashes = (): void => {
    try {
      void host.nativeCrash?.take().catch(() => null);
      host.nativeCrash?.uninstall?.();
    } catch { /* never surfaces to the app */ }
  };

  const halt = (): void => {
    if (clipTimer !== null) { host.clearInterval(clipTimer); clipTimer = null; }
    clip = null;
    aftermath = null;
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
    sessionDelivered = false;
    traitsAwaitingSession = undefined;
    traitsToRetry = undefined;
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
        onSent: () => {
          if (channel === transport) noteDelivered();
        },
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

    sessionMeta = describeSession();
    channel.setMeta(sessionMeta);
    channel.mergeFlags({ pageCount: screenCount });

    // A Meta event first, so the player knows the canvas it is drawing on
    // before it receives anything to draw; then the screen, when the app has
    // named it already — the navigation binding often does before consent.
    emitSize(screenSize());
    if (currentScreen) emit({ type: EVENT.meta, timestamp: host.now(), data: { href: currentScreen } });
    previous = null;
    resync = false;
  };

  /** What a session's first chunk tells ingest about the device, the app and the screen it starts on. */
  const describeSession = (): SessionMeta => {
    const device = host.platform();
    const size = screenSize();
    return {
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
  };

  const ingestTarget = { ingestUrl: options.ingestUrl, projectKey: options.projectKey, now: () => host.now() };

  /** Sends a stored upload and removes it from the store once ingest has answered for good. */
  const sendStored = (key: string, upload: PendingUpload): void => {
    void uploadPending(host.fetch, ingestTarget, upload)
      .then((result) => (result === 'done' ? removeKey(store, key) : undefined))
      .catch(() => { /* kept for the next launch */ });
  };

  /**
   * What a crash on an earlier launch left in the store goes first: the
   * unsent tail of its recording, under its own session id and chunk
   * numbers (ingest takes any number), and a crash clip the process died
   * before sending. When this launch resumes that same session, its
   * numbering moves past the stored chunks so the two never collide.
   */
  const sendStoredCrashes = async (who: Identity): Promise<Identity> => {
    let next = who;
    for (const key of [CRASH_RECORDING_KEY, NATIVE_CRASH_KEY, CRASH_CLIP_KEY]) {
      let raw: string | null = null;
      try { raw = await store.getItem(key); } catch { continue; }
      if (!raw) continue;
      const upload = parsePending(raw);
      if (!upload) {
        void removeKey(store, key).catch(() => {});
        continue;
      }
      if (key !== CRASH_CLIP_KEY && upload.sessionId === who.sessionId) {
        const after = Math.max(...upload.chunks.map((c) => c.seq)) + 1;
        if (after > next.nextSeq) {
          next = { ...next, nextSeq: after };
          void reserveSeq(store, after).catch(() => {});
        }
      }
      sendStored(key, upload);
    }
    return next;
  };

  /**
   * The app is crashing (React Native's fatal handler, before the app's own
   * handler tears the process down). Writes down what would be lost.
   */
  const onFatal = (): void => {
    if (status === 'recording' && transport && identity) {
      const tail = transport.tail();
      if (!tail) return;
      const groups = splitChunks(boundTail(tail.events), options.maxEventsPerChunk);
      if (groups.length === 0) return;
      const upload: PendingUpload = {
        sessionId: identity.sessionId,
        visitorId: identity.visitorId,
        ...(options.appId ? { appId: options.appId } : {}),
        chunks: groups.map((events, i) => ({
          seq: tail.seq + i,
          events,
          ...(i === 0 && tail.meta ? { meta: tail.meta } : {}),
          flags: { ...tail.flags, hasError: true },
        })),
      };
      persistNow(store, CRASH_RECORDING_KEY, JSON.stringify(upload));
      // And try now: in development the red screen keeps the process alive.
      // Sent twice, the same numbers are answered as duplicates.
      void transport.flush({ force: true }).catch(() => {});
      return;
    }
    if (clipping()) triggerClip(true);
  };

  /**
   * Makes a crash clip of what the ring holds, keeps recording for the
   * aftermath, then sends it as a new session. With `persist`, it is also
   * written to the store first, for the next launch to send if this process
   * does not live to.
   */
  const triggerClip = (persist: boolean): void => {
    const now = host.now();
    if (!clip || !identity || aftermath || (lastClipAt > 0 && now - lastClipAt < CLIP_COOLDOWN_MS)) return;
    const events = clip.events();
    if (events.length === 0) return;
    lastClipAt = now;
    persistNow(store, CLIP_AT_KEY, String(now));
    const ids = { sessionId: uuidv4(), visitorId: identity.visitorId, ...(options.appId ? { appId: options.appId } : {}) };
    const meta = describeSession();
    if (persist) {
      const first = clipUpload(events, ids, meta, options.maxEventsPerChunk);
      if (first) persistNow(store, CRASH_CLIP_KEY, JSON.stringify(first));
    }
    aftermath = { sessionId: ids.sessionId, events: [...events], persisted: persist };
    clipTimer = host.setInterval(() => {
      if (clipTimer !== null) { host.clearInterval(clipTimer); clipTimer = null; }
      const done = aftermath;
      aftermath = null;
      if (!done || done.sessionId !== ids.sessionId) return;
      const upload = clipUpload(done.events, ids, meta, options.maxEventsPerChunk);
      if (!upload) return;
      void uploadPending(host.fetch, ingestTarget, upload).then(async (result) => {
        // This one is in, so the copy kept for the next launch goes — unless
        // a refusal has removed it, and everything else, already.
        if (result === 'done' && done.persisted) await removeKey(store, CRASH_CLIP_KEY);
      }).catch(() => {});
    }, CLIP_AFTERMATH_MS);
  };

  /**
   * A sampled-out visitor who has consented: start keeping a crash clip,
   * when the app's option or, failing that, the project's setting says so.
   */
  const startClipMode = async (epoch: number): Promise<void> => {
    if (options.crashClip === false || !options.recordErrors) return;
    const enabled = options.crashClip === true || await remoteCrashClip(
      store, host.fetch, { ...ingestTarget, ...(options.appId ? { appId: options.appId } : {}) }, CONFIG_KEY, host.now(),
    ).catch(() => false);
    if (!enabled || refusals !== epoch || status !== 'sampled-out' || clip) return;
    const stored = Number(await store.getItem(CLIP_AT_KEY).catch(() => null));
    if (refusals !== epoch || status !== 'sampled-out' || clip) return;
    lastClipAt = Number.isFinite(stored) && stored > 0 ? stored : 0;
    clip = new ClipRing();
    previous = null;
    lastSize = null;
    diagnostics = startDiagnostics({
      errors: options.recordErrors,
      // A console line is not what a clip is for; only the crash and the errors before it.
      console: false,
      emit: emitCustom,
      onError: () => {},
      onFatal,
    });
    tick();
    ticker = host.setInterval(tick, options.snapshotIntervalMs);
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
      // A crash in the app's native code last time goes into the recording it
      // happened in — read from the store before resolving the identity, which
      // replaces a session that has gone idle (native-crash.ts).
      try { host.nativeCrash?.install?.(); } catch { /* never surfaces to the app */ }
      await deliverNativeCrash({
        source: host.nativeCrash,
        store,
        fetch: host.fetch,
        ingestUrl: options.ingestUrl,
        projectKey: options.projectKey,
        appId: options.appId,
        recordErrors: options.recordErrors,
        crashClip: options.crashClip,
        maxEventsPerChunk: options.maxEventsPerChunk,
        now: () => host.now(),
        stillAllowed: () => refusals === epoch && status !== 'stopped',
        debug: options.debug,
      }).catch(() => { /* never surfaces to the app */ });
      if (refusals !== epoch || !mayStart()) {
        if (refusals !== epoch || status === 'stopped') await forgetVisitor(store);
        return;
      }
      const who = await resolveIdentity(store, host.now());
      if (refusals !== epoch || !mayStart()) {
        // Refused, or stopped, while the store was answering. The id it just
        // wrote is one the refusal meant to remove.
        if (refusals !== epoch || status === 'stopped') await forgetVisitor(store);
        return;
      }
      identity = who;
      // What a crash on an earlier launch left behind goes before anything new.
      const resumed = await sendStoredCrashes(who).catch(() => who);
      if (refusals !== epoch || !mayStart()) {
        if (refusals !== epoch || status === 'stopped') await forgetVisitor(store);
        return;
      }
      identity = resumed;

      if (!isSampledIn(who.visitorId, options.sampleRate)) {
        status = 'sampled-out';
        void startClipMode(epoch).catch(() => { /* never surfaces to the app */ });
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
      openSession(resumed);

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
        onFatal,
      });

      tick();
      drainPending();
      ticker = host.setInterval(tick, options.snapshotIntervalMs);
      flusher = host.setInterval(() => { void transport?.flush(); }, options.flushIntervalMs);
      if (pendingTraits) {
        sendIdentity(resumed, pendingTraits);
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
      traitsAwaitingSession = undefined;
      traitsToRetry = undefined;
      knownTraits = undefined;
      // What was tagged while asking belongs to the answer that was refused.
      pending.length = 0;
      dropNativeCrashes();
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
      if (clipping()) {
        previous = null;
        emit({ type: EVENT.meta, timestamp: host.now(), data: { href: currentScreen } });
        return;
      }
      if (status !== 'recording') return;
      previous = null;
      transport?.mergeFlags({ pageCount: screenCount });
      emit({ type: EVENT.meta, timestamp: host.now(), data: { href: currentScreen } });
    },

    touch: (x, y) => {
      if (status !== 'recording' && !clipping()) return;
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
      if (near.length >= RAGE_COUNT && !clipping()) transport?.mergeFlags({ hasRageClick: true });
    },

    foreground: () => {
      if (clipping()) { previous = null; return; }
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
      try { host.nativeCrash?.uninstall?.(); } catch { /* never surfaces to the app */ }
      void removeKey(store, CLIP_RING_KEY).catch(() => {});
      // Stopped before it ever started: a later consent(true) must not start
      // what the app has already said it does not want.
      if (mayStart()) status = 'stopped';
      pendingTraits = undefined;
    },
    flush: (flushOptions) => transport?.flush(flushOptions) ?? Promise.resolve(),
  };
}
