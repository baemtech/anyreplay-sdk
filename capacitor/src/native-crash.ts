import {
  CLIP_COOLDOWN_MS, CLIP_MAX_BYTES, CLIP_SENT_KEY, ERROR_TAG, Transport, redactText, resolveOptions, uuidv4,
  type AnyReplayOptions, type ClipRing, type RecordedEvent, type SessionMeta,
} from '@anyreplay/browser';

/**
 * Crashes in the app's own native code, for `@anyreplay/capacitor` and
 * `@anyreplay/cordova` (docs/SDK-CONTRACT.md §8.3, §8.6).
 *
 * The page is recorded by `@anyreplay/browser`, and a page does not survive
 * the app crashing in Kotlin, Java, Objective-C or Swift. The plugin's native
 * side does: it writes the crash to a small file (`AnyReplayCrashKeeper` in
 * android/ and ios/, installed when the plugin loads), and on the next launch
 * the shell takes it — before the recorder starts — and:
 *
 * - when the crashed launch was recording (its session id and a chunk number
 *   above 0 are among the mirrored keys), reserves that number and, once the
 *   recorder may record (consent), sends one chunk into that session with
 *   it: an `anyreplay.error` event `{kind: 'fatal', native: true}` stamped at
 *   the crash time. Ingest marks that recording crashed at that moment, and a
 *   resumed session goes on from the number after.
 * - when it was keeping a crash clip instead, sends the ring that launch kept
 *   natively (the recorder hands it over every completed ten-second segment,
 *   `ShellInfo.onClipRing`) with the fatal event at its end, as a crash clip —
 *   if the ring's last event is less than a minute older than the crash, and
 *   outside the five-minute cool-down.
 *
 * The React Native and Flutter SDKs do the same; the native file formats are
 * shared.
 */

/** A ring whose last event is older than this before the crash is not a clip of it. */
export const NATIVE_CLIP_MAX_GAP_MS = 60_000;

/** One crash as the native side wrote it. */
export interface NativeCrash {
  /** When it happened, in epoch milliseconds. */
  ts: number;
  platform: string;
  name: string;
  message: string;
  stack?: string;
}

/** The Darwin signal numbers the iOS side catches, by name. */
export const DARWIN_SIGNALS: Readonly<Record<number, string>> = {
  4: 'SIGILL', 5: 'SIGTRAP', 6: 'SIGABRT', 8: 'SIGFPE', 10: 'SIGBUS', 11: 'SIGSEGV',
};

const SIGNAL_MEANING: Readonly<Record<string, string>> = {
  SIGILL: 'an illegal instruction',
  SIGTRAP: "a trap: Swift's fatalError, a forced unwrap of nil, an index out of range or an overflow",
  SIGABRT: 'abort() was called',
  SIGFPE: 'an arithmetic error',
  SIGBUS: 'a bad memory access (bus error)',
  SIGSEGV: 'a bad memory access (segmentation fault)',
};

/**
 * Reads what the native side wrote. Two shapes:
 *
 * - JSON, from the Kotlin/Java handler and the Objective-C exception
 *   handler: `{"v":1,"ts":EPOCH_MS,"platform":"android"|"ios","name":…,"message":…,"stack":…}`.
 * - One line, from the iOS signal handler, which may do nothing but `write()`
 *   a buffer it formats itself: `SIG\tSIGNO\tEPOCH_SECONDS\n` (decimal). A
 *   time over 10^11 is read as milliseconds.
 *
 * Anything else is null.
 */
export function parseNativeCrash(raw: unknown): NativeCrash | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (text.length === 0) return null;
  if (text.startsWith('SIG\t')) {
    const parts = text.split('\n')[0]!.split('\t');
    if (parts.length < 3) return null;
    const signo = Number(parts[1]!.trim());
    const time = Number(parts[2]!.trim());
    if (!Number.isInteger(signo) || !Number.isInteger(time) || time <= 0) return null;
    const name = DARWIN_SIGNALS[signo] ?? `SIG${signo}`;
    const meaning = SIGNAL_MEANING[name];
    return {
      ts: time > 100_000_000_000 ? time : time * 1000,
      platform: 'ios',
      name,
      message: meaning ? `Fatal signal ${name}: ${meaning}` : `Fatal signal ${name}`,
    };
  }
  try {
    const value = JSON.parse(text) as Record<string, unknown> | null;
    if (!value || typeof value !== 'object') return null;
    const { v, ts, name, message, stack, platform } = value;
    if (v !== 1 || typeof ts !== 'number' || !(ts > 0) || typeof name !== 'string' || name.length === 0) return null;
    return {
      ts: Math.round(ts),
      platform: typeof platform === 'string' ? platform : 'unknown',
      name,
      message: typeof message === 'string' ? message : '',
      ...(typeof stack === 'string' && stack.trim().length > 0 ? { stack } : {}),
    };
  } catch {
    return null;
  }
}

const MAX_MESSAGE = 1000;
const MAX_STACK = 4000;
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);

/** The `anyreplay.error` payload of a native crash: redacted and clipped like any error (§6.6, §8.3). */
export function nativeErrorPayload(crash: NativeCrash): Record<string, unknown> {
  const message = redactText(crash.message);
  return {
    message: clip(message.trim().length === 0 ? crash.name : message, MAX_MESSAGE),
    name: clip(crash.name, 200),
    ...(crash.stack ? { stack: clip(redactText(crash.stack), MAX_STACK) } : {}),
    kind: 'fatal',
    native: true,
  };
}

export function nativeCrashEvent(crash: NativeCrash, at: number = crash.ts): RecordedEvent {
  return { type: 5, timestamp: at, data: { tag: ERROR_TAG, payload: nativeErrorPayload(crash) } };
}

