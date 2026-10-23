import { createHash } from 'node:crypto';
import {
  ASSET_LIMITS, AssetCollector, defaultAssetMode, localAssetPrefix, sha256Hex, sha256HexSync, toBase64,
  type AssetPayload,
} from '../src/assets';
import { resolveOptions } from '../src/config';

const KEY = 'ar_pk_live_0123456789abcdef01234567';

const at = (href: string) => {
  const url = new URL(href);
  return { protocol: url.protocol, host: url.host, hostname: url.hostname, pathname: url.pathname };
};

describe('which pages carry their own files', () => {
  it.each([
    ['capacitor://localhost/home', 'inline'],
    ['ionic://localhost/', 'inline'],
    ['app://localhost/index.html', 'inline'],
    ['tauri://localhost/', 'inline'],
    ['file:///Applications/Shop.app/Contents/Resources/index.html', 'inline'],
    // A website on the developer's own machine keeps its references: its
    // images are not the project's to store. The shells that serve an app
    // from these addresses pass 'inline' themselves.
    ['https://localhost/', 'reference'],
    ['http://localhost:8100/tabs', 'reference'],
    ['http://127.0.0.1:5173/', 'reference'],
    ['http://[::1]:3000/', 'reference'],
    ['http://tauri.localhost/', 'reference'],
    ['https://shop.example.com/cart', 'reference'],
    ['http://192.168.1.20:8100/', 'reference'],
  ])('%s → %s', (href, mode) => {
    expect(defaultAssetMode(at(href))).toBe(mode);
  });

  it('looks only under the page origin, and under its own folder for file:', () => {
    expect(localAssetPrefix(at('capacitor://localhost/home'))).toBe('capacitor://localhost/');
    expect(localAssetPrefix(at('https://localhost/tabs/one'))).toBe('https://localhost/');
    expect(localAssetPrefix(at('http://localhost:8100/'))).toBe('http://localhost:8100/');
    expect(localAssetPrefix(at('file:///opt/app/www/index.html'))).toBe('file:///opt/app/www/');
  });

  it('is an option a page can set, and a typo falls back to the default with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(resolveOptions({ projectKey: KEY, assets: 'reference' }).assets).toBe('reference');
    expect(resolveOptions({ projectKey: KEY, assets: 'inline' }).assets).toBe('inline');
    // jsdom's page is http://localhost:3000: a website on a developer's machine.
    expect(resolveOptions({ projectKey: KEY }).assets).toBe('reference');
    expect(resolveOptions({ projectKey: KEY, assets: 'always' as never }).assets).toBe('reference');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('assets ignored'));
    warn.mockRestore();
  });
});

describe('sha256', () => {
  it('matches Node for empty, short, block-sized and long inputs', async () => {
    for (const length of [0, 3, 55, 56, 63, 64, 65, 1000, 70_000]) {
      const bytes = new Uint8Array(length).map((_, i) => (i * 31 + 7) & 0xff);
      const expected = createHash('sha256').update(bytes).digest('hex');
      expect(sha256HexSync(bytes), `length ${length}`).toBe(expected);
      expect(await sha256Hex(bytes), `length ${length}`).toBe(expected);
    }
  });

  it('encodes base64 the standard way', () => {
    const bytes = new Uint8Array(100_000).map((_, i) => i & 0xff);
    expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
  });
});

/* ------------------------------------------------------------ collector -- */

const PREFIX = 'capacitor://localhost/';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

interface Harness {
  collector: AssetCollector;
  emitted: AssetPayload[];
  requests: { url: string; body?: Record<string, unknown> }[];
}

function harness(files: Record<string, Uint8Array>, options: { known?: string[]; knownStatus?: number; uploadStatus?: number; limits?: Partial<typeof ASSET_LIMITS> } = {}): Harness {
  const emitted: AssetPayload[] = [];
  const requests: Harness['requests'] = [];
  const fetchStub = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    requests.push({ url, body });
    if (url.endsWith('/v1/ingest/assets/known')) {
      if (options.knownStatus) return new Response('{"error":{"code":"app_not_allowed"}}', { status: options.knownStatus });
      return new Response(JSON.stringify({ known: options.known ?? [] }), { status: 200 });
    }
    if (url.endsWith('/v1/ingest/assets')) {
      return new Response('{}', { status: options.uploadStatus ?? 201 });
    }
    const file = files[url];
    return file ? new Response(file, { status: 200 }) : new Response('nope', { status: 404 });
  });
  const collector = new AssetCollector({
    prefix: PREFIX, ingestUrl: 'https://in.test', projectKey: KEY, appId: 'com.example.shop',
    fetch: fetchStub as unknown as typeof fetch, emit: (p) => emitted.push(p), limits: options.limits,
  });
  return { collector, emitted, requests };
}

