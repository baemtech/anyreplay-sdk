import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRecorder, type Host } from '../src/recorder.js';
import { MemoryStore } from '../src/session.js';
import {
  isJavaScriptFatal, nativeErrorPayload, parseNativeCrash, serialiseRing, type NativeCrashSource,
} from '../src/native-crash.js';
import { nativeCrashSource } from '../src/native.js';
import type { CapturedElement } from '../src/tree.js';
import type { RecordedEvent } from '../src/wire.js';

const KEY = 'ar_pk_live_0123456789abcdef01234567';
const VISITOR = 'v0123456789abcdef01234567';
const OLD_SESSION = '11111111-2222-4333-8444-555555555555';
const T0 = 1_700_000_000_000;
const settle = async (n = 5) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0)); };

interface Post { url: string; body?: Record<string, unknown> }

function fakeHost(config: { crashClip?: boolean; online?: boolean; native?: NativeCrashSource | null } = {}) {
  let clock = T0;
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const posts: Post[] = [];
  let online = config.online !== false;
  let text = 'Merhaba';
  const host: Host = {
    now: () => clock,
    screen: () => ({ width: 390, height: 844 }),
    platform: () => ({ os: 'ios', version: '17.4', model: 'iPhone15,2' }),
    locale: () => 'tr-TR',
    snapshot: () => ({
      elements: new Map<number, CapturedElement>([
        [2, { id: 2, tag: 'Text', text, rect: { x: 0, y: 0, width: 200, height: 40 }, children: [] }],
      ]),
      rootId: 2,
    }),
    setInterval: (fn) => { nextTimer += 1; timers.set(nextTimer, fn); return nextTimer; },
    clearInterval: (handle) => { timers.delete(handle as number); },
    fetch: (async (url: string, init?: { body?: string }) => {
      if (!online) throw new TypeError('Network request failed');
      posts.push({ url: String(url), ...(init?.body ? { body: JSON.parse(init.body) } : {}) });
      if (String(url).includes('/v1/ingest/config')) {
        return { ok: true, status: 200, json: async () => ({ crashClip: config.crashClip ?? true }) } as Response;
      }
      return { ok: true, status: 202, json: async () => ({ accepted: true }) } as Response;
    }) as unknown as typeof fetch,
    ...(config.native ? { nativeCrash: config.native } : {}),
  };
  return {
    host,
    chunks: () => posts.filter((p) => p.url.endsWith('/v1/ingest/events')).map((p) => p.body!),
    advance: (ms: number) => { clock += ms; },
    setText: (next: string) => { text = next; },
    fire: () => { for (const fn of [...timers.values()]) fn(); },
    timerCount: () => timers.size,
    goOnline: () => { online = true; },
  };
}

/** The native module, as a fake: hands out `record` once, as the real one deletes its file. */
function fakeNative(record: string | null) {
  let pending = record;
  const calls = { take: 0, install: 0, uninstall: 0 };
  const source: NativeCrashSource = {
    take: async () => { calls.take += 1; const value = pending; pending = null; return value; },
    install: () => { calls.install += 1; },
    uninstall: () => { calls.uninstall += 1; },
  };
  return { source, calls };
}

const javaCrash = (ts: number) => JSON.stringify({
  v: 1, ts, platform: 'android', name: 'java.lang.IllegalStateException',
  message: 'Kart reddedildi: ayse@example.com',
  stack: 'java.lang.IllegalStateException: Kart reddedildi\n\tat com.example.shop.Checkout.pay(Checkout.kt:42)',
});

/** What the crashed launch left in the store while it was recording. */
async function recordingLeftBehind(store: MemoryStore, lastSeen: number, nextSeq = 3) {
  await store.setItem('anyreplay.vid', VISITOR);
  await store.setItem('anyreplay.sid', OLD_SESSION);
  await store.setItem('anyreplay.sts', String(lastSeen));
  await store.setItem('anyreplay.seq', String(nextSeq));
}

const fatalOf = (chunk: Record<string, unknown>) => (chunk.events as RecordedEvent[]).find((e) => e.type === 5)!;

