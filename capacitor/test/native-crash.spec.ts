import { IPHONE, KEY, mockFetch, mockNative, turns, type MockNative } from './harness';
import { createAppRecorder, type AppRecorder } from '../src/shell';
import { nativeErrorPayload, parseNativeCrash, parseRing, serialiseRing } from '../src/native-crash';
import { SDK_NAME, SDK_VERSION } from '../src/version';

/**
 * A crash in the app's native code, reported on the next launch: the native
 * half is a mock that behaves like AnyReplayCrashKeeper (it hands out what
 * it wrote once, then nothing); the recorder underneath is the real
 * @anyreplay/browser with real rrweb.
 */

const state = vi.hoisted(() => ({ native: true }));
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => state.native, isPluginAvailable: () => state.native },
  registerPlugin: () => ({}),
}));
const { capacitorBridge } = await import('../src/index');

const VISITOR = 'v0123456789abcdef01234567';
const OLD_SESSION = '3f1c2a4e-8b7d-4c3e-9a1b-2c3d4e5f6a7b';

interface CrashNative extends MockNative {
  rings: (string | null)[];
  stopCrashKeeper: ReturnType<typeof vi.fn>;
}

/** The native half with a crash (and a ring) from the last launch in it. */
function crashNative(stored: string | null, crash: string | null, ring: string | null = null): CrashNative {
  const native = mockNative(stored) as CrashNative;
  let pendingCrash = crash;
  let pendingRing = ring;
  native.rings = [];
  Object.assign(native, {
    takeNativeCrash: vi.fn(async () => { const value = pendingCrash; pendingCrash = null; return { value }; }),
    takeClipRing: vi.fn(async () => { const value = pendingRing; pendingRing = null; return { value }; }),
    writeClipRing: vi.fn(async ({ value }: { value: string | null }) => { native.rings.push(value); }),
    stopCrashKeeper: vi.fn(async () => undefined),
  });
  return native;
}

/** The mirrored keys a launch that was recording left behind. */
const recordingState = (lastSeen: number, seq: number) => JSON.stringify({
  v: 1,
  local: { 'anyreplay.vid': VISITOR },
  session: { 'anyreplay.sid': OLD_SESSION, 'anyreplay.sts': String(lastSeen), 'anyreplay.seq': String(seq), 'anyreplay.pc': '1' },
});

const swiftCrash = (ts: number) => JSON.stringify({
  v: 1, ts, platform: 'ios', name: 'NSInvalidArgumentException',
  message: '-[__NSCFNumber length]: unrecognized selector, user ayse@example.com',
  stack: '0 CoreFoundation 0x1 __exceptionPreprocess\n1 Shop 0x2 -[CheckoutViewController pay:]',
});

let recorder: AppRecorder | undefined;
function create(native: MockNative | undefined): AppRecorder {
  recorder = createAppRecorder({
    platform: 'capacitor',
    sdk: { name: SDK_NAME, version: SDK_VERSION },
    native: () => (native ? capacitorBridge(native) : undefined),
    syncIntervalMs: 1_000_000,
  });
  return recorder;
}

type Event = { type: number; timestamp: number; data?: { tag?: string; payload?: Record<string, unknown> } };
const eventsOf = (body: Record<string, unknown>) => body.events as Event[];
const nativeFatal = (body: Record<string, unknown>) => eventsOf(body).find((e) => e.type === 5 && e.data?.payload?.native === true);

beforeEach(() => {
  state.native = true;
  localStorage.clear();
  sessionStorage.clear();
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(IPHONE);
  document.body.innerHTML = '<main><h1>Sepet</h1><button id="pay">Öde</button></main>';
});

