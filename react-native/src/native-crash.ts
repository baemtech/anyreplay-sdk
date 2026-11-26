/**
 * Crashes in the app's own native code: a Kotlin or Java exception nobody
 * caught on Android; an Objective-C exception or a fatal signal (SIGABRT,
 * SIGSEGV, SIGBUS, SIGILL, SIGFPE, SIGTRAP — Swift's `fatalError` and a
 * forced unwrap of nil end in the last) on iOS. A JavaScript error is not one
 * of them: events.ts hears those.
 *
 * Nothing JavaScript holds survives such a crash. The package's optional
 * native module (`AnyReplayCrash`, in android/ and ios/) installs its
 * handlers at app start and writes one small file when the app crashes:
 * `anyreplay-native-crash.json` in the app's private files (Android
 * `filesDir`; iOS Application Support/anyreplay). On the next launch, once
 * the recorder may start (consent), it takes that file — `takeNativeCrash`
 * returns the text and deletes it — before it opens the new recording, and:
 *
 * - when the crashed launch was recording (its session id and the next chunk
 *   number are still in the store, the number above 0), sends one chunk into
 *   that session with that number: an `anyreplay.error` event `{kind:
 *   'fatal', native: true}` stamped at the crash time. Ingest marks the old
 *   recording crashed at that moment. The number after it is reserved first,
 *   so a resumed session goes on from there.
 * - when it was keeping a crash clip instead (sampled out), sends the ring
 *   that launch last wrote to the store (every completed ten-second segment
 *   overwrites it) with the fatal event at its end, as a crash clip — if the
 *   ring's last event is less than a minute older than the crash, and outside
 *   the five-minute cool-down.
 *
 * Without the native module (Expo Go, an app not rebuilt since the package
 * was added, tests) there is nothing to take and nothing changes.
 *
 * The Flutter SDK does the same (packages/recorder-flutter/lib/src/
 * native_crash.dart); the file formats are shared.
 */
import { CLIP_COOLDOWN_MS, CLIP_MAX_BYTES, clipUpload, uploadPending, type PendingUpload } from './crash.js';
import { ERROR_TAG, redactText } from './events.js';
import {
  CLIP_AT_KEY, CLIP_RING_KEY, NATIVE_CRASH_KEY, SEQ_KEY, SESSION_KEY, VISITOR_KEY, reserveSeq, uuidv4,
  type KeyValueStore,
} from './session.js';
import { utf8Length } from './transport.js';
import { EVENT, type RecordedEvent, type SessionMeta } from './wire.js';

/** The native module's name, as JavaScript looks it up. */
export const NATIVE_CRASH_MODULE = 'AnyReplayCrash';

/** A ring whose last event is older than this before the crash is not a clip of it. */
export const NATIVE_CLIP_MAX_GAP_MS = 60_000;

/** The native module, as the recorder sees it. Every method may be missing or reject. */
export interface NativeCrashSource {
  /** What the native side wrote about the last launch's crash, deleting it; null when there was none. */
  take(): Promise<string | null>;
  /** Puts the handlers back in place after `uninstall` (they are installed at app start already). */
  install?(): void;
  /** The recorder was stopped: crashes are no longer written down. */
  uninstall?(): void;
}

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
export function parseNativeCrash(raw: string | null | undefined): NativeCrash | null {
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

/**
 * Crashes the native side sees that are JavaScript errors already recorded:
 * in a release build React Native turns a fatal JavaScript error into a
 * native one to end the app (`JavascriptException` on Android, an exception
 * named `RCTFatalException: …` on iOS). events.ts has recorded it, with the
 * JavaScript stack, before that happens.
 */
export function isJavaScriptFatal(crash: NativeCrash): boolean {
  return crash.name === 'com.facebook.react.common.JavascriptException'
    || crash.name.startsWith('RCTFatalException');
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
  return { type: EVENT.custom, timestamp: at, data: { tag: ERROR_TAG, payload: nativeErrorPayload(crash) } };
}

/** The ring as it stands, for the store: null when it is empty or over the cap. */
export function serialiseRing(events: RecordedEvent[], meta: SessionMeta, now: number): string | null {
  if (events.length === 0) return null;
  try {
    const text = JSON.stringify({ v: 1, at: now, meta, events });
    return utf8Length(text) > CLIP_MAX_BYTES ? null : text;
  } catch {
    return null;
  }
}

function parseRing(raw: string | null): { meta: SessionMeta; events: RecordedEvent[] } | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { v?: unknown; meta?: unknown; events?: unknown };
    if (value?.v !== 1 || !Array.isArray(value.events)) return null;
    const events = (value.events as RecordedEvent[]).filter((e) => e && typeof e === 'object' && typeof e.timestamp === 'number');
    if (events.length === 0) return null;
    const meta = (value.meta && typeof value.meta === 'object' ? value.meta : {}) as SessionMeta;
    return { meta, events };
  } catch {
    return null;
  }
}