describe('what the native side writes', () => {
  it('reads the JSON record', () => {
    expect(parseNativeCrash(javaCrash(T0))).toEqual({
      ts: T0, platform: 'android', name: 'java.lang.IllegalStateException',
      message: 'Kart reddedildi: ayse@example.com',
      stack: expect.stringContaining('Checkout.kt:42'),
    });
  });

  it('reads the signal line, in seconds or milliseconds', () => {
    expect(parseNativeCrash('SIG\t11\t1700000000\n')).toMatchObject({
      ts: 1_700_000_000_000, platform: 'ios', name: 'SIGSEGV',
      message: 'Fatal signal SIGSEGV: a bad memory access (segmentation fault)',
    });
    expect(parseNativeCrash('SIG\t5\t1700000000123')).toMatchObject({ ts: 1_700_000_000_123, name: 'SIGTRAP' });
    expect(parseNativeCrash('SIG\t31\t1700000000')).toMatchObject({ name: 'SIG31', message: 'Fatal signal SIG31' });
  });

  it('reads records written by the native code itself (captured from the Java handler and the Objective-C one)', () => {
    const android = "{\"v\":1,\"ts\":1795274418346,\"platform\":\"android\",\"name\":\"java.lang.IllegalStateException\",\"message\":\"Kart \\\"reddedildi\\\"\\n\\tsat\u0131r 2 \u2713 \ud83d\ude00 \\ud800 tab\\t\",\"stack\":\"java.lang.IllegalStateException: Kart \\\"reddedildi\\\"\\n\\tsat\u0131r 2 \u2713 \ud83d\ude00 \\ud800 tab\\t\\n\\tat Harness.main(Harness.java:14)\\n\"}";
    const ios = "{\"stack\":\"0   CoreFoundation                      0x0000000188157240 __exceptionPreprocess + 176\\n1   libobjc.A.dylib                     0x0000000187bd291c objc_exception_throw + 88\\n2   CoreFoundation                      0x0000000188157130 +[NSException exceptionWithName:reason:userInfo:] + 0\\n3   harness-macos                       0x00000001024a669c main + 864\\n4   dyld                                0x0000000187c604e4 start + 6992\",\"ts\":1795274418389,\"message\":\"checkout state lost for ayse@example.com\",\"name\":\"NSInvalidArgumentException\",\"v\":1,\"platform\":\"ios\"}";
    expect(parseNativeCrash(android)).toMatchObject({
      platform: 'android', name: 'java.lang.IllegalStateException', stack: expect.stringContaining('at Harness.main'),
    });
    expect(parseNativeCrash(android)!.message).toContain('satır 2 ✓');
    expect(parseNativeCrash(ios)).toMatchObject({
      platform: 'ios', name: 'NSInvalidArgumentException', message: 'checkout state lost for ayse@example.com',
      stack: expect.stringContaining('objc_exception_throw'),
    });
    expect(nativeErrorPayload(parseNativeCrash(ios)!).message).toBe('checkout state lost for [redacted]');
  });

  it('anything else is nothing', () => {
    for (const raw of [null, '', '   ', 'SIG\t6', 'SIG\tx\t1', '{"v":2,"ts":1,"name":"x"}', '{"v":1,"ts":1}', 'nope']) {
      expect(parseNativeCrash(raw)).toBeNull();
    }
  });

  it('redacts and clips the message and the stack like any error, and says it is native', () => {
    const payload = nativeErrorPayload(parseNativeCrash(javaCrash(T0))!);
    expect(payload).toMatchObject({ kind: 'fatal', native: true, name: 'java.lang.IllegalStateException' });
    expect(payload.message).toBe('Kart reddedildi: [redacted]');
    const long = nativeErrorPayload({ ts: 1, platform: 'ios', name: 'X', message: '', stack: 'y'.repeat(5000) });
    expect(long.message).toBe('X');
    expect((long.stack as string).length).toBe(4001);
  });

  it('a fatal JavaScript error React Native rethrows natively is not a second crash', () => {
    expect(isJavaScriptFatal({ ts: 1, platform: 'android', name: 'com.facebook.react.common.JavascriptException', message: '' })).toBe(true);
    expect(isJavaScriptFatal({ ts: 1, platform: 'ios', name: 'RCTFatalException: Unhandled JS Exception: boom', message: '' })).toBe(true);
    expect(isJavaScriptFatal({ ts: 1, platform: 'ios', name: 'NSRangeException', message: '' })).toBe(false);
  });

  it('a ring over the cap is not kept', () => {
    const big = [{ type: 2, timestamp: 1, data: { pad: 'x'.repeat(2 * 1024 * 1024) } }];
    expect(serialiseRing(big, { startedAt: 1 }, 1)).toBeNull();
    expect(serialiseRing([], { startedAt: 1 }, 1)).toBeNull();
    expect(JSON.parse(serialiseRing([{ type: 4, timestamp: 1, data: {} }], { startedAt: 1 }, 5)!)).toMatchObject({ v: 1, at: 5 });
  });
});

