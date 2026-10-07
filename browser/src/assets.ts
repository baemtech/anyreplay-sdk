import type { RecordedEvent } from './transport.js';

/**
 * Making a recording carry the files a page loaded from inside an app.
 *
 * A website's replay loads its stylesheets, fonts and images from the site,
 * later, in the reviewer's browser: the snapshot records `https://shop.com/
 * logo.png` and the dashboard asks shop.com for it. That is `'reference'`, and
 * it is right for anything on a public origin.
 *
 * A page inside an app has no such origin. Capacitor serves the app from
 * `capacitor://localhost` (iOS) or `https://localhost` (Android), Cordova from
 * `app://localhost`, `https://localhost` or `file://`, Ionic's older shells
 * from `ionic://localhost`, Tauri from `tauri://localhost`, Electron often from
 * `file://`. Those addresses mean "inside this phone" — no reviewer can load
 * them — so the replay came out as bare HTML.
 *
 * `'inline'` makes the recording carry what it needs instead:
 *
 * - **Stylesheets** were already inside it: rrweb copies every readable
 *   stylesheet into the snapshot as text (`inlineStylesheet`, on in both
 *   modes), and an app's own CSS is always readable.
 * - **Images** (PNG, JPEG, GIF, WebP) are uploaded once per project by
 *   content hash through the same routes the native SDKs use (contract §9),
 *   at most 3 MB each, and the session says which file stood at which URL.
 * - **Fonts** (WOFF2, WOFF, TTF, OTF) and **SVG images** cannot be uploaded —
 *   ingest stores raster images only — so they travel inside the recording as
 *   `data:` URLs, each in its own event, under a per-file cap and a per-page
 *   budget that keep every chunk inside the transport's 256 KB target.
 *
 * In both cases the recording keeps the original URL wherever the page used
 * it, and an `anyreplay.asset` custom event maps that URL to the uploaded
 * hash or to the inline data. The dashboard's player rewrites those URLs
 * before it builds the replay. Nothing in the DOM snapshot is changed, so a
 * recording made with this on replays exactly as before in a player that does
 * not know about it — unstyled, as it always was.
 *
 * Only the app's own files are read: URLs under the page's own origin (for
 * `file://`, under the page's own folder). Capacitor's and Cordova's bridges
 * to the device's files (`/_capacitor_file_/…`, `/__cdvfile_…`) are excluded
 * by path, because what they serve is the user's photos and downloads, not
 * the app. Anything that fails — a fetch, an upload, a cap — leaves that one
 * file as it was: missing from the replay, and nothing else.
 */

export type AssetMode = 'reference' | 'inline';

/** The custom event that maps a URL the page used to the file that was there. */
export const ASSET_TAG = 'anyreplay.asset';

/** `{ url, sha256 }` for an uploaded image, `{ url, data }` for a file carried inline. */
export type AssetPayload = { url: string; sha256: string } | { url: string; data: string };

export interface AssetLimits {
  /** An image larger than this is not uploaded (ingest's own limit). */
  maxImageBytes: number;
  /** A font larger than this is not carried inline. */
  maxFontBytes: number;
  /** An SVG larger than this is not carried inline. */
  maxSvgBytes: number;
  /** All inline files of one page together, before base64. */
  inlineBudgetBytes: number;
  /** Distinct URLs looked at per page; anything after is left as it is. */
  maxUrls: number;
}

/**
 * The caps, and why each is what it is.
 *
 * A font of 160 KB is 214 KB as base64: alone in its chunk with the envelope
 * it stays under the transport's 256 KB target, so no chunk is ever built
 * around something ingest could refuse. Almost every WOFF2 an app ships is
 * well under it; an icon font or a CJK font that is not is left out, and the
 * replay falls back to the next font in the stack. One megabyte across a page
 * is about six fonts and a few icons, which is more than an app uses, and
 * small enough that a page with a hundred SVG icons does not turn its first
 * minute into a download.
 */
export const ASSET_LIMITS: AssetLimits = {
  maxImageBytes: 3 * 1024 * 1024,
  maxFontBytes: 160 * 1024,
  maxSvgBytes: 48 * 1024,
  inlineBudgetBytes: 1024 * 1024,
  maxUrls: 300,
};

