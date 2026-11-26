import { createHash } from 'node:crypto';
import { IPHONE, KEY, PNG, mockFetch, mockNative, turns, type MockNative } from './harness';
import { createAppRecorder, parseState, type AppRecorder } from '../src/shell';
import { SDK_NAME, SDK_VERSION } from '../src/version';

/**
 * The Capacitor plugin's JavaScript side, with the native half replaced by a
 * mock that behaves like the Swift and Kotlin code: it answers getInfo, keeps
 * one string, and fires pause/resume.
 *
 * The page is `https://localhost/` (vitest.config.ts) — where a Capacitor
 * app lives on Android; jsdom gives `capacitor://` an opaque origin with no
 * storage, which WKWebView does not, so iOS's address is covered by the
 * detection tests in packages/recorder — and the recorder underneath is the real
 * @anyreplay/browser with real rrweb, so what reaches `fetch` is what ingest
 * would receive.
 */

const state = vi.hoisted(() => ({ native: true }));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => state.native, isPluginAvailable: () => state.native },
  registerPlugin: () => ({}),
}));

// Imported after the mock, which vitest hoists above it.
const { capacitorBridge, AnyReplay } = await import('../src/index');

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

beforeEach(() => {
  state.native = true;
  localStorage.clear();
  sessionStorage.clear();
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(IPHONE);
  document.body.innerHTML = '<main><img src="/assets/logo.png" alt=""><h1>Sepet</h1><button id="pay">Öde</button></main>';
});

afterEach(() => {
  recorder?.stop();
  recorder = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the page it runs on', () => {
  it('is https://localhost, the address a Capacitor app has on Android', () => {
    expect(location.href).toBe('https://localhost/');
  });
});

describe('@anyreplay/capacitor', () => {
  it('names itself, the app and the device on the first chunk, and sends the app id on every one', async () => {
    const bodies = mockFetch();
    const native = mockNative();
    const app = create(native);
    await app.init({ projectKey: KEY, ingestUrl: 'https://in.test', flushIntervalMs: 1_000_000 });
    await turns();
    await app.flush();

    expect(app.status()).toBe('recording');
    expect(bodies[0]!.meta).toMatchObject({
      platform: 'capacitor',
      sdk: { name: '@anyreplay/capacitor', version: SDK_VERSION },
      appVersion: '3.4.1',
      deviceModel: 'iPhone15,2',
      url: 'https://localhost/',
    });
    expect(bodies.every((body) => body.appId === 'com.example.shop')).toBe(true);
  });

  it('prefers an appId the app passes over the one the native side reads', async () => {
    const bodies = mockFetch();
    const app = create(mockNative());
    await app.init({ projectKey: KEY, ingestUrl: 'https://in.test', flushIntervalMs: 1_000_000, appId: 'com.example.beta' });
    await app.flush();
    expect(bodies[0]!.appId).toBe('com.example.beta');
  });

  it('carries the app\'s own images, uploaded by hash', async () => {
    const bodies = mockFetch();
    const app = create(mockNative());
    await app.init({ projectKey: KEY, ingestUrl: 'https://in.test', flushIntervalMs: 1_000_000 });
    await turns();
    await app.flush();

    const assets = bodies.flatMap((b) => b.events as { type: number; data?: { tag?: string; payload?: unknown } }[])
      .filter((e) => e.type === 5 && e.data?.tag === 'anyreplay.asset')
      .map((e) => e.data!.payload);
    expect(assets).toEqual([{ url: 'https://localhost/assets/logo.png', sha256: createHash('sha256').update(PNG).digest('hex') }]);
  });

  it('applies calls made before init finished, in order', async () => {
    const bodies = mockFetch();
    const app = create(mockNative());
    const ready = app.init({ projectKey: KEY, ingestUrl: 'https://in.test', flushIntervalMs: 1_000_000, requireConsent: true });
    app.consent(true);
    app.track('booted');
    expect(app.status()).toBe('idle');
    await ready;
    await app.flush();
    expect(app.status()).toBe('recording');
    expect(JSON.stringify(bodies)).toContain('booted');
  });

  it('ignores a second init', async () => {
    mockFetch();
    const native = mockNative();
    const app = create(native);
    const first = app.init({ projectKey: KEY, ingestUrl: 'https://in.test' });
    expect(app.init({ projectKey: KEY, ingestUrl: 'https://other.test' })).toBe(first);
    await first;
    expect(native.getInfo).toHaveBeenCalledTimes(1);
  });

  it('reports a wrong key instead of throwing into the app', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = create(mockNative());
    await expect(app.init({ projectKey: 'nope' })).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('projectKey'));
    expect(app.status()).toBe('idle');
  });

  it('still records in a desktop browser, where there is no native side', async () => {
    state.native = false;
    const bodies = mockFetch();
    const app = create(mockNative());
    await app.init({ projectKey: KEY, ingestUrl: 'https://in.test', flushIntervalMs: 1_000_000 });
    await app.flush();
    expect(bodies[0]!.meta).toMatchObject({ platform: 'capacitor' });
    expect(bodies[0]!.appId).toBeUndefined();
  });

  it('exports a ready instance', () => {
    expect(typeof AnyReplay.init).toBe('function');
    expect(AnyReplay.status()).toBe('idle');
  });
});

