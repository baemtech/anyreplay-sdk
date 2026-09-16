import { record } from 'rrweb';
import type { AnyReplayOptions, ResolvedOptions } from './config.js';
import { resolveOptions } from './config.js';
import { NAVIGATE_TAG, TRACK_TAG, validateTrack } from './events.js';
import { isSampledIn } from './sampling.js';
import { Transport, type RecordedEvent, type SessionMeta } from './transport.js';
import {
  forgetVisitor, inCooldown, notePageCount, resolveIdentity, reserveSeq, safeStorage, startCooldown, touchSession,
  type Identity,
} from './visitor.js';

export type RecorderStatus = 'idle' | 'awaiting-consent' | 'recording' | 'sampled-out' | 'stopped';

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
  stop: () => void;
  flush: () => Promise<void>;
}

/** Rage click: several clicks in nearly the same spot in quick succession. */
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

export function createRecorder(rawOptions: AnyReplayOptions): RecorderHandle {
  const options: ResolvedOptions = resolveOptions(rawOptions);

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
  let pageCount = 0;
  /**
   * Traits given to `identify` before there was a session to attach them to.
   * Held in memory only, and sent the moment recording starts — so
   * `consent(true)` followed by `identify` on the next line works, and an
   * identity never leaves the page for a visitor who has not agreed.
   */
  let pendingTraits: IdentifyTraits | undefined;

  const sendIdentity = (who: Identity, traits: IdentifyTraits): void => {
    void fetch(`${options.ingestUrl}/v1/ingest/identify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'omit',
      body: JSON.stringify({ projectKey: options.projectKey, sessionId: who.sessionId, ...traits }),
    }).catch(() => { /* identity is best-effort; never surface to the page */ });
  };

  const collectMeta = (who: Identity): SessionMeta => ({
    startedAt: Date.now(),
    url: safeLocation(),
    lang: typeof navigator !== 'undefined' ? navigator.language : undefined,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    screenWidth: typeof window !== 'undefined' ? window.innerWidth : undefined,
    screenHeight: typeof window !== 'undefined' ? window.innerHeight : undefined,
    referrer: typeof document !== 'undefined' ? document.referrer || undefined : undefined,
    // The cap is a decision about starting a session, so it goes only where
    // ingest makes that decision: chunk 0. A resumed page starts later.
    ...(options.maxSessionsPerMonth !== undefined && who.nextSeq === 0
      ? { sessionCap: options.maxSessionsPerMonth }
      : {}),
  });

  const recentClicks: { x: number; y: number; t: number }[] = [];

  const noteInteraction = (event: RecordedEvent, channel: Transport): void => {
    // rrweb IncrementalSnapshot(3) with MouseInteraction(2) source carries clicks.
    const data = event.data as { source?: number; type?: number; x?: number; y?: number } | undefined;
    if (event.type !== 3 || data?.source !== 2 || typeof data.x !== 'number') return;

    const now = event.timestamp;
    recentClicks.push({ x: data.x, y: data.y ?? 0, t: now });
    while (recentClicks.length > 0 && now - recentClicks[0]!.t > RAGE_CLICK_WINDOW_MS) recentClicks.shift();

    if (recentClicks.length >= RAGE_CLICK_COUNT) {
      const first = recentClicks[0]!;
      const clustered = recentClicks.every(
        (c) => Math.abs(c.x - first.x) < RAGE_CLICK_RADIUS_PX && Math.abs(c.y - first.y) < RAGE_CLICK_RADIUS_PX,
      );
      if (clustered) channel.mergeFlags({ hasRageClick: true });
    }
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
    if (status === 'stopped' || status === 'sampled-out') return;
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
        onSeqReserved: (next) => reserveSeq(session, next),
        onStopped: (reason) => {
          status = 'stopped';
          stopRecording?.();
          stopRecording = undefined;
          // Only the verdict about the session itself is remembered across pages.
          // A transport failure or an origin problem is either transient or one
          // request per page load to notice it is fixed; a full quota is neither.
          if (reason === 'rejected_402') startCooldown(session);
          if (options.debug) console.warn(`[anyreplay] recording stopped: ${reason}`);
        },
      },
    );
    transport = channel;
    status = 'recording';
    // The page the recording starts on is where route changes are counted from.
    lastUrl = safeLocation();

    channel.setMeta(collectMeta(who));
    // The page the recorder starts on is a page view. Without this the
    // counter only ever reflects in-app navigations, so a single-page visit
    // reports zero pages — and on a resumed session it is the previous page's
    // count plus one, so the hop is visible.
    channel.mergeFlags({ pageCount });
    channel.start();

    stopRecording = record({
      emit: (event) => {
        const typed = event as unknown as RecordedEvent;
        noteInteraction(typed, channel);
        touchSession(session, typed.timestamp);
        channel.push(typed);
        drainPending();
      },
      maskAllInputs: options.maskAllInputs,
      maskTextClass: options.maskClass,
      blockClass: options.blockClass,
      // Passwords are never recorded, regardless of configuration.
      maskInputOptions: { password: true, email: true, tel: true },
      // Canvas capture is expensive and off unless a customer opts in later.
      recordCanvas: false,
      collectFonts: false,
    });
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
    window.addEventListener('pagehide', () => { channel.flushWithBeacon(); }, { capture: true });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') channel.flushWithBeacon();
    });
    window.addEventListener('error', () => channel.mergeFlags({ hasError: true }));
    window.addEventListener('unhandledrejection', () => channel.mergeFlags({ hasError: true }));

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
      // A refusal stops this page and undoes what an earlier acceptance
      // stored — on this page or on one last month. Stopping first, so no
      // flush reserves a chunk number after the keys are gone.
      transport?.stop('consent_withdrawn');
      if (status === 'idle' || status === 'awaiting-consent') status = 'stopped';
      pendingTraits = undefined;
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
    stop: () => {
      transport?.stop('stopped_by_page');
      // Stopped before it ever started: a later consent(true) must not start
      // what the page has already said it does not want.
      if (status === 'idle' || status === 'awaiting-consent') status = 'stopped';
      pendingTraits = undefined;
    },
    flush: () => transport?.flush() ?? Promise.resolve(),
  };
}

function safeLocation(): string | undefined {
  try {
    return typeof location !== 'undefined' ? location.href : undefined;
  } catch {
    return undefined;
  }
}
