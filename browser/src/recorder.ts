import { record } from 'rrweb';
import type { AnyReplayOptions, ResolvedOptions } from './config.js';
import { resolveOptions } from './config.js';
import { NAVIGATE_TAG, TRACK_TAG, validateTrack } from './events.js';
import { isSampledIn } from './sampling.js';
import { Transport, type RecordedEvent, type SessionMeta } from './transport.js';
import {
  inCooldown, notePageCount, resolveIdentity, reserveSeq, safeStorage, startCooldown, touchSession,
} from './visitor.js';

export type RecorderStatus = 'idle' | 'awaiting-consent' | 'recording' | 'sampled-out' | 'stopped';

export interface RecorderHandle {
  status: () => RecorderStatus;
  sessionId: () => string | null;
  consent: (granted: boolean) => void;
  identify: (traits: { userId?: string; email?: string }) => void;
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
  const identity = resolveIdentity(local, session);

  let status: RecorderStatus = 'idle';
  let stopRecording: (() => void) | undefined;
  let pageCount = identity.pageCount;

  if (!isSampledIn(identity.visitorId, options.sampleRate)) {
    // Decided from the visitor id, so this answer is stable across pages.
    return inertHandle('sampled-out', identity.sessionId);
  }

  if (inCooldown(session)) {
    // The previous page was told this session may not be started. That answer
    // will not have changed a page load later.
    if (options.debug) console.warn('[anyreplay] not recording: ingest refused a new session recently');
    return inertHandle('stopped', identity.sessionId);
  }

  const transport = new Transport(
    options,
    {
      projectKey: options.projectKey,
      sessionId: identity.sessionId,
      visitorId: identity.visitorId,
      initialSeq: identity.nextSeq,
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

  const collectMeta = (): SessionMeta => ({
    startedAt: Date.now(),
    url: safeLocation(),
    lang: typeof navigator !== 'undefined' ? navigator.language : undefined,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    screenWidth: typeof window !== 'undefined' ? window.innerWidth : undefined,
    screenHeight: typeof window !== 'undefined' ? window.innerHeight : undefined,
    referrer: typeof document !== 'undefined' ? document.referrer || undefined : undefined,
    // The cap is a decision about starting a session, so it goes only where
    // ingest makes that decision: chunk 0. A resumed page starts later.
    ...(options.maxSessionsPerMonth !== undefined && identity.nextSeq === 0
      ? { sessionCap: options.maxSessionsPerMonth }
      : {}),
  });

  const recentClicks: { x: number; y: number; t: number }[] = [];

  const noteInteraction = (event: RecordedEvent): void => {
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
      if (clustered) transport.mergeFlags({ hasRageClick: true });
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

  const emitCustom = (tag: string, payload: unknown): void => {
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

  /* ------------------------------ navigation ------------------------------ */

  let lastUrl = safeLocation();

  /**
   * A route change in a single-page app is a page view.
   *
   * rrweb records the DOM mutations that come with it, but nothing in the
   * stream says "this is a new page" — so the marker is emitted here, and
   * ingest indexes it for the player. Same-URL changes are ignored: routers
   * call `replaceState` for scroll positions and query tweaks, and each of
   * those is not a page.
   */
  const noteNavigation = (): void => {
    const url = safeLocation();
    if (!url || url === lastUrl) return;
    lastUrl = url;
    pageCount += 1;
    notePageCount(session, pageCount);
    transport.mergeFlags({ pageCount });
    emitCustom(NAVIGATE_TAG, { url, title: typeof document !== 'undefined' ? document.title : '' });
  };

  const begin = (): void => {
    if (status === 'recording' || status === 'stopped') return;
    status = 'recording';
    transport.setMeta(collectMeta());
    // The page the recorder starts on is a page view. Without this the
    // counter only ever reflects in-app navigations, so a single-page visit
    // reports zero pages — and on a resumed session it is the previous page's
    // count plus one, so the hop is visible.
    transport.mergeFlags({ pageCount });
    transport.start();

    stopRecording = record({
      emit: (event) => {
        const typed = event as unknown as RecordedEvent;
        noteInteraction(typed);
        touchSession(session, typed.timestamp);
        transport.push(typed);
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

    attachLifecycleHooks();
  };

  const attachLifecycleHooks = (): void => {
    if (typeof window === 'undefined') return;

    // pagehide is the reliable end-of-page signal; unload does not fire on
    // mobile Safari and beforeunload breaks the back/forward cache.
    window.addEventListener('pagehide', () => { transport.flushWithBeacon(); }, { capture: true });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') transport.flushWithBeacon();
    });
    window.addEventListener('error', () => transport.mergeFlags({ hasError: true }));
    window.addEventListener('unhandledrejection', () => transport.mergeFlags({ hasError: true }));

    // Wrapped after the original runs, so `location` already shows the new URL.
    const patch = (method: 'pushState' | 'replaceState'): void => {
      const original = history[method].bind(history);
      history[method] = function patched(...args: Parameters<History['pushState']>) {
        const result = original(...args);
        noteNavigation();
        return result;
      };
    };
    patch('pushState');
    patch('replaceState');
    window.addEventListener('popstate', noteNavigation);
  };

  if (options.requireConsent) {
    status = 'awaiting-consent';
  } else {
    begin();
  }

  return {
    status: () => status,
    sessionId: () => identity.sessionId,
    consent: (granted) => {
      if (granted) begin();
      else transport.stop('consent_withdrawn');
    },
    identify: (traits) => {
      if (!traits.userId && !traits.email) return;
      void fetch(`${options.ingestUrl}/v1/ingest/identify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'omit',
        body: JSON.stringify({
          projectKey: options.projectKey,
          sessionId: identity.sessionId,
          ...traits,
        }),
      }).catch(() => { /* identity is best-effort; never surface to the page */ });
    },
    track: (name, properties) => {
      const payload = validateTrack(name, properties);
      if (typeof payload === 'string') {
        if (options.debug) console.warn(`[anyreplay] track() ignored: ${payload}`);
        return;
      }
      emitCustom(TRACK_TAG, payload);
    },
    stop: () => transport.stop('stopped_by_page'),
    flush: () => transport.flush(),
  };
}

function safeLocation(): string | undefined {
  try {
    return typeof location !== 'undefined' ? location.href : undefined;
  } catch {
    return undefined;
  }
}

function inertHandle(status: RecorderStatus, sessionId: string | null): RecorderHandle {
  return {
    status: () => status,
    sessionId: () => sessionId,
    consent: () => {},
    identify: () => {},
    track: () => {},
    stop: () => {},
    flush: async () => {},
  };
}