interface LocationLike {
  protocol: string;
  host: string;
  hostname: string;
  pathname: string;
}

/**
 * What `assets` is when the page does not say.
 *
 * `'inline'` for any scheme that is not `http:` or `https:` — `capacitor:`,
 * `ionic:`, `app:`, `tauri:`, `file:` and whatever a shell invents next. No
 * website is served that way, so nobody outside the device could load the
 * page's own files.
 *
 * `'reference'` for every `http(s)` page, `localhost` included. A developer
 * trying their website on `http://localhost:3000` should not upload its
 * images into the project's quota — the replay of a page on their own machine
 * loads fine on that machine. The shells that serve an app from an
 * `http(s)://localhost` address (Capacitor and Cordova on Android, Tauri on
 * Windows) say `'inline'` themselves: `@anyreplay/capacitor`,
 * `@anyreplay/cordova` and `@anyreplay/tauri` pass it, and so does
 * `@anyreplay/electron`.
 */
export function defaultAssetMode(loc: LocationLike | undefined = currentLocation()): AssetMode {
  if (!loc) return 'reference';
  const protocol = loc.protocol.toLowerCase();
  return protocol === 'http:' || protocol === 'https:' ? 'reference' : 'inline';
}

/**
 * The start every URL of the app's own files shares, or null when there is
 * nothing to look for.
 *
 * `scheme://host/` for anything with a host. For `file:` it is the page's own
 * folder: `file://` alone would match every file on the disk, and an Electron
 * app showing a document the user opened must not upload that document.
 */
export function localAssetPrefix(loc: LocationLike | undefined = currentLocation()): string | null {
  if (!loc) return null;
  const protocol = loc.protocol.toLowerCase();
  if (protocol === 'file:') {
    const folder = loc.pathname.slice(0, loc.pathname.lastIndexOf('/') + 1);
    return folder ? `file://${folder}` : null;
  }
  if (!loc.host) return null;
  return `${protocol}//${loc.host}/`;
}

function currentLocation(): LocationLike | undefined {
  try {
    return typeof location !== 'undefined' ? location : undefined;
  } catch {
    return undefined;
  }
}

type Kind = { kind: 'image' } | { kind: 'inline'; mime: string; cap: keyof AssetLimits };

