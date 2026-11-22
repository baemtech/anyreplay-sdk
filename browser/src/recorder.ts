import { record } from 'rrweb';
import { ASSET_TAG, AssetCollector, localAssetPrefix } from './assets.js';
import {
  CLIP_AFTERMATH_MS, CLIP_CHECKOUT_MS, CLIP_SENT_KEY, CONFIG_KEY, ClipBuffer, clipInCooldown, loadProjectConfig, noteClipSent,
} from './clip.js';
import type { AnyReplayOptions, ResolvedOptions } from './config.js';
import { resolveOptions } from './config.js';
import { ERROR_TAG, errorPayload, startDiagnostics, type DiagnosticsHandle } from './diagnostics.js';
import { NAVIGATE_TAG, TRACK_TAG, validateTrack } from './events.js';
import { LAYOUT_TAG, addClickOffset, watchLayout, type LayoutWatch } from './layout.js';
import { MASK_EVERY_FIELD, MASK_SENSITIVE_FIELDS, scrubEvent, type MaskingPolicy } from './masking.js';
import { isSampledIn } from './sampling.js';
import { Transport, type RecordedEvent, type SessionMeta } from './transport.js';
import { PLATFORM, SDK_NAME, SDK_VERSION } from './version.js';
import {
  forgetVisitor, inCooldown, notePageCount, resolveIdentity, reserveSeq, safeStorage, startCooldown, touchSession,
  uuidv4, type Identity,
} from './visitor.js';

/**
 * What an SDK that wraps this one says about the app the page runs in.
 *
 * Not an option: a website never has one. `@anyreplay/capacitor`,
 * `@anyreplay/cordova` and the desktop shells pass it as `createRecorder`'s
 * second argument, so a session names the SDK that was installed and the
 * platform it runs on (contract §2.3–§2.5) while the recording itself — rrweb,
 * masking, transport — stays this package's, unchanged (contract §4).
 */
export interface ShellInfo {
  /** One of the web family's platforms: `capacitor`, `cordova`, `electron`, `tauri`. */
  platform: string;
  /** The wrapper's own npm name and version. */
  sdk: { name: string; version: string };
  /** The app's user-visible version (`CFBundleShortVersionString`, `versionName`), ≤ 40. */
  appVersion?: string;
  /** The hardware model (`iPhone15,2`, `Pixel 8`), ≤ 64. */
  deviceModel?: string;
  /**
   * Called the moment a chunk number is reserved, before the request that
   * uses it leaves. A shell that copies the recorder's keys into native
   * storage copies them then: an app killed between a send and the shell's
   * next periodic copy came back with the old number, and sent its first
   * chunk under a number the server already held (seen on an iOS simulator).
   */
  onStateChanged?: () => void;
  /**
   * Crash clip mode only: called with what the ring holds each time a
   * segment is complete (at every snapshot after the first, about every ten
   * seconds), and with `null` when clip mode ends (`stop()`, a refusal). A
   * shell keeps it natively, so a launch that ends in a native crash — which
   * the page does not survive — can still send the clip on the next one
   * (contract §8.6). Never called for a recorded visitor.
   */
  onClipRing?: (ring: ClipRing | null) => void;
}

/** What a crash clip's ring holds, as `ShellInfo.onClipRing` hands it over. */
export interface ClipRing {
  /** Oldest first, starting with a Meta and a full snapshot. */
  events: RecordedEvent[];
  /** The session meta a clip of it would carry (no `sessionCap`; `kind` and `startedAt` are the sender's). */
  meta: SessionMeta;
}

export type RecorderStatus = 'idle' | 'awaiting-consent' | 'recording' | 'sampled-out' | 'stopped';

/** The second argument of `trackError`. */
export interface TrackErrorOptions {
  /**
   * The app is about to go down over this error — its own crash handler saw
   * it, or it cannot continue. Recorded as `kind: 'fatal'`, which is what
   * makes a session count as crashed (contract §8.3). On a visitor who is not
   * recorded, it is also what cuts a crash clip (§8.6).
   */
  fatal?: boolean;
  /**
   * `false` records a fatal error without cutting a crash clip for it: for a
   * crash that happened in an earlier run and is only being reported now
   * (`@anyreplay/electron` does this), whose moment the clip cannot hold.
   */
  clip?: boolean;
}

/** Clip mode, while it runs. */
interface ClipState {
  buffer: ClipBuffer;
  who: Identity;
  diagnostics: DiagnosticsHandle | undefined;
  /** Set while the aftermath of a crash is being collected. */
  timer: ReturnType<typeof setTimeout> | undefined;
  stop: () => void;
}

export interface IdentifyTraits {
  userId?: string;
  email?: string;
}