/** A full snapshot in rrweb's shape, with the URLs where rrweb puts them. */
const snapshot = (...strings: string[]) => ({
  type: 2,
  timestamp: 1,
  data: {
    node: {
      type: 0, id: 1, childNodes: strings.map((value, i) => ({
        type: 2, id: i + 2, tagName: 'div', attributes: { 'data-x': value }, childNodes: [],
      })),
    },
  },
});

describe('the asset collector', () => {
  it('uploads an image the project does not have, then maps its URL to the hash', async () => {
    const { collector, emitted, requests } = harness({ [`${PREFIX}assets/logo.png`]: PNG });
    collector.scan(snapshot(`${PREFIX}assets/logo.png`));
    await collector.idle();

    const sha256 = createHash('sha256').update(PNG).digest('hex');
    expect(emitted).toEqual([{ url: `${PREFIX}assets/logo.png`, sha256 }]);
    const known = requests.find((r) => r.url.endsWith('/known'))!;
    expect(known.body).toEqual({ projectKey: KEY, hashes: [sha256], appId: 'com.example.shop' });
    const upload = requests.find((r) => r.url.endsWith('/v1/ingest/assets'))!;
    expect(upload.body).toEqual({ projectKey: KEY, sha256, data: Buffer.from(PNG).toString('base64'), appId: 'com.example.shop' });
  });

  it('asks before uploading, and does not upload what the project already holds', async () => {
    const sha256 = createHash('sha256').update(PNG).digest('hex');
    const { collector, emitted, requests } = harness({ [`${PREFIX}a.png`]: PNG }, { known: [sha256] });
    collector.scan(snapshot(`${PREFIX}a.png`));
    await collector.idle();
    expect(emitted).toEqual([{ url: `${PREFIX}a.png`, sha256 }]);
    expect(requests.some((r) => r.url.endsWith('/v1/ingest/assets'))).toBe(false);
  });

  it('leaves an image out when ingest refuses it', async () => {
    const { collector, emitted } = harness({ [`${PREFIX}a.png`]: PNG }, { uploadStatus: 415 });
    collector.scan(snapshot(`${PREFIX}a.png`));
    await collector.idle();
    expect(emitted).toEqual([]);
  });

  it('uploads nothing, and reads no more files, once ingest refuses to say what it holds', async () => {
    const { collector, emitted, requests } = harness(
      { [`${PREFIX}a.png`]: PNG, [`${PREFIX}b.png`]: PNG.slice(1) },
      { knownStatus: 403 },
    );
    collector.scan(snapshot(`${PREFIX}a.png`, `${PREFIX}b.png`));
    await collector.idle();
    expect(emitted).toEqual([]);
    expect(requests.some((r) => r.url.endsWith('/v1/ingest/assets'))).toBe(false);
    expect(requests.filter((r) => r.url.endsWith('/known'))).toHaveLength(1);
    expect(requests.some((r) => r.url === `${PREFIX}b.png`)).toBe(false);
  });

  it('gives up on one image, not the rest, when asking fails for another reason', async () => {
    const { collector, emitted, requests } = harness(
      { [`${PREFIX}a.png`]: PNG, [`${PREFIX}b.png`]: PNG.slice(1) },
      { knownStatus: 503 },
    );
    collector.scan(snapshot(`${PREFIX}a.png`, `${PREFIX}b.png`));
    await collector.idle();
    expect(emitted).toEqual([]);
    expect(requests.some((r) => r.url.endsWith('/v1/ingest/assets'))).toBe(false);
    expect(requests.filter((r) => r.url.endsWith('/known'))).toHaveLength(2);
  });

  it('finds URLs inside CSS, srcset and inline styles, each once', async () => {
    const font = new Uint8Array(2000).fill(7);
    const { collector, emitted } = harness({
      [`${PREFIX}fonts/inter.woff2`]: font,
      [`${PREFIX}img/a.webp`]: PNG,
      [`${PREFIX}img/b.gif`]: PNG,
    });
    collector.scan(snapshot(
      `@font-face { font-family: Inter; src: url("${PREFIX}fonts/inter.woff2") format("woff2"); }`,
      `${PREFIX}img/a.webp 1x, ${PREFIX}img/b.gif 2x`,
      `background-image: url(${PREFIX}img/a.webp)`,
    ));
    // The same URL in a later mutation is not read again.
    collector.scan({ type: 3, timestamp: 2, data: { source: 0, adds: [], removes: [], texts: [], attributes: [{ id: 2, attributes: { src: `${PREFIX}img/a.webp` } }] } });
    await collector.idle();

    expect(emitted.map((p) => p.url).sort()).toEqual([`${PREFIX}fonts/inter.woff2`, `${PREFIX}img/a.webp`, `${PREFIX}img/b.gif`]);
    const inline = emitted.find((p) => p.url.endsWith('.woff2')) as { data: string };
    expect(inline.data).toBe(`data:font/woff2;base64,${Buffer.from(font).toString('base64')}`);
  });

  it('never reads the device-file bridges, other origins, or files it cannot show', async () => {
    const { collector, requests } = harness({});
    collector.scan(snapshot(
      `${PREFIX}_capacitor_file_/var/mobile/photo.jpg`,
      'https://localhost/__cdvfile_files__/photo.jpg',
      `${PREFIX}__cdvfile_cache__/x.png`,
      'https://cdn.example.com/hero.png',
      `${PREFIX}main.js`,
      `${PREFIX}api/user.json`,
    ));
    await collector.idle();
    expect(requests).toEqual([]);
  });

  it('ignores the event types that carry no page files', async () => {
    const { collector, requests } = harness({ [`${PREFIX}a.png`]: PNG });
    collector.scan({ type: 5, timestamp: 1, data: { tag: 'anyreplay.track', payload: { name: 'x', properties: { u: `${PREFIX}a.png` } } } });
    collector.scan({ type: 3, timestamp: 1, data: { source: 5, id: 3, text: `${PREFIX}a.png` } });
    await collector.idle();
    expect(requests).toEqual([]);
  });

  it('keeps inline files under their caps and the page budget', async () => {
    const big = new Uint8Array(ASSET_LIMITS.maxFontBytes + 1);
    const svg = new Uint8Array(ASSET_LIMITS.maxSvgBytes + 1);
    const ok = new Uint8Array(600);
    const { collector, emitted } = harness({
      [`${PREFIX}big.woff2`]: big,
      [`${PREFIX}icon.svg`]: svg,
      [`${PREFIX}one.woff`]: ok,
      [`${PREFIX}two.ttf`]: ok,
    }, { limits: { inlineBudgetBytes: 1000 } });
    collector.scan(snapshot(`${PREFIX}big.woff2`, `${PREFIX}icon.svg`, `${PREFIX}one.woff`, `${PREFIX}two.ttf`));
    await collector.idle();
    // The first small font fits the budget; the second would pass it.
    expect(emitted.map((p) => p.url)).toEqual([`${PREFIX}one.woff`]);
  });

  it('keeps every inline event alone under the transport target', () => {
    const base64 = Math.ceil(ASSET_LIMITS.maxFontBytes / 3) * 4;
    expect(base64 + 1024).toBeLessThan(256 * 1024);
  });

  it('stops looking after the per-page URL limit, and after stop()', async () => {
    const { collector, requests } = harness({}, { limits: { maxUrls: 2 } });
    collector.scan(snapshot(`${PREFIX}1.png`, `${PREFIX}2.png`, `${PREFIX}3.png`));
    await collector.idle();
    expect(requests.filter((r) => r.url.startsWith(PREFIX)).map((r) => r.url)).toEqual([`${PREFIX}1.png`, `${PREFIX}2.png`]);

    const second = harness({ [`${PREFIX}a.png`]: PNG });
    second.collector.stop();
    second.collector.scan(snapshot(`${PREFIX}a.png`));
    await second.collector.idle();
    expect(second.requests).toEqual([]);
  });
});