/** What a URL is, from its extension. Anything not listed is left alone. */
function classify(url: string): Kind | null {
  const path = url.split(/[?#]/, 1)[0]!.toLowerCase();
  const ext = path.slice(path.lastIndexOf('.') + 1);
  switch (ext) {
    case 'png': case 'jpg': case 'jpeg': case 'gif': case 'webp':
      return { kind: 'image' };
    case 'svg':
      return { kind: 'inline', mime: 'image/svg+xml', cap: 'maxSvgBytes' };
    case 'woff2': return { kind: 'inline', mime: 'font/woff2', cap: 'maxFontBytes' };
    case 'woff': return { kind: 'inline', mime: 'font/woff', cap: 'maxFontBytes' };
    case 'ttf': return { kind: 'inline', mime: 'font/ttf', cap: 'maxFontBytes' };
    case 'otf': return { kind: 'inline', mime: 'font/otf', cap: 'maxFontBytes' };
    default:
      return null;
  }
}

/**
 * The bridges Capacitor and Cordova put in front of the device's own files.
 * `Capacitor.convertFileSrc()` gives `/_capacitor_file_/…` (and
 * `_capacitor_content_` for Android content URIs); cordova-android's asset
 * loader serves `/__cdvfile_files__/…` and its siblings. Those are the user's
 * pictures, never the app's.
 */
const DEVICE_FILE_PATH = /^(_capacitor_|__cdvfile_)/;

/** rrweb's event types and incremental sources that can carry a URL of the page's files. */
const EVENT_FULL_SNAPSHOT = 2;
const EVENT_INCREMENTAL = 3;
const SOURCES_WITH_URLS = new Set([
  0, // Mutation: added nodes, changed attributes (`src`, `style`, `srcset`)
  8, // StyleSheetRule: a rule inserted with insertRule
  13, // StyleDeclaration: a property set through CSSOM
  15, // AdoptedStyleSheet: constructed stylesheets (Ionic's web components)
]);

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface AssetCollectorDeps {
  /** From `localAssetPrefix`. */
  prefix: string;
  ingestUrl: string;
  projectKey: string;
  appId?: string;
  /** Hands an `anyreplay.asset` payload to the recording. */
  emit: (payload: AssetPayload) => void;
  /**
   * The `fetch` to read files and talk to ingest with. Taken before the
   * network diagnostics wrap the page's own, so reading the app's files does
   * not appear in the replay's network panel as if the app had done it.
   */
  fetch: typeof fetch;
  limits?: Partial<AssetLimits>;
  debug?: boolean;
}

/**
 * Finds the app's own files in what rrweb emits and makes each one available
 * to the replay, once per page.
 *
 * `scan` runs inside rrweb's emit and never waits: it only notes URLs. The
 * work — reading a file, hashing it, asking ingest, uploading — happens in the
 * background one file at a time, and the mapping is emitted when it is done.
 * The mapping can therefore land seconds after the snapshot that used the URL;
 * the player reads the whole session before it builds the replay, so order
 * does not matter. A recording must never stall on a network call.
 */
export class AssetCollector {
  private readonly limits: AssetLimits;
  private readonly pattern: RegExp;
  private readonly seen = new Set<string>();
  private readonly queue: string[] = [];
  /** Hashes ingest confirmed this page, so two URLs with the same bytes ask once. */
  private readonly confirmed = new Set<string>();
  private inlineSpent = 0;
  private running = false;
  private stopped = false;

  constructor(private readonly deps: AssetCollectorDeps) {
    this.limits = { ...ASSET_LIMITS, ...deps.limits };
    // Up to the first character that cannot be inside a URL in an attribute,
    // a srcset or a CSS `url(…)`. A URL with a comma or a parenthesis in its
    // path is missed; app bundlers do not produce those.
    this.pattern = new RegExp(`${escapeRegExp(deps.prefix)}[^\\s"'()<>,\\\\]+`, 'g');
  }

  /** Notes every URL of the app's files in one event. Cheap when there are none. */
  scan(event: RecordedEvent): void {
    if (this.stopped) return;
    if (event.type === EVENT_FULL_SNAPSHOT) {
      this.walk(event.data, 0);
    } else if (event.type === EVENT_INCREMENTAL) {
      const source = (event.data as { source?: number } | undefined)?.source;
      if (source !== undefined && SOURCES_WITH_URLS.has(source)) this.walk(event.data, 0);
    }
  }

  stop(): void {
    this.stopped = true;
    this.queue.length = 0;
  }

  /** Resolves once everything queued so far has been handled. For tests. */
  async idle(): Promise<void> {
    while (this.running || this.queue.length > 0) await new Promise((resolve) => setTimeout(resolve, 1));
  }

  private walk(value: unknown, depth: number): void {
    // rrweb's trees are deep but not this deep; a cycle is not possible in
    // JSON-shaped events, the bound is only a guard against a pathological DOM.
    if (depth > 400 || value === null) return;
    if (typeof value === 'string') {
      if (value.length >= this.deps.prefix.length && value.includes(this.deps.prefix)) this.match(value);
      return;
    }
    if (typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) this.walk(item, depth + 1);
      return;
    }
    for (const key in value as Record<string, unknown>) this.walk((value as Record<string, unknown>)[key], depth + 1);
  }

  private match(text: string): void {
    this.pattern.lastIndex = 0;
    for (const found of text.match(this.pattern) ?? []) {
      if (this.seen.has(found)) continue;
      if (this.seen.size >= this.limits.maxUrls) return;
      this.seen.add(found);
      if (DEVICE_FILE_PATH.test(found.slice(this.deps.prefix.length))) continue;
      if (!classify(found)) continue;
      this.queue.push(found);
    }
    if (this.queue.length > 0) void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0 && !this.stopped) {
        const url = this.queue.shift()!;
        try {
          const payload = await this.resolve(url);
          if (payload && !this.stopped) this.deps.emit(payload);
        } catch (error) {
          if (this.deps.debug) console.warn('[anyreplay] could not include', url, error);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async resolve(url: string): Promise<AssetPayload | null> {
    const kind = classify(url);
    if (!kind) return null;
    const response = await this.deps.fetch(url);
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length === 0) return null;

    if (kind.kind === 'inline') {
      if (bytes.length > this.limits[kind.cap]) return this.skip(url, 'over its size cap');
      if (this.inlineSpent + bytes.length > this.limits.inlineBudgetBytes) return this.skip(url, 'over the page budget');
      this.inlineSpent += bytes.length;
      return { url, data: `data:${kind.mime};base64,${toBase64(bytes)}` };
    }

    if (bytes.length > this.limits.maxImageBytes) return this.skip(url, 'larger than 3 MB');
    const sha256 = await sha256Hex(bytes);
    if (this.confirmed.has(sha256) || await this.upload(sha256, bytes)) {
      this.confirmed.add(sha256);
      return { url, sha256 };
    }
    return null;
  }

  /** Contract §9: ask first, upload only what the project does not hold. */
  private async upload(sha256: string, bytes: Uint8Array): Promise<boolean> {
    const { ingestUrl, projectKey, appId } = this.deps;
    const app = appId ? { appId } : {};
    const post = (path: string, body: unknown): Promise<Response> => this.deps.fetch(`${ingestUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'omit',
      body: JSON.stringify(body),
    });

    const known = await post('/v1/ingest/assets/known', { projectKey, hashes: [sha256], ...app });
    if (known.ok) {
      const body = await known.json() as { known?: unknown };
      if (Array.isArray(body.known) && body.known.includes(sha256)) return true;
    }
    // A 415 (not really an image), 413, 403 (quota) or 422 is an answer about
    // this file; it stays out of the replay and nothing is retried.
    const upload = await post('/v1/ingest/assets', { projectKey, sha256, data: toBase64(bytes), ...app });
    return upload.ok;
  }

  private skip(url: string, why: string): null {
    if (this.deps.debug) console.warn(`[anyreplay] not included in the replay (${why}): ${url}`);
    return null;
  }
}

/** Standard base64 with padding, in slices so a large file does not overflow the argument list. */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
  }
  return btoa(binary);
}

/**
 * SHA-256 as 64 lowercase hex digits: the file's address in the project.
 *
 * WebCrypto where the page has it. Not every app's web view does —
 * `crypto.subtle` exists only in a secure context, and whether a custom
 * scheme such as `capacitor://` counts as one has differed between WebKit
 * releases — so a plain implementation follows, checked against Node's in
 * the tests.
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  try {
    const subtle = typeof crypto !== 'undefined' ? crypto.subtle : undefined;
    if (subtle) {
      const digest = new Uint8Array(await subtle.digest('SHA-256', bytes));
      return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
    }
  } catch {
    /* fall through to the plain implementation */
  }
  return sha256HexSync(bytes);
}

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/** The same algorithm as packages/recorder-native/src/assets.ts, which has no WebCrypto at all. */
export function sha256HexSync(bytes: Uint8Array): string {
  const length = bytes.length;
  const padded = new Uint8Array(((length + 9 + 63) >>> 6) << 6);
  padded.set(bytes);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(length / 0x20000000));
  view.setUint32(padded.length - 4, (length << 3) >>> 0);

  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Array<number>(64);
  const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const a = w[i - 15]!;
      const b = w[i - 2]!;
      w[i] = (w[i - 16]! + (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) + w[i - 7]! + (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10))) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h as [number, number, number, number, number, number, number, number];
    for (let i = 0; i < 64; i += 1) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] = (h[0]! + a) | 0; h[1] = (h[1]! + b) | 0; h[2] = (h[2]! + c) | 0; h[3] = (h[3]! + d) | 0;
    h[4] = (h[4]! + e) | 0; h[5] = (h[5]! + f) | 0; h[6] = (h[6]! + g) | 0; h[7] = (h[7]! + hh) | 0;
  }
  return h.map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
}