describe('storage that outlives the web view', () => {
  it('mirrors the recorder\'s keys into native storage', async () => {
    mockFetch();
    const native = mockNative();
    const app = create(native);
    await app.init({ projectKey: KEY, ingestUrl: 'https://in.test', flushIntervalMs: 1_000_000 });
    await app.flush();

    const saved = parseState(native.stored)!;
    expect(saved.local['anyreplay.vid']).toBe(localStorage.getItem('anyreplay.vid'));
    expect(saved.session['anyreplay.sid']).toBe(app.sessionId());
    // Nothing that is not ours.
    localStorage.setItem('other.key', 'x');
    await app.flush();
    expect(native.stored).not.toContain('other.key');
  });

  it('brings back a visitor and a session the web view lost', async () => {
    const bodies = mockFetch();
    const sessionId = '3f1c2a4e-8b7d-4c3e-9a1b-2c3d4e5f6a7b';
    const saved = JSON.stringify({
      v: 1,
      local: { 'anyreplay.vid': 'v0123456789abcdef01234567' },
      session: { 'anyreplay.sid': sessionId, 'anyreplay.sts': String(Date.now() - 60_000), 'anyreplay.seq': '7', 'anyreplay.pc': '2' },
    });
    const app = create(mockNative(saved));
    await app.init({ projectKey: KEY, ingestUrl: 'https://in.test', flushIntervalMs: 1_000_000 });
    await app.flush();

    expect(bodies[0]).toMatchObject({ visitorId: 'v0123456789abcdef01234567', sessionId, seq: 7 });
  });

  it('copies a reserved chunk number to native storage before the chunk leaves', async () => {
    // On an iOS simulator an app killed between a send and the next periodic
    // copy came back with the old number and re-sent it (SEQ-005); the
    // interval here is far too long to be what saves it.
    const bodies = mockFetch();
    const native = mockNative();
    const sent = vi.mocked(fetch).getMockImplementation()!;
    const savedSeqAtSend: (string | undefined)[] = [];
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url).endsWith('/v1/ingest/events')) {
        savedSeqAtSend.push(parseState(native.stored)?.session['anyreplay.seq']);
      }
      return sent(url, init);
    });
    const app = create(native);
    await app.init({ projectKey: KEY, ingestUrl: 'https://in.test', flushIntervalMs: 1_000_000 });
    await app.flush();
    app.track('second');
    await app.flush();

    expect(bodies.map((body) => body.seq)).toEqual([0, 1]);
    expect(savedSeqAtSend).toEqual(['1', '2']);
  });

  it('does not mix an older copy into storage that is still there', async () => {
    mockFetch();
    localStorage.setItem('anyreplay.vid', 'vaaaaaaaaaaaaaaaaaaaaaaaa');
    const app = create(mockNative(JSON.stringify({ v: 1, local: { 'anyreplay.vid': 'vbbbbbbbbbbbbbbbbbbbbbbbb' }, session: {} })));
    await app.init({ projectKey: KEY, ingestUrl: 'https://in.test', flushIntervalMs: 1_000_000 });
    expect(localStorage.getItem('anyreplay.vid')).toBe('vaaaaaaaaaaaaaaaaaaaaaaaa');
  });

  it('forgets the native copy when consent is refused', async () => {
    mockFetch();
    const native = mockNative();
    const app = create(native);
    await app.init({ projectKey: KEY, ingestUrl: 'https://in.test', flushIntervalMs: 1_000_000 });
    await app.flush();
    expect(native.stored).not.toBeNull();

    app.consent(false);
    await turns(3);
    expect(native.stored).toBeNull();
    expect(localStorage.getItem('anyreplay.vid')).toBeNull();
  });
});

describe('the app lifecycle', () => {
  it('flushes on pause, saves, and tells the native side it is done', async () => {
    const bodies = mockFetch();
    const native = mockNative();
    const app = create(native);
    await app.init({ projectKey: KEY, ingestUrl: 'https://in.test', flushIntervalMs: 1_000_000 });
    await turns();
    const writes = native.writes.length;

    native.fire('pause');
    await turns(5);
    expect(bodies.length).toBeGreaterThan(0);
    expect(native.writes.length).toBeGreaterThan(writes);
    expect(native.pauseHandled).toHaveBeenCalledTimes(1);
  });

  it('retries on resume', async () => {
    const bodies = mockFetch();
    const native = mockNative();
    const app = create(native);
    await app.init({ projectKey: KEY, ingestUrl: 'https://in.test', flushIntervalMs: 1_000_000 });
    native.fire('resume');
    await turns(5);
    expect(bodies.length).toBeGreaterThan(0);
  });
});