async function readAndRemove(store: KeyValueStore, key: string): Promise<string | null> {
  try {
    const value = await store.getItem(key);
    if (value !== null) {
      if (store.removeItem) await store.removeItem(key);
      else await store.setItem(key, '');
    }
    return value || null;
  } catch {
    return null;
  }
}

export interface DeliverOptions {
  source: NativeCrashSource | undefined;
  store: KeyValueStore;
  fetch: typeof fetch;
  ingestUrl: string;
  projectKey: string;
  appId?: string;
  recordErrors: boolean;
  /** The app's `crashClip` option: `false` sends no clip, whatever the project says. */
  crashClip?: boolean;
  maxEventsPerChunk: number;
  now: () => number;
  /** False once consent was refused or the recorder stopped: then nothing more is sent. */
  stillAllowed: () => boolean;
  debug?: boolean;
}

/**
 * Takes the last launch's native crash and sends it where it belongs (see
 * the top of this file). Everything the store must know before the new
 * recording opens — the chunk number used, the ring removed — is done when
 * this returns; the request itself goes on afterwards. One that fails for
 * now (no network, a 5xx) is kept under `anyreplay.crash.native` and sent
 * first on the next launch, as a crashed recording's tail is.
 */
export async function deliverNativeCrash(options: DeliverOptions): Promise<void> {
  const { store } = options;
  let raw: string | null = null;
  try {
    raw = options.source ? await options.source.take() : null;
  } catch {
    raw = null;
  }
  // The ring is the last launch's, whatever happens next: this launch keeps its own.
  const ring = await readAndRemove(store, CLIP_RING_KEY);
  const crash = parseNativeCrash(raw);
  if (!crash || !options.recordErrors || isJavaScriptFatal(crash)) return;

  const upload = await place(crash, ring, options);
  if (!upload) return;
  if (options.debug) console.warn(`[anyreplay] the app crashed in native code last time (${crash.name}); sending it`);
  void send(upload, options).catch(() => { /* never surfaces to the app */ });
}

/** Where the crash goes: into the crashed recording, as a crash clip, or nowhere. */
async function place(crash: NativeCrash, ringRaw: string | null, options: DeliverOptions): Promise<PendingUpload | null> {
  const { store } = options;
  const visitorId = await store.getItem(VISITOR_KEY).catch(() => null);
  if (!visitorId || !/^v[0-9a-f]{24}$/.test(visitorId)) return null;
  const appId = options.appId ? { appId: options.appId } : {};

  // A chunk number above 0 was reserved, so the crashed launch was recording
  // and ingest has that session.
  const sessionId = await store.getItem(SESSION_KEY).catch(() => null);
  const nextSeq = Number(await store.getItem(SEQ_KEY).catch(() => null));
  if (sessionId && Number.isInteger(nextSeq) && nextSeq > 0) {
    await reserveSeq(store, nextSeq + 1).catch(() => {});
    return {
      sessionId,
      visitorId,
      ...appId,
      chunks: [{ seq: nextSeq, events: [nativeCrashEvent(crash)], flags: { hasError: true } }],
    };
  }

  // A crash clip, when that launch kept one.
  if (options.crashClip === false) return null;
  const ring = parseRing(ringRaw);
  if (!ring) return null;
  const last = ring.events[ring.events.length - 1]!.timestamp;
  const gap = crash.ts - last;
  // A second of slack the other way, for a clock that moved.
  if (gap > NATIVE_CLIP_MAX_GAP_MS || gap < -1000) return null;
  const now = options.now();
  const clipAt = Number(await store.getItem(CLIP_AT_KEY).catch(() => null));
  if (Number.isFinite(clipAt) && clipAt > 0 && now - clipAt >= 0 && now - clipAt < CLIP_COOLDOWN_MS) return null;
  await store.setItem(CLIP_AT_KEY, String(now)).catch(() => {});
  const events = [...ring.events, nativeCrashEvent(crash, gap < 0 ? last : crash.ts)];
  return clipUpload(events, { sessionId: uuidv4(), visitorId, ...appId }, ring.meta, options.maxEventsPerChunk);
}

async function send(upload: PendingUpload, options: DeliverOptions): Promise<void> {
  if (!options.stillAllowed()) return;
  const result = await uploadPending(options.fetch, {
    ingestUrl: options.ingestUrl, projectKey: options.projectKey, now: options.now,
  }, upload);
  if (result === 'done' || !options.stillAllowed()) return;
  // Kept for the next launch, unless an older one already waits there.
  const waiting = await options.store.getItem(NATIVE_CRASH_KEY).catch(() => null);
  if (!waiting) await options.store.setItem(NATIVE_CRASH_KEY, JSON.stringify(upload)).catch(() => {});
}
