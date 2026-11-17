import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The Cordova plugin's JavaScript, with `cordova.exec` replaced by a mock that
 * behaves like the Objective-C and Java classes in native/. The recorder
 * underneath is the real @anyreplay/browser with real rrweb.
 */

const KEY = 'ar_pk_live_0123456789abcdef01234567';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.0.0 Mobile Safari/537.36';

interface Exec {
  calls: { action: string; args: unknown[] }[];
  stored: string | null;
}

function installCordova(): Exec {
  const exec: Exec = { calls: [], stored: null };
  (globalThis as { cordova?: unknown }).cordova = {
    exec: (success: (value?: unknown) => void, _fail: (error: unknown) => void, service: string, action: string, args: unknown[]) => {
      expect(service).toBe('AnyReplay');
      exec.calls.push({ action, args });
      setTimeout(() => {
        if (action === 'getInfo') success({ appId: 'com.example.shop', appVersion: '2.0.1', build: '201', deviceModel: 'Google Pixel 8' });
        else if (action === 'readState') success(exec.stored ?? undefined);
        else if (action === 'writeState') { exec.stored = (args[0] as string | null) ?? null; success(); }
      }, 0);
    },
  };
  return exec;
}

function mockFetch() {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/v1/ingest/events')) bodies.push(JSON.parse(String(init!.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ accepted: true, duplicate: false }), { status: 202 });
  }));
  return bodies;
}

const fresh = async () => {
  vi.resetModules();
  return import('../src/index');
};

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ANDROID);
  document.body.innerHTML = '<main><h1>Sepet</h1><button id="pay">Öde</button></main>';
});

afterEach(() => {
  delete (globalThis as { cordova?: unknown }).cordova;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('@anyreplay/cordova', () => {
  it('waits for deviceready, then records as a Cordova app with the native app id', async () => {
    const exec = installCordova();
    const bodies = mockFetch();
    const AnyReplay = await fresh();

    const ready = AnyReplay.init({ projectKey: KEY, ingestUrl: 'https://in.test', flushIntervalMs: 1_000_000 });
    await new Promise((r) => setTimeout(r, 5));
    expect(exec.calls).toEqual([]);
    document.dispatchEvent(new Event('deviceready'));
    await ready;
    AnyReplay.track('cart_viewed');
    await AnyReplay.flush();

    expect(AnyReplay.status()).toBe('recording');
    expect(bodies[0]!.meta).toMatchObject({
      platform: 'cordova',
      sdk: { name: '@anyreplay/cordova', version: AnyReplay.SDK_VERSION },
      appVersion: '2.0.1',
      deviceModel: 'Google Pixel 8',
    });
    expect(bodies.every((body) => body.appId === 'com.example.shop')).toBe(true);
    AnyReplay.stop();
  });

  it('mirrors its keys through writeState and restores them through readState', async () => {
    const exec = installCordova();
    exec.stored = JSON.stringify({ v: 1, local: { 'anyreplay.vid': 'v0123456789abcdef01234567' }, session: {} });
    const bodies = mockFetch();
    const AnyReplay = await fresh();
    const ready = AnyReplay.init({ projectKey: KEY, ingestUrl: 'https://in.test', flushIntervalMs: 1_000_000 });
    document.dispatchEvent(new Event('deviceready'));
    await ready;
    await AnyReplay.flush();

    expect(bodies[0]!.visitorId).toBe('v0123456789abcdef01234567');
    expect(exec.calls.some((c) => c.action === 'writeState')).toBe(true);
    expect(JSON.parse(exec.stored!).session['anyreplay.sid']).toBe(AnyReplay.sessionId());

    AnyReplay.consent(false);
    await new Promise((r) => setTimeout(r, 5));
    expect(exec.stored).toBeNull();
  });

  it('flushes on Cordova\'s pause event', async () => {
    installCordova();
    const bodies = mockFetch();
    const AnyReplay = await fresh();
    const ready = AnyReplay.init({ projectKey: KEY, ingestUrl: 'https://in.test', flushIntervalMs: 1_000_000 });
    document.dispatchEvent(new Event('deviceready'));
    await ready;
    expect(bodies).toEqual([]);
    document.dispatchEvent(new Event('pause'));
    await new Promise((r) => setTimeout(r, 10));
    expect(bodies.length).toBeGreaterThan(0);
    AnyReplay.stop();
  });

  it('records without native help outside Cordova', async () => {
    const bodies = mockFetch();
    const AnyReplay = await fresh();
    await AnyReplay.init({ projectKey: KEY, ingestUrl: 'https://in.test', flushIntervalMs: 1_000_000 });
    await AnyReplay.flush();
    expect(bodies[0]!.meta).toMatchObject({ platform: 'cordova' });
    expect(bodies[0]!.appId).toBeUndefined();
    AnyReplay.stop();
  });
});

describe('the plugin manifest', () => {
  const root = resolve(__dirname, '..');
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
    name: string; version: string; cordova: { id: string }; files: string[];
  };
  const xml = readFileSync(resolve(root, 'plugin.xml'), 'utf8');

  it('names the same plugin and version as package.json', () => {
    expect(xml).toContain(`id="${manifest.name}"`);
    expect(xml).toMatch(new RegExp(`<plugin[^>]*version="${manifest.version.replace(/\./g, '\\.')}"`));
    expect(manifest.cordova.id).toBe(manifest.name);
  });

  it('points at files that exist and are published', () => {
    const sources = [...xml.matchAll(/src="([^"]+)"/g)].map((m) => m[1]!);
    expect(sources).toContain('dist/anyreplay.js');
    for (const source of sources.filter((s) => s.startsWith('native/'))) {
      expect(() => readFileSync(resolve(root, source)), source).not.toThrow();
    }
    expect(manifest.files).toEqual(expect.arrayContaining(['plugin.xml', 'dist/anyreplay.js', 'native']));
  });
});