export interface RecorderHandle {
  status: () => RecorderStatus;
  sessionId: () => string | null;
  consent: (granted: boolean) => void;
  identify: (traits: IdentifyTraits) => void;
  /**
   * Tags this moment of the recording so it shows on the player's timeline.
   *
   * `name` is 1–64 characters of `[A-Za-z0-9_.:-]`; `properties` must be a
   * plain JSON object of at most 4 KB. Anything else is dropped with a warning
   * in debug mode — never an exception, since this runs inside the page's
   * own handlers.
   */
  track: (name: string, properties?: Record<string, unknown>) => void;
  /**
   * Records an error the page caught itself — a failed checkout handled with a
   * message, an error another tracker saw first — as the same `anyreplay.error`
   * event an uncaught one becomes: redacted by the same rules, counted against
   * the same ceiling, and setting the session's `hasError`. Accepts anything
   * that can be thrown. Ignored with `recordErrors: false`. Before recording
   * starts it is held like `track` and still flags the session once it does.
   *
   * `{ fatal: true }` says the app is going down over it (`kind: 'fatal'`):
   * the session is marked as crashed, what it has recorded is sent at once,
   * and a visitor who is not recorded gets a crash clip when the project has
   * them on. See `TrackErrorOptions`.
   */
  trackError: (error: unknown, options?: TrackErrorOptions) => void;
  stop: () => void;
  flush: () => Promise<void>;
}

/** Rage click: several clicks in nearly the same spot in quick succession. */
/** rrweb's `EventType.DomContentLoaded` and `EventType.Load`: page milestones with no data. */
const RRWEB_DOM_CONTENT_LOADED = 0;
const RRWEB_LOAD = 1;
/** rrweb's `EventType.FullSnapshot` and `EventType.Meta`. */
const EVENT_FULL_SNAPSHOT = 2;
const EVENT_META = 4;

const RAGE_CLICK_COUNT = 3;
const RAGE_CLICK_WINDOW_MS = 1000;
const RAGE_CLICK_RADIUS_PX = 30;

/**
 * Events tracked before rrweb is emitting — while consent is pending, or
 * while the document is still loading — wait here. Enough for an app's boot
 * sequence; a page that tracks more than this before anything is recorded is
 * looping, and keeping the oldest ones tells the story better than the newest.
 */
const MAX_PENDING_EVENTS = 32;

/**
 * Everywhere a person can type that is not a form control.
 *
 * A `contenteditable` element's text is page text, not an input value, so
 * input masking never sees it — which is why `maskAllTyping` exists and why it
 * is expressed as a text selector. `contenteditable="false"` is how a page
 * marks a part of an editor that cannot be edited (a mention chip, an embed),
 * so it is not itself a reason to mask; text inside it is still masked when an
 * editable ancestor is, which is the safe way round.
 */
const EDITABLE_SELECTOR = '[contenteditable]:not([contenteditable="false"])';