describe('the native module binding', () => {
  it('is missing in Expo Go, and found by its methods otherwise', async () => {
    expect(nativeCrashSource(null)).toBeUndefined();
    expect(nativeCrashSource({})).toBeUndefined();
    const install = vi.fn();
    const source = nativeCrashSource({ takeNativeCrash: async () => 'SIG\t6\t1', install, uninstall: vi.fn() })!;
    expect(await source.take()).toBe('SIG\t6\t1');
    source.install!();
    expect(install).toHaveBeenCalled();
    expect(await nativeCrashSource({ takeNativeCrash: async () => null })!.take()).toBeNull();
  });
});

describe('a native crash on the next launch', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('goes into the recording it happened in, at the next chunk number, and the resumed session numbers after it', async () => {
    const store = new MemoryStore();
    const crashAt = T0 - 60_000;
    await recordingLeftBehind(store, crashAt - 2_000);
    const native = fakeNative(javaCrash(crashAt));
    const f = fakeHost({ native: native.source });
    const rec = await createRecorder({ projectKey: KEY, storage: store }, f.host);
    // A minute later is inside the idle window: the same session resumes.
    expect(rec.sessionId()).toBe(OLD_SESSION);
    await rec.flush();
    await settle();

    const chunks = f.chunks();
    const crash = chunks.find((c) => (c.events as RecordedEvent[]).some((e) => e.type === 5))!;
    expect(crash).toMatchObject({ sessionId: OLD_SESSION, visitorId: VISITOR, seq: 3, flags: { hasError: true } });
    expect(crash.meta).toBeUndefined();
    expect(crash.events).toHaveLength(1);
    expect(fatalOf(crash)).toMatchObject({
      timestamp: crashAt,
      data: { tag: 'anyreplay.error', payload: { kind: 'fatal', native: true, message: 'Kart reddedildi: [redacted]' } },
    });
    const later = chunks.filter((c) => c !== crash);
    expect(later.length).toBeGreaterThan(0);
    for (const chunk of later) {
      expect(chunk.sessionId).toBe(OLD_SESSION);
      expect(chunk.seq as number).toBeGreaterThanOrEqual(4);
    }
    expect(native.calls.take).toBe(1);
  });

  it('after the idle window it still goes into the old recording; the new session starts at 0', async () => {
    const store = new MemoryStore();
    const crashAt = T0 - 3 * 60 * 60_000;
    await recordingLeftBehind(store, crashAt, 7);
    const f = fakeHost({ native: fakeNative(javaCrash(crashAt)).source });
    const rec = await createRecorder({ projectKey: KEY, storage: store }, f.host);
    expect(rec.sessionId()).not.toBe(OLD_SESSION);
    await rec.flush();
    await settle();
    const chunks = f.chunks();
    expect(chunks.find((c) => c.sessionId === OLD_SESSION)).toMatchObject({ seq: 7 });
    expect(chunks.filter((c) => c.sessionId === rec.sessionId()).map((c) => c.seq)[0]).toBe(0);
  });

  it('nothing to send without the native module, after a JavaScript fatal, or with recordErrors off', async () => {
    for (const [native, options] of [
      [null, {}],
      [fakeNative(JSON.stringify({ v: 1, ts: T0, platform: 'android', name: 'com.facebook.react.common.JavascriptException', message: 'x' })).source, {}],
      [fakeNative(javaCrash(T0)).source, { recordErrors: false }],
    ] as const) {
      const store = new MemoryStore();
      await recordingLeftBehind(store, T0 - 1_000);
      const f = fakeHost({ native });
      const rec = await createRecorder({ projectKey: KEY, storage: store, ...options }, f.host);
      await rec.flush();
      await settle();
      expect(f.chunks().some((c) => (c.events as RecordedEvent[]).some((e) => (e.data as { payload?: { native?: boolean } })?.payload?.native))).toBe(false);
      // The session resumes where it was: no number was taken.
      expect(f.chunks()[0]).toMatchObject({ sessionId: OLD_SESSION, seq: 3 });
    }
  });

  it('a crash before the first chunk had a number (seq 0) has no recording to go into', async () => {
    const store = new MemoryStore();
    await recordingLeftBehind(store, T0 - 1_000, 0);
    const f = fakeHost({ native: fakeNative(javaCrash(T0 - 1_000)).source });
    const rec = await createRecorder({ projectKey: KEY, storage: store }, f.host);
    await rec.flush();
    await settle();
    expect(f.chunks().map((c) => c.seq)).toEqual([0]);
    expect(fatalOf(f.chunks()[0]!)).toBeUndefined();
  });

  it('waits for consent; a refusal throws it away and stops writing crashes down', async () => {
    const store = new MemoryStore();
    await recordingLeftBehind(store, T0 - 1_000);
    const native = fakeNative(javaCrash(T0 - 1_000));
    const f = fakeHost({ native: native.source });
    const rec = await createRecorder({ projectKey: KEY, storage: store, requireConsent: true }, f.host);
    await settle();
    expect(native.calls.take).toBe(0);
    rec.consent(false);
    await settle();
    expect(native.calls.take).toBe(1);
    expect(native.calls.uninstall).toBe(1);
    expect(f.chunks()).toHaveLength(0);
    rec.consent(true);
    await settle();
    await rec.flush();
    await settle();
    expect(native.calls.install).toBe(1);
    expect(f.chunks().some((c) => fatalOf(c))).toBe(false);
  });

  it('is kept when ingest cannot be reached, and sent first on the launch after', async () => {
    const store = new MemoryStore();
    await recordingLeftBehind(store, T0 - 1_000);
    const offline = fakeHost({ online: false, native: fakeNative(javaCrash(T0 - 1_000)).source });
    await createRecorder({ projectKey: KEY, storage: store }, offline.host);
    await settle();
    expect(JSON.parse((await store.getItem('anyreplay.crash.native'))!)).toMatchObject({ sessionId: OLD_SESSION, chunks: [{ seq: 3 }] });

    const next = fakeHost({ native: fakeNative(null).source });
    await createRecorder({ projectKey: KEY, storage: store }, next.host);
    await vi.waitFor(async () => expect(await store.getItem('anyreplay.crash.native')).toBeNull());
    expect(next.chunks()[0]).toMatchObject({ sessionId: OLD_SESSION, seq: 3 });
  });

  it('stop() switches the native handlers off', async () => {
    const native = fakeNative(null);
    const rec = await createRecorder({ projectKey: KEY, storage: new MemoryStore() }, fakeHost({ native: native.source }).host);
    rec.stop();
    expect(native.calls.uninstall).toBe(1);
  });
});