afterEach(() => {
  recorder?.stop();
  recorder = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('what the native side writes', () => {
  it('reads the JSON record and the signal line, as the React Native and Flutter SDKs do', () => {
    expect(parseNativeCrash(swiftCrash(1_700_000_000_000))).toMatchObject({ ts: 1_700_000_000_000, name: 'NSInvalidArgumentException', platform: 'ios' });
    expect(parseNativeCrash('SIG\t6\t1700000000\n')).toEqual({
      ts: 1_700_000_000_000, platform: 'ios', name: 'SIGABRT', message: 'Fatal signal SIGABRT: abort() was called',
    });
    for (const raw of [null, undefined, '', 'SIG\t6', '{"v":1}', 'garbage', 42]) expect(parseNativeCrash(raw)).toBeNull();
  });

  it('redacts the message and the stack', () => {
    const payload = nativeErrorPayload(parseNativeCrash(swiftCrash(1))!);
    expect(payload).toMatchObject({ kind: 'fatal', native: true, name: 'NSInvalidArgumentException' });
    expect(payload.message).toContain('[redacted]');
    expect(payload.message).not.toContain('ayse@');
  });

  it('keeps a ring only under the cap, and reads back what it wrote', () => {
    const ring = { events: [{ type: 4, timestamp: 1, data: {} }], meta: { startedAt: 1, platform: 'capacitor' } };
    expect(parseRing(serialiseRing(ring, 5))).toEqual(ring);
    expect(serialiseRing({ events: [{ type: 2, timestamp: 1, data: { pad: 'x'.repeat(2 * 1024 * 1024) } }], meta: { startedAt: 1 } })).toBeNull();
    expect(parseRing('{"v":1,"events":[]}')).toBeNull();
  });
});

describe('a native crash on the next launch', () => {
  it('goes into the recording it ended, at the next chunk number; the resumed session goes on after it', async () => {
    const bodies = mockFetch();
    const crashAt = Date.now() - 30_000;
    const native = crashNative(recordingState(crashAt - 1_000, 4), swiftCrash(crashAt));
    const app = create(native);
    await app.init({ projectKey: KEY, ingestUrl: 'https://in.test', flushIntervalMs: 1_000_000 });
    await turns();
    await app.flush();
    await turns();

    expect(app.sessionId()).toBe(OLD_SESSION);
    const crash = bodies.find((b) => nativeFatal(b))!;
    expect(crash).toMatchObject({ sessionId: OLD_SESSION, visitorId: VISITOR, seq: 4, appId: 'com.example.shop', flags: { hasError: true } });
    expect(crash.meta).toBeUndefined();
    expect(eventsOf(crash)).toHaveLength(1);
    expect(nativeFatal(crash)).toMatchObject({ timestamp: crashAt, data: { tag: 'anyreplay.error', payload: { kind: 'fatal' } } });
    const rest = bodies.filter((b) => b !== crash);
    expect(rest.length).toBeGreaterThan(0);
    for (const body of rest) {
      expect(body.sessionId).toBe(OLD_SESSION);
      expect(body.seq as number).toBeGreaterThanOrEqual(5);
    }
  });

  it('waits for consent, and a refusal throws it away', async () => {
    const bodies = mockFetch();
    const native = crashNative(recordingState(Date.now() - 1_000, 2), swiftCrash(Date.now() - 1_000));
    const app = create(native);
    await app.init({ projectKey: KEY, ingestUrl: 'https://in.test', flushIntervalMs: 1_000_000, requireConsent: true });
    await turns();
    expect(bodies).toEqual([]);
    app.consent(false);
    await turns();
    app.consent(true);
    await app.flush();
    await turns();
    expect(bodies.some((b) => nativeFatal(b))).toBe(false);
    expect(native.rings).toContain(null);
    // A refusal is not a stop: crashes are still written down for a later yes.
    expect(native.stopCrashKeeper).not.toHaveBeenCalled();
  });

  it('is sent once consent is given', async () => {
    const bodies = mockFetch();
    const native = crashNative(recordingState(Date.now() - 1_000, 2), swiftCrash(Date.now() - 1_000));
    const app = create(native);
    await app.init({ projectKey: KEY, ingestUrl: 'https://in.test', flushIntervalMs: 1_000_000, requireConsent: true });
    await turns();
    expect(bodies).toEqual([]);
    app.consent(true);
    await app.flush();
    await turns();
    expect(bodies.find((b) => nativeFatal(b))).toMatchObject({ sessionId: OLD_SESSION, seq: 2 });
  });

  it('with recordErrors off, or a crash before any chunk was numbered, nothing is sent', async () => {
    for (const [stored, options] of [
      [recordingState(Date.now() - 1_000, 3), { recordErrors: false }],
      [recordingState(Date.now() - 1_000, 0), {}],
    ] as const) {
      sessionStorage.clear();
      localStorage.clear();
      const bodies = mockFetch();
      const app = create(crashNative(stored, swiftCrash(Date.now() - 1_000)));
      await app.init({ projectKey: KEY, ingestUrl: 'https://in.test', flushIntervalMs: 1_000_000, ...options });
      await app.flush();
      await turns();
      expect(bodies.some((b) => nativeFatal(b))).toBe(false);
      app.stop();
    }
  });

  it('a native side from before these calls existed changes nothing', async () => {
    const bodies = mockFetch();
    const native = mockNative(recordingState(Date.now() - 1_000, 3));
    Object.assign(native, { takeNativeCrash: vi.fn(() => new Promise(() => {})) });
    const app = create(native);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const ready = app.init({ projectKey: KEY, ingestUrl: 'https://in.test', flushIntervalMs: 1_000_000 });
    await vi.advanceTimersByTimeAsync(1_100);
    await ready;
    vi.useRealTimers();
    await app.flush();
    expect(bodies[0]).toMatchObject({ sessionId: OLD_SESSION, seq: 3 });
  });
});

describe('a native crash in crash clip mode', () => {
  it('keeps the ring natively while clipping, and removes it on stop()', async () => {
    mockFetch();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const native = crashNative(null, null);
    const app = create(native);
    await app.init({ projectKey: KEY, ingestUrl: 'https://in.test', flushIntervalMs: 1_000_000, sampleRate: 0, crashClip: true });
    await vi.advanceTimersByTimeAsync(50);
    expect(app.status()).toBe('sampled-out');
    document.getElementById('pay')!.textContent = 'Öde şimdi';
    await vi.advanceTimersByTimeAsync(10_500);
    document.getElementById('pay')!.textContent = 'Ödeniyor…';
    await vi.advanceTimersByTimeAsync(50);
    const kept = native.rings.filter((r): r is string => typeof r === 'string');
    expect(kept.length).toBeGreaterThan(0);
    expect(parseRing(kept[0]!)!.meta).toMatchObject({ platform: 'capacitor', appVersion: '3.4.1' });
    app.stop();
    await vi.advanceTimersByTimeAsync(10);
    expect(native.rings[native.rings.length - 1]).toBeNull();
    expect(native.stopCrashKeeper).toHaveBeenCalled();
  });

  it('sends the kept ring with the crash at its end, as a crash clip', async () => {
    const bodies = mockFetch();
    const now = Date.now();
    const ring = serialiseRing({
      events: [
        { type: 4, timestamp: now - 40_000, data: { href: 'https://localhost/', width: 390, height: 844 } },
        { type: 2, timestamp: now - 40_000, data: { node: { type: 0, childNodes: [], id: 1 }, initialOffset: { top: 0, left: 0 } } },
        { type: 3, timestamp: now - 25_000, data: { source: 0, adds: [], removes: [], texts: [], attributes: [] } },
      ],
      meta: { startedAt: now - 40_000, platform: 'capacitor', sdk: { name: SDK_NAME, version: SDK_VERSION } },
    }, now - 25_000);
    const signalAt = Math.floor((now - 20_000) / 1000);
    const native = crashNative(JSON.stringify({ v: 1, local: { 'anyreplay.vid': VISITOR }, session: {} }), `SIG\t11\t${signalAt}\n`, ring);
    const app = create(native);
    await app.init({ projectKey: KEY, ingestUrl: 'https://in.test', flushIntervalMs: 1_000_000, sampleRate: 0 });
    await turns();
    await vi.waitFor(() => expect(bodies.length).toBeGreaterThan(0));

    const clip = bodies[0]!;
    expect(clip).toMatchObject({ seq: 0, visitorId: VISITOR, meta: { kind: 'crash_clip', platform: 'capacitor', startedAt: now - 40_000 }, flags: { hasError: true } });
    expect(clip.sessionId).not.toBe(sessionStorage.getItem('anyreplay.sid'));
    const events = eventsOf(clip);
    expect(events.map((e) => e.type)).toEqual([4, 2, 3, 5]);
    expect(events[3]).toMatchObject({ timestamp: signalAt * 1000, data: { payload: { name: 'SIGSEGV', native: true, kind: 'fatal' } } });
    expect(Number(localStorage.getItem('anyreplay.clipAt'))).toBeGreaterThan(0);
  });

  it('no clip when the ring is more than a minute older than the crash', async () => {
    const bodies = mockFetch();
    const now = Date.now();
    const ring = serialiseRing({
      events: [{ type: 4, timestamp: now - 200_000, data: {} }, { type: 2, timestamp: now - 200_000, data: {} }],
      meta: { startedAt: now - 200_000 },
    });
    const native = crashNative(JSON.stringify({ v: 1, local: { 'anyreplay.vid': VISITOR }, session: {} }), swiftCrash(now - 100_000), ring);
    const app = create(native);
    await app.init({ projectKey: KEY, ingestUrl: 'https://in.test', flushIntervalMs: 1_000_000, sampleRate: 0 });
    await turns(40);
    expect(bodies).toEqual([]);
  });
});