export function createRecorder(rawOptions: AnyReplayOptions, shell?: ShellInfo): RecorderHandle {
  const options: ResolvedOptions = resolveOptions(rawOptions);
  /**
   * Whether this page leaves `maskAllInputs` to the project.
   *
   * A snippet that sets it — `true` or `false`, a real boolean — has decided,
   * and nothing ingest says changes that. One that does not records masked,
   * the default, until ingest answers the first chunk with what the project
   * stored (`maskAllInputs` in the 202, contract §6.2). A project that chose
   * to record typed text — every site installed before inputs were masked by
   * default, whose snippet never needed to say so — gets it back from then
   * on. No answer (an error, a timeout, an older ingest) leaves it masked.
   * `maskAllTyping` masks fields whatever either says, so with it on there is
   * nothing to wait for.
   */
  let awaitingProjectMasking = typeof rawOptions.maskAllInputs !== 'boolean' && !options.maskAllTyping;

  const local = safeStorage(() => globalThis.localStorage);
  const session = safeStorage(() => globalThis.sessionStorage);

  let status: RecorderStatus = 'idle';
  /**
   * Who this is, and the channel to ingest. Neither exists until the recorder
   * is allowed to record — see `begin`. With `requireConsent` that is the
   * moment `consent(true)` is called; otherwise it is right now.
   */
  let identity: Identity | undefined;
  let transport: Transport | undefined;
  let stopRecording: (() => void) | undefined;
  /** Patched globals wait here to be put back; see `diagnostics.ts`. */
  let diagnostics: DiagnosticsHandle | undefined;
  /** With `assets: 'inline'`: makes the app's own files part of the recording. */
  let assets: AssetCollector | undefined;
  /** Sends the page's size when it changes, for scroll maps (contract §4.2). */
  let layout: LayoutWatch | undefined;
  let pageCount = 0;
  /** Set in `begin` once there is something to apply the project's masking choice to. */
  let applyProjectMasking: (from: Transport, masked: boolean) => void = () => {};
  /**
   * Traits given to `identify` before there was a session to attach them to.
   * Held in memory only, and sent the moment recording starts — so
   * `consent(true)` followed by `identify` on the next line works, and an
   * identity never leaves the page for a visitor who has not agreed.
   */
  let pendingTraits: IdentifyTraits | undefined;

  /**
   * Traits for the current session that wait for its first accepted chunk.
   *
   * Ingest attaches traits to a session that exists and answers `202
   * { applied: false }` to one that does not (contract §8.2). `identify` on
   * the line after `init` — the usual place, after a login on page load — went
   * out before the first chunk had made the session, nothing sent it again,
   * and the session was never linked to anyone (found by the Flutter SDK's
   * device test). The traits now wait for the first chunk ingest accepts;
   * after that, `identify` goes straight out.
   */
  let traitsAwaitingSession: IdentifyTraits | undefined;
  /** Traits ingest answered `applied: false` to: tried once more after the next accepted chunk. */
  let traitsToRetry: IdentifyTraits | undefined;
  /** Whether a chunk of the current session has been accepted, so the session exists. */
  let sessionDelivered = false;

  /**
   * Clip mode (contract §8.6): rrweb and diagnostics running for a visitor who
   * is not recorded, into a ring in memory instead of a transport. Undefined
   * when the visitor is recorded, the project has clips off, or nothing has
   * been allowed to start.
   */
  let clip: ClipState | undefined;
  /** The clip on its way to ingest, so a refusal of consent can stop it too. */
  let clipChannel: Transport | undefined;
  /** Bumped by `stop()` and a refusal, so a clip whose config arrives after either never starts. */
  let clipGeneration = 0;

  const postIdentity = (who: Identity, traits: IdentifyTraits, retryIfUnapplied: boolean): void => {
    void fetch(`${options.ingestUrl}/v1/ingest/identify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'omit',
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
    }).catch(() => { /* identity is best-effort; never surface to the page */ });
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

  /** A chunk of `channel` was accepted: the session exists, and what waited for it goes. */
  const noteDelivered = (channel: Transport): void => {
    if (channel !== transport || !identity) return;
    sessionDelivered = true;
    const waiting = traitsAwaitingSession;
    const retry = traitsToRetry;
    traitsAwaitingSession = undefined;
    traitsToRetry = undefined;
    if (waiting) postIdentity(identity, waiting, true);
    else if (retry) postIdentity(identity, retry, false);
  };

  const collectMeta = (who: Identity): SessionMeta => ({
    startedAt: Date.now(),
    url: safeLocation(),
    lang: typeof navigator !== 'undefined' ? navigator.language : undefined,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    screenWidth: typeof window !== 'undefined' ? window.innerWidth : undefined,
    screenHeight: typeof window !== 'undefined' ? window.innerHeight : undefined,
    referrer: typeof document !== 'undefined' ? document.referrer || undefined : undefined,
    platform: shell?.platform ?? PLATFORM,
    sdk: shell?.sdk ?? { name: SDK_NAME, version: SDK_VERSION },
    ...(shell?.appVersion ? { appVersion: shell.appVersion.slice(0, 40) } : {}),
    ...(shell?.deviceModel ? { deviceModel: shell.deviceModel.slice(0, 64) } : {}),
    // The cap is a decision about starting a session, so it goes only where
    // ingest makes that decision: chunk 0. A resumed page starts later.
    ...(options.maxSessionsPerMonth !== undefined && who.nextSeq === 0
      ? { sessionCap: options.maxSessionsPerMonth }
      : {}),
  });

  const recentClicks: { x: number; y: number; t: number }[] = [];

  const noteInteraction = (event: RecordedEvent, channel: Transport): void => {
    // rrweb IncrementalSnapshot(3) with MouseInteraction(2) source carries clicks,
    // but it also carries the mousedown and mouseup around each of them — one
    // ordinary click is three interactions, which is exactly RAGE_CLICK_COUNT,
    // and every session with a single click was being flagged as rage. Only
    // the Click itself (interaction type 2) is a click. A tap on a phone
    // fires one as well, so touch devices are still counted.
    const data = event.data as { source?: number; type?: number; x?: number; y?: number } | undefined;
    if (event.type !== 3 || data?.source !== 2 || data.type !== 2 || typeof data.x !== 'number') return;

    const now = event.timestamp;
    recentClicks.push({ x: data.x, y: data.y ?? 0, t: now });
    while (recentClicks.length > 0 && now - recentClicks[0]!.t > RAGE_CLICK_WINDOW_MS) recentClicks.shift();

    // Counted around the click that just landed, not around the oldest one in
    // the window: a single click somewhere else a moment earlier must not hide
    // the burst that follows it on the button that is not answering.
    const near = recentClicks.filter(
      (c) => Math.abs(c.x - data.x!) < RAGE_CLICK_RADIUS_PX && Math.abs(c.y - (data.y ?? 0)) < RAGE_CLICK_RADIUS_PX,
    );
    if (near.length >= RAGE_CLICK_COUNT) channel.mergeFlags({ hasRageClick: true });
  };

  /* ----------------------------- custom events ---------------------------- */

  const pending: { tag: string; payload: unknown }[] = [];
  let draining = false;
  let drainScheduled = false;

  /**
   * Hands the queue of waiting events to rrweb, in order.
   *
   * `addCustomEvent` throws until rrweb has finished its first snapshot,
   * which it takes on `load` when the recorder starts in a still-loading
   * document — and it flips to accepting only after the snapshot's own
   * events have been emitted, so draining from inside `emit` can be refused
   * too. A refusal is retried on the next event and, in case no event comes,
   * on a timer. A queued event is stamped with the time it is handed over,
   * not the time `track` was called: a marker a few hundred milliseconds late
   * is still on the timeline, and one dated before the snapshot is not.
   */
  const drainPending = (): void => {
    if (draining || pending.length === 0) return;
    draining = true;
    try {
      while (pending.length > 0) {
        const next = pending[0]!;
        record.addCustomEvent(next.tag, next.payload);
        pending.shift();
        // An error held from before recording started flags the session as
        // one caught now would (contract §3.5, §8.3).
        if (next.tag === ERROR_TAG) transport?.mergeFlags({ hasError: true });
      }
    } catch {
      if (!drainScheduled && status === 'recording') {
        drainScheduled = true;
        setTimeout(() => { drainScheduled = false; drainPending(); }, 50);
      }
    } finally {
      draining = false;
    }
  };

  /**
   * The queue lives in memory only. An event tracked while consent is
   * pending must not leave a trace anywhere a refusal would have to clean up.
   */
  const emitCustom = (tag: string, payload: unknown): void => {
    if (status === 'sampled-out') {
      // Into the clip's ring, when there is one; nowhere otherwise.
      if (clip) {
        try { record.addCustomEvent(tag, payload); } catch { /* not emitting yet */ }
      }
      return;
    }
    if (status === 'stopped') return;
    if (status === 'recording') {
      try {
        record.addCustomEvent(tag, payload);
        return;
      } catch {
        /* not emitting yet — queue it */
      }
    }
    if (pending.length >= MAX_PENDING_EVENTS) {
      if (options.debug) console.warn(`[anyreplay] dropped ${tag}: too many events before recording started`);
      return;
    }
    pending.push({ tag, payload });
  };

  /**
   * Starts rrweb under `policy`, for a recording or a crash clip alike — the
   * same masking, the same scrubbing, so a clip contains nothing a recording
   * of the same visitor would not. Returns rrweb's stop function, or nothing
   * when it would not start.
   */
  const startRrweb = (
    policy: MaskingPolicy,
    onEvent: (event: RecordedEvent) => void,
    checkoutEveryNms?: number,
  ): (() => void) | undefined => record({
    emit: (event) => {
      const typed = event as unknown as RecordedEvent;
      // Started before the page finished loading, rrweb announces
      // DOMContentLoaded (0) and load (1) as events of their own. They carry
      // nothing a replay uses, and they would open the recording ahead of
      // its Meta (contract §5.1, SEQ-002).
      if (typed.type === RRWEB_DOM_CONTENT_LOADED || typed.type === RRWEB_LOAD) return;
      // Before anything else touches the event: rrweb's own masking is
      // all-or-nothing by input type, so the floor — payment fields, marked
      // fields, anything shaped like a card number — is applied here, to the
      // event, with the node resolved through rrweb's mirror.
      scrubEvent(typed, (id) => record.mirror.getNode(id) as never, policy);
      // Where inside its element a click landed: read now, while rrweb is
      // still inside the click's own listener and the box is where it was.
      addClickOffset(typed, (id) => record.mirror.getNode(id));
      onEvent(typed);
    },
    maskInputOptions: (policy.maskEveryField
      ? MASK_EVERY_FIELD
      : MASK_SENSITIVE_FIELDS) as NonNullable<Parameters<typeof record>[0]>['maskInputOptions'],
    maskTextClass: options.maskClass,
    maskTextSelector: options.maskAllTyping ? EDITABLE_SELECTOR : undefined,
    blockClass: options.blockClass,
    // Readable stylesheets go into the snapshot as text, in both asset
    // modes. rrweb's default, written out because 'inline' depends on it.
    inlineStylesheet: true,
    // Canvas capture is expensive and off unless a customer opts in later.
    recordCanvas: false,
    collectFonts: false,
    ...(checkoutEveryNms ? { checkoutEveryNms } : {}),
  });

  /** The masking a recording of this page starts with; see `begin`. */
  const initialPolicy = (): MaskingPolicy => ({
    maskEveryField: options.maskAllInputs || options.maskAllTyping,
    maskClass: options.maskClass,
  });

  /* ------------------------------ crash clips ----------------------------- */

  /**
   * Clip mode for a visitor sampling left out (contract §8.6).
   *
   * Asks the project first unless the page decided (`crashClip`), and only
   * here: a recorded visitor has no use for a clip, so it never asks. The
   * same answer carries the project's masking choice, which a clip needs up
   * front — nothing is sent before the crash for a 202 to bring it back.
   */
  const startClip = async (who: Identity): Promise<void> => {
    if (options.crashClip === false || typeof window === 'undefined') return;
    const generation = clipGeneration;
    const config = options.crashClip === undefined || awaitingProjectMasking
      ? await loadProjectConfig(options, local)
      : undefined;
    // Refused, stopped or started again while the answer was on its way.
    if (generation !== clipGeneration || status !== 'sampled-out' || identity !== who || clip) return;
    if (!(options.crashClip ?? config?.crashClip ?? false)) return;

    const policy = initialPolicy();
    // Fail closed: only an answer that says so records typed text.
    if (awaitingProjectMasking && config?.maskAllInputs === false) policy.maskEveryField = false;

    const buffer = new ClipBuffer(undefined, () => setTimeout(() => {
      try { record.takeFullSnapshot(true); } catch { /* the next checkout comes anyway */ }
    }, 0));
    const keepRing = shell?.onClipRing;
    let stopRrweb: (() => void) | undefined;
    try {
      stopRrweb = startRrweb(policy, (event) => {
        // A Meta opens the next segment, so the ring as it stands is complete.
        if (keepRing && event.type === EVENT_META && buffer.size > 0) {
          const events = buffer.events();
          if (events.length > 0) {
            const { sessionCap: _cap, ...meta } = collectMeta(who);
            try { keepRing({ events, meta }); } catch { /* the shell's problem, never the page's */ }
          }
        }
        buffer.push(event, Date.now());
      }, CLIP_CHECKOUT_MS);
    } catch {
      stopRrweb = undefined;
    }
    if (!stopRrweb) return;

    const onHide = (): void => sendClip(true);
    const state: ClipState = {
      buffer,
      who,
      diagnostics: undefined,
      timer: undefined,
      stop: () => {
        if (state.timer) clearTimeout(state.timer);
        state.timer = undefined;
        state.diagnostics?.stop();
        stopRrweb?.();
        buffer.clear();
        window.removeEventListener('pagehide', onHide, { capture: true });
      },
    };
    clip = state;
    // An uncaught error is the web's crash: a page does not go down, but this
    // is the moment someone opens a replay for.
    state.diagnostics = startDiagnostics({
      errors: options.recordErrors,
      console: options.recordConsole,
      network: options.recordNetwork,
      ingestUrl: options.ingestUrl,
      emit: emitCustom,
      onError: () => {},
      onUncaught: () => cutClip(),
    });
    window.addEventListener('pagehide', onHide, { capture: true });
  };

  /**
   * Something broke: keep collecting for `CLIP_AFTERMATH_MS`, then send. At
   * most one clip per visitor every five minutes, counted from here.
   */
  const cutClip = (): void => {
    if (!clip || clip.timer || clipInCooldown(local)) return;
    noteClipSent(local);
    clip.timer = setTimeout(() => sendClip(false), CLIP_AFTERMATH_MS);
  };

  /**
   * Sends the ring as a session of its own: a fresh id that no page of the
   * visitor's ever uses, numbered from 0, `meta.kind: 'crash_clip'`, and
   * `startedAt` the first kept event. Clip mode then carries on into an
   * empty ring, for a crash after the cool-down. `final` is `pagehide`, where
   * only a beacon gets out.
   */
  const sendClip = (final: boolean): void => {
    const current = clip;
    if (!current?.timer) return;
    clearTimeout(current.timer);
    current.timer = undefined;
    const events = current.buffer.take();
    if (events.length === 0) return;

    const channel = new Transport(
      options,
      {
        projectKey: options.projectKey,
        sessionId: uuidv4(),
        visitorId: current.who.visitorId,
        initialSeq: 0,
        bufferLimit: events.length + 64,
      },
      {
        onWarning: (message) => { if (options.debug) console.warn(`[anyreplay] crash clip: ${message}`); },
        // All of it delivered: the clip's channel has nothing more to do.
        onSent: () => { if (channel.bufferedCount === 0) setTimeout(() => channel.stop('clip_sent'), 0); },
      },
    );
    clipChannel = channel;
    // A clip is not a new session against the monthly cap: no `sessionCap`.
    const { sessionCap: _cap, ...meta } = collectMeta(current.who);
    channel.setMeta({ ...meta, startedAt: events[0]!.timestamp, kind: 'crash_clip' });
    channel.mergeFlags({ hasError: true, pageCount: 1 });
    for (const event of events) channel.push(event);
    if (final) {
      channel.flushWithBeacon(true);
      return;
    }
    channel.start();
    void channel.flush(true);
  };

  /** Ends clip mode, and a clip still on its way, for the page. */
  const stopClip = (): void => {
    if (clip) {
      try { shell?.onClipRing?.(null); } catch { /* never into the page */ }
    }
    clipGeneration += 1;
    clip?.stop();
    clip = undefined;
    clipChannel?.stop('stopped');
    clipChannel = undefined;
  };

  /* ------------------------------ navigation ------------------------------ */

  let lastUrl: string | undefined;

  /**
   * A route change in a single-page app is a page view.
   *
   * rrweb records the DOM mutations that come with it, but nothing in the
   * stream says "this is a new page" — so the marker is emitted here, and
   * ingest indexes it for the player. Same-URL changes are ignored: routers
   * call `replaceState` for scroll positions and query tweaks, and each of
   * those is not a page.
   */
  const noteNavigation = (channel: Transport): void => {
    const url = safeLocation();
    if (!url || url === lastUrl) return;
    lastUrl = url;
    pageCount += 1;
    notePageCount(session, pageCount);
    channel.mergeFlags({ pageCount });
    emitCustom(NAVIGATE_TAG, { url, title: typeof document !== 'undefined' ? document.title : '' });
    layout?.navigated();
  };

  /**
   * Everything that leaves a trace happens here, and nothing before it.
   *
   * Resolving the identity writes the visitor id to `localStorage` and the
   * session to `sessionStorage`; opening the transport is what makes a request
   * possible; starting rrweb is what observes the page. With `requireConsent`
   * every one of those waits for `consent(true)`, because storing an
   * identifier on the device is the very thing the consent is for. Nor does
   * the recorder peek at an id an earlier page left behind to decide that
   * consent was already given: the id may predate a refusal — the visitor
   * accepted in May and rejected in June — or have been written by a version
   * of this recorder that stored it without asking. Only the page knows the
   * current answer, and it says so by calling `consent`.
   *
   * Sampling is still decided from the visitor id, so it is still the same
   * answer for the same visitor on every page. What moves is *when* it is
   * decided: a visitor is sampled on first consent rather than on first page
   * view, and a visitor who refuses is forgotten, so a later acceptance is a
   * fresh draw.
   */
  const begin = (): void => {
    if (status !== 'idle' && status !== 'awaiting-consent') return;

    const who = resolveIdentity(local, session);
    identity = who;
    pageCount = who.pageCount;

    if (!isSampledIn(who.visitorId, options.sampleRate)) {
      // Decided from the visitor id, so this answer is stable across pages.
      status = 'sampled-out';
      // Not recorded — but a crash may still be worth half a minute (§8.6).
      startClip(who).catch(() => { /* never into the page */ });
      return;
    }

    if (inCooldown(session)) {
      // The previous page was told this session may not be started. That answer
      // will not have changed a page load later.
      status = 'stopped';
      if (options.debug) console.warn('[anyreplay] not recording: ingest refused a new session recently');
      return;
    }

    const channel = new Transport(
      options,
      {
        projectKey: options.projectKey,
        sessionId: who.sessionId,
        visitorId: who.visitorId,
        initialSeq: who.nextSeq,
      },
      {
        onSent: () => noteDelivered(channel),
        onSeqReserved: (next) => {
          reserveSeq(session, next);
          try { shell?.onStateChanged?.(); } catch { /* the shell's problem, never the recording's */ }
        },
        onStopped: (reason) => {
          status = 'stopped';
          stopRecording?.();
          stopRecording = undefined;
          diagnostics?.stop();
          diagnostics = undefined;
          assets?.stop();
          assets = undefined;
          layout?.stop();
          layout = undefined;
          // Only the verdict about the session itself is remembered across pages.
          // A transport failure or an origin problem is either transient or one
          // request per page load to notice it is fixed; a full quota is neither.
          if (reason === 'rejected_402') startCooldown(session);
          if (options.debug) console.warn(`[anyreplay] recording stopped: ${reason}`);
        },
        onWarning: (message) => {
          if (options.debug) console.warn(`[anyreplay] ${message}`);
        },
        // Out of the transport's own call stack, like a resync: restarting
        // rrweb emits a snapshot into the channel that is answering.
        onProjectMasking: (masked) => setTimeout(() => applyProjectMasking(channel, masked), 0),
        // Events were dropped (a long outage, or one too large to send), so
        // the DOM changes after the gap describe nodes ingest never got. A
        // fresh full snapshot starts the page over. Taken on the next turn,
        // not here: this can be called from inside rrweb's own emit, in the
        // middle of handing over a batch of mutations.
        onResyncNeeded: () => setTimeout(() => takeSnapshot(2), 0),
      },
    );
    transport = channel;
    status = 'recording';

    /** A checkout snapshot (Meta + FullSnapshot), retried briefly if rrweb is not emitting yet. */
    const takeSnapshot = (triesLeft: number): void => {
      if (status !== 'recording' || !stopRecording) return;
      try {
        record.takeFullSnapshot(true);
      } catch {
        if (triesLeft > 0) setTimeout(() => takeSnapshot(triesLeft - 1), 1000);
      }
    };
    // The page the recording starts on is where route changes are counted from.
    lastUrl = safeLocation();

    channel.setMeta(collectMeta(who));
    // The page the recorder starts on is a page view. Without this the
    // counter only ever reflects in-app navigations, so a single-page visit
    // reports zero pages — and on a resumed session it is the previous page's
    // count plus one, so the hop is visible.
    channel.mergeFlags({ pageCount });
    channel.start();

    /**
     * What this recording may contain.
     *
     * `maskAllTyping` is the stricter of the two options and wins: a page that
     * asked for everything typed to be hidden does not get form fields back
     * because `maskAllInputs: false` is also set. Only with `maskAllInputs:
     * false` and no `maskAllTyping` are values recorded, and then `masking.ts`
     * applies the floor — the fields no option can un-mask.
     */
    const prefix = options.assets === 'inline' ? localAssetPrefix() : null;
    if (prefix && typeof fetch === 'function') {
      assets = new AssetCollector({
        prefix,
        ingestUrl: options.ingestUrl,
        projectKey: options.projectKey,
        appId: options.appId,
        // Bound now, before the network diagnostics wrap `fetch`: reading the
        // app's own files is the recorder's business, not the app's traffic.
        fetch: fetch.bind(globalThis),
        emit: (payload) => emitCustom(ASSET_TAG, payload),
        debug: options.debug,
      });
    }

    const policy: MaskingPolicy = initialPolicy();
    /** Set once the first chunk has been sent early, so the project's answer comes in a round trip. */
    let flushedEarly = false;

    /** Starts rrweb under the current `policy`; returns its stop function. */
    const capture = (): (() => void) | undefined => startRrweb(policy, (typed) => {
      assets?.scan(typed);
      noteInteraction(typed, channel);
      touchSession(session, typed.timestamp);
      channel.push(typed);
      drainPending();
      // A new snapshot is a page the reader starts over on: it gets its size.
      if (typed.type === EVENT_FULL_SNAPSHOT) layout?.force();
      // While the project's masking choice is unknown everything typed is
      // masked, so the first chunk goes as soon as the page's snapshot is in
      // it rather than at the end of the first flush interval: the answer
      // comes back with it. Once per page, on the next turn, so the events
      // emitted alongside the snapshot travel with it.
      if (awaitingProjectMasking && !flushedEarly && typed.type === EVENT_FULL_SNAPSHOT) {
        flushedEarly = true;
        setTimeout(() => { void channel.flush(); }, 0);
      }
    });

    /**
     * Ingest's word on what the project stored, for a page that left
     * `maskAllInputs` to it. The first answer decides for the rest of the
     * page. Masked is what is already running. Recorded means rrweb starts
     * again without input masking: its masking is fixed when it starts, and a
     * restart begins with a fresh full snapshot, so the replay picks up from a
     * consistent page. What was typed before stays masked in the recording.
     */
    applyProjectMasking = (from: Transport, masked: boolean): void => {
      if (!awaitingProjectMasking || from !== transport) return;
      awaitingProjectMasking = false;
      if (masked || status !== 'recording' || !stopRecording) return;
      policy.maskEveryField = false;
      try {
        stopRecording();
        stopRecording = capture();
        // rrweb reports a failure to start by returning nothing.
        if (!stopRecording) throw new Error('rrweb did not start');
      } catch {
        // rrweb would not start again: stop for the page rather than record
        // nothing while claiming to record.
        stopRecording = undefined;
        from.stop('restart_failed');
        return;
      }
      if (options.debug) console.warn('[anyreplay] recording typed text: the project chose to (maskAllInputs: false)');
    };

    stopRecording = capture();
    // The first snapshot may already have gone out inside `capture()`; the
    // page's size follows it on the next turn either way.
    layout = watchLayout((payload) => emitCustom(LAYOUT_TAG, payload));
    layout.force();
    // Every page begins with a full snapshot (rrweb takes one on start), so
    // events tracked before this point land right after it.
    drainPending();
    if (pendingTraits) {
      sendIdentity(who, pendingTraits);
      pendingTraits = undefined;
    }

    attachLifecycleHooks(channel);
  };

  const attachLifecycleHooks = (channel: Transport): void => {
    if (typeof window === 'undefined') return;

    // pagehide is the reliable end-of-page signal; unload does not fire on
    // mobile Safari and beforeunload breaks the back/forward cache.
    window.addEventListener('pagehide', () => { channel.flushWithBeacon(true); }, { capture: true });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') channel.flushWithBeacon();
      // Back on screen: if deliveries were failing, try now rather than at
      // the end of a backoff that may have been running while it was hidden.
      else channel.resume();
    });
    // The connection is back. `online` can fire for a network that still
    // reaches nothing; then the attempt fails and backs off again.
    window.addEventListener('online', () => channel.resume());
    /*
     * Errors, console lines and request metadata.
     *
     * This replaces two bare listeners that set `hasError` and kept nothing
     * else, which is why a replay could say an error happened and never say
     * which. `hasError` is still set — by the first error or failed request
     * either stream sees, through `onError` — so the session list's filter and
     * its partial index are unchanged.
     *
     * Started here rather than in `begin()` so that nothing is patched before
     * consent: `attachLifecycleHooks` runs once recording has actually
     * started, and `stop()` puts every global back.
     */
    diagnostics = startDiagnostics({
      errors: options.recordErrors,
      console: options.recordConsole,
      network: options.recordNetwork,
      ingestUrl: options.ingestUrl,
      emit: emitCustom,
      onError: () => channel.mergeFlags({ hasError: true }),
    });

    // Wrapped after the original runs, so `location` already shows the new URL.
    const patch = (method: 'pushState' | 'replaceState'): void => {
      const original = history[method].bind(history);
      history[method] = function patched(...args: Parameters<History['pushState']>) {
        const result = original(...args);
        noteNavigation(channel);
        return result;
      };
    };
    patch('pushState');
    patch('replaceState');
    window.addEventListener('popstate', () => noteNavigation(channel));
  };

  if (options.requireConsent) {
    status = 'awaiting-consent';
  } else {
    begin();
  }

  return {
    status: () => status,
    sessionId: () => identity?.sessionId ?? null,
    consent: (granted) => {
      if (granted) {
        begin();
        return;
      }
      // A refusal stops this page's recording and undoes what an earlier
      // acceptance stored — on this page or on one last month. Stopping
      // first, so no flush reserves a chunk number after the keys are gone.
      transport?.stop('consent_withdrawn');
      // A clip is a recording too: the ring goes, and so does one on its way.
      stopClip();
      local.remove(CLIP_SENT_KEY);
      local.remove(CONFIG_KEY);
      // Nothing was recording yet (still asking, or asked and sampled out):
      // the refusal is an answer, not a `stop()`. The recorder goes back to
      // waiting, so a visitor who says no and then changes their mind on the
      // same page — the banner's settings link — is recorded from then on, as
      // a new visitor with a fresh sampling draw (contract §3.5). A recording
      // that had started stays stopped for the page (§3.6).
      if (status === 'idle' || status === 'awaiting-consent' || status === 'sampled-out') {
        status = 'awaiting-consent';
        identity = undefined;
      }
      pendingTraits = undefined;
      traitsAwaitingSession = undefined;
      traitsToRetry = undefined;
      // What was tracked while asking belongs to the answer that was refused.
      pending.length = 0;
      forgetVisitor(local, session);
    },
    identify: (traits) => {
      if (!traits.userId && !traits.email) return;
      if (identity && transport) {
        sendIdentity(identity, traits);
        return;
      }
      // No session yet. While consent is pending the traits wait; a visitor
      // who is sampled out or stopped has no session to attach them to.
      if (status === 'idle' || status === 'awaiting-consent') pendingTraits = traits;
      else if (options.debug) console.warn('[anyreplay] identify() ignored: not recording');
    },
    track: (name, properties) => {
      const payload = validateTrack(name, properties);
      if (typeof payload === 'string') {
        if (options.debug) console.warn(`[anyreplay] track() ignored: ${payload}`);
        return;
      }
      emitCustom(TRACK_TAG, payload);
    },
    trackError: (error, how) => {
      if (!options.recordErrors) return;
      const fatal = how?.fatal === true;
      const kind = fatal ? 'fatal' : 'error';
      // While recording, through diagnostics: it owns the ceiling and the flag.
      if (diagnostics) {
        diagnostics.error(error, kind);
        // The app may be about to go: what the session holds leaves now.
        if (fatal) setTimeout(() => { void transport?.flush(true); }, 0);
        return;
      }
      if (clip) {
        clip.diagnostics?.error(error, kind);
        if (fatal && how?.clip !== false) cutClip();
        return;
      }
      emitCustom(ERROR_TAG, errorPayload(kind, error));
      // Recording without diagnostics (no window to patch): flag it here.
      if (status === 'recording') transport?.mergeFlags({ hasError: true });
    },
    stop: () => {
      transport?.stop('stopped_by_page');
      stopClip();
      // Stopped before it ever started: a later consent(true) must not start
      // what the page has already said it does not want.
      if (status === 'idle' || status === 'awaiting-consent') status = 'stopped';
      pendingTraits = undefined;
    },
    // Asked for by the page, so it skips our own backoff (never a server's Retry-After).
    flush: () => transport?.flush(true) ?? Promise.resolve(),
  };
}

function safeLocation(): string | undefined {
  try {
    return typeof location !== 'undefined' ? location.href : undefined;
  } catch {
    return undefined;
  }
}