describe('a native crash in crash clip mode', () => {
  /** A sampled-out launch with clips on, run for `seconds`: what it leaves in the store. */
  async function clipLaunch(store: MemoryStore, seconds: number, native: NativeCrashSource | null) {
    const f = fakeHost({ native });
    await createRecorder({ projectKey: KEY, sampleRate: 0, crashClip: true, storage: store }, f.host);
    await vi.waitFor(() => expect(f.timerCount()).toBe(1));
    for (let i = 0; i < seconds; i += 1) {
      f.advance(1_000);
      f.setText(`t${i}`);
      f.fire();
    }
    await settle();
    return f;
  }

  it('keeps the ring in the store every completed segment, only with the native module there', async () => {
    const withModule = new MemoryStore();
    const f = await clipLaunch(withModule, 25, fakeNative(null).source);
    expect(f.chunks()).toHaveLength(0);
    const ring = JSON.parse((await withModule.getItem('anyreplay.clip.ring'))!) as { v: number; events: RecordedEvent[]; meta: Record<string, unknown> };
    expect(ring.v).toBe(1);
    expect(ring.events[0]!.type).toBe(4);
    expect(ring.meta.platform).toBe('react-native');

    const without = new MemoryStore();
    await clipLaunch(without, 25, null);
    expect(await without.getItem('anyreplay.clip.ring')).toBeNull();
  });

  it('sends the kept ring with the crash at its end, as a crash clip', async () => {
    const store = new MemoryStore();
    const first = await clipLaunch(store, 35, fakeNative(null).source);
    const ring = JSON.parse((await store.getItem('anyreplay.clip.ring'))!) as { events: RecordedEvent[] };
    const lastKept = ring.events[ring.events.length - 1]!.timestamp;
    const crashAt = lastKept + 8_000;
    void first;

    const next = fakeHost({ crashClip: false, native: fakeNative(`SIG\t11\t${Math.floor(crashAt / 1000)}\n`).source });
    next.advance(5 * 60_000);
    // The project has turned clips off since: that stops this launch's ring, not the last launch's clip.
    const rec = await createRecorder({ projectKey: KEY, sampleRate: 0, storage: store }, next.host);
    expect(rec.status()).toBe('sampled-out');
    await vi.waitFor(() => expect(next.chunks().length).toBeGreaterThan(0));
    await settle();

    const chunks = next.chunks();
    expect(new Set(chunks.map((c) => c.sessionId)).size).toBe(1);
    expect(chunks[0]!.sessionId).not.toBe(OLD_SESSION);
    expect(chunks[0]).toMatchObject({ seq: 0, meta: { kind: 'crash_clip', platform: 'react-native' }, flags: { hasError: true } });
    const events = chunks.flatMap((c) => c.events as RecordedEvent[]);
    expect((chunks[0]!.meta as { startedAt: number }).startedAt).toBe(events[0]!.timestamp);
    expect(events[0]!.type).toBe(4);
    expect(events[events.length - 1]).toMatchObject({
      type: 5, timestamp: Math.floor(crashAt / 1000) * 1000,
      data: { payload: { kind: 'fatal', native: true, name: 'SIGSEGV' } },
    });
    expect(await store.getItem('anyreplay.clip.ring')).toBeNull();
    expect(Number(await store.getItem('anyreplay.clipAt'))).toBeGreaterThan(0);
  });

  it('no clip when the ring is more than a minute older than the crash, or inside the cool-down', async () => {
    const stale = new MemoryStore();
    await clipLaunch(stale, 25, fakeNative(null).source);
    const ring = JSON.parse((await stale.getItem('anyreplay.clip.ring'))!) as { events: RecordedEvent[] };
    const lastKept = ring.events[ring.events.length - 1]!.timestamp;
    const late = fakeHost({ crashClip: false, native: fakeNative(javaCrash(lastKept + 61_000)).source });
    await createRecorder({ projectKey: KEY, sampleRate: 0, storage: stale }, late.host);
    await settle();
    expect(late.chunks()).toHaveLength(0);
    expect(await stale.getItem('anyreplay.clip.ring')).toBeNull();

    const cooling = new MemoryStore();
    await clipLaunch(cooling, 25, fakeNative(null).source);
    await cooling.setItem('anyreplay.clipAt', String(T0 + 60_000));
    const ringed = JSON.parse((await cooling.getItem('anyreplay.clip.ring'))!) as { events: RecordedEvent[] };
    const next = fakeHost({ crashClip: false, native: fakeNative(javaCrash(ringed.events[ringed.events.length - 1]!.timestamp + 1_000)).source });
    next.advance(2 * 60_000);
    await createRecorder({ projectKey: KEY, sampleRate: 0, storage: cooling }, next.host);
    await settle();
    expect(next.chunks()).toHaveLength(0);
  });

  it('the app saying crashClip: false sends no clip', async () => {
    const store = new MemoryStore();
    await clipLaunch(store, 25, fakeNative(null).source);
    const ring = JSON.parse((await store.getItem('anyreplay.clip.ring'))!) as { events: RecordedEvent[] };
    const next = fakeHost({ native: fakeNative(javaCrash(ring.events[ring.events.length - 1]!.timestamp + 1_000)).source });
    await createRecorder({ projectKey: KEY, sampleRate: 0, crashClip: false, storage: store }, next.host);
    await settle();
    // crashClip: false in the options of this launch.
    expect(next.chunks()).toHaveLength(0);
  });

  it('a refusal removes the kept ring', async () => {
    const store = new MemoryStore();
    const f = fakeHost({ native: fakeNative(null).source });
    const rec = await createRecorder({ projectKey: KEY, sampleRate: 0, crashClip: true, storage: store }, f.host);
    await vi.waitFor(() => expect(f.timerCount()).toBe(1));
    for (let i = 0; i < 12; i += 1) { f.advance(1_000); f.fire(); }
    await settle();
    expect(await store.getItem('anyreplay.clip.ring')).not.toBeNull();
    rec.consent(false);
    await vi.waitFor(async () => expect(await store.getItem('anyreplay.clip.ring')).toBeNull());
  });
});