/** The ring as the native side keeps it: null when it is empty or over the cap. */
export function serialiseRing(ring: ClipRing, now: number = Date.now()): string | null {
  if (ring.events.length === 0) return null;
  try {
    const text = JSON.stringify({ v: 1, at: now, meta: ring.meta, events: ring.events });
    // Characters, as the browser SDK's own cap counts them.
    return text.length > CLIP_MAX_BYTES ? null : text;
  } catch {
    return null;
  }
}

export function parseRing(raw: unknown): ClipRing | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const value = JSON.parse(raw) as { v?: unknown; meta?: unknown; events?: unknown };
    if (value?.v !== 1 || !Array.isArray(value.events)) return null;
    const events = (value.events as RecordedEvent[]).filter((e) => e && typeof e === 'object' && typeof e.timestamp === 'number');
    if (events.length === 0) return null;
    return { events, meta: (value.meta && typeof value.meta === 'object' ? value.meta : { startedAt: events[0]!.timestamp }) as SessionMeta };
  } catch {
    return null;
  }
}

/** What a crashed launch left, ready to go once the recorder may record. */
export type NativeCrashDelivery =
  | { kind: 'recording'; sessionId: string; visitorId: string; seq: number; event: RecordedEvent }
  | { kind: 'clip'; visitorId: string; events: RecordedEvent[]; meta: SessionMeta };

const VISITOR_KEY = 'anyreplay.vid';
const SESSION_KEY = 'anyreplay.sid';
const SEQ_KEY = 'anyreplay.seq';

interface KeyValue {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function read(storage: () => KeyValue | undefined, key: string): string | null {
  try { return storage()?.getItem(key) ?? null; } catch { return null; }
}

/**
 * Decides where the crash goes, before the recorder starts: into the crashed
 * recording (and its chunk number is reserved now, in `sessionStorage`, so
 * the recorder resumes after it), as a crash clip, or nowhere. Nothing is
 * sent here.
 */
export function placeNativeCrash(
  crash: NativeCrash,
  ring: ClipRing | null,
  options: Pick<AnyReplayOptions, 'recordErrors' | 'crashClip'>,
  now: number = Date.now(),
  local: () => KeyValue | undefined = () => globalThis.localStorage,
  session: () => KeyValue | undefined = () => globalThis.sessionStorage,
): NativeCrashDelivery | null {
  if (options.recordErrors === false) return null;
  const visitorId = read(local, VISITOR_KEY);
  if (!visitorId || !/^[A-Za-z0-9_-]{8,64}$/.test(visitorId)) return null;

  // A chunk number above 0 was reserved, so the crashed launch was recording
  // and ingest has that session.
  const sessionId = read(session, SESSION_KEY);
  const seq = Number(read(session, SEQ_KEY));
  if (sessionId && Number.isInteger(seq) && seq > 0) {
    try { session()?.setItem(SEQ_KEY, String(seq + 1)); } catch { /* the recorder resumes at seq then; ingest drops the duplicate */ }
    return { kind: 'recording', sessionId, visitorId, seq, event: nativeCrashEvent(crash) };
  }

  if (!ring || options.crashClip === false) return null;
  const last = ring.events[ring.events.length - 1]!.timestamp;
  const gap = crash.ts - last;
  // A second of slack the other way, for a clock that moved.
  if (gap > NATIVE_CLIP_MAX_GAP_MS || gap < -1000) return null;
  const clipAt = Number(read(local, CLIP_SENT_KEY));
  if (Number.isFinite(clipAt) && clipAt > 0 && now - clipAt >= 0 && now - clipAt < CLIP_COOLDOWN_MS) return null;
  return {
    kind: 'clip',
    visitorId,
    events: [...ring.events, nativeCrashEvent(crash, gap < 0 ? last : crash.ts)],
    meta: ring.meta,
  };
}

/**
 * Sends it, through the browser SDK's own transport (its chunking, retries
 * and limits): one chunk into the crashed session, or a crash clip as a new
 * session (`kind: 'crash_clip'`, from seq 0, as `@anyreplay/browser` sends
 * its own). Returns a stop function, for a refusal of consent meanwhile.
 */
export function sendNativeCrash(delivery: NativeCrashDelivery, options: AnyReplayOptions): () => void {
  const resolved = resolveOptions(options);
  const clipping = delivery.kind === 'clip';
  if (clipping) {
    try { globalThis.localStorage?.setItem(CLIP_SENT_KEY, String(Date.now())); } catch { /* the cool-down is best effort */ }
  }
  const events = clipping ? delivery.events : [delivery.event];
  const channel = new Transport(
    resolved,
    {
      projectKey: resolved.projectKey,
      sessionId: clipping ? uuidv4() : delivery.sessionId,
      visitorId: delivery.visitorId,
      initialSeq: clipping ? 0 : delivery.seq,
      bufferLimit: events.length + 64,
    },
    {
      onWarning: (message) => { if (resolved.debug) console.warn(`[anyreplay] native crash: ${message}`); },
      onSent: () => { if (channel.bufferedCount === 0) setTimeout(() => channel.stop('native_crash_sent'), 0); },
    },
  );
  if (clipping) {
    const { sessionCap: _cap, ...meta } = delivery.meta;
    channel.setMeta({ ...meta, startedAt: events[0]!.timestamp, kind: 'crash_clip' });
    channel.mergeFlags({ hasError: true, pageCount: 1 });
  } else {
    channel.mergeFlags({ hasError: true });
  }
  for (const event of events) channel.push(event);
  channel.start();
  void channel.flush(true).catch(() => undefined);
  return () => channel.stop('consent_withdrawn');
}
