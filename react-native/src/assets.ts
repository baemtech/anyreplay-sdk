import type { KeyValueStore } from './session.js';

/**
 * Images the app ships inside itself.
 *
 * A reviewer's browser can load a photo from the app's CDN, but not a PNG
 * inside somebody's phone. So the recorder uploads each bundled image once per
 * project — content-addressed, checked against the server first, remembered on
 * the device — and the recording refers to it by hash. Every device of every
 * user converges on the same few uploads; after the first, recording an
 * onboarding screen costs a 64-character attribute.
 *
 * Only the app's own files qualify. A photo someone picked or took lives in
 * the app's caches or the photo library, not in its bundle, and is never read.
 */

/** Asset URLs of the app bundle, in development and in release builds. */
export function isBundledAsset(uri: string): boolean {
  // Metro's asset server during development.
  if (/^https?:\/\/(localhost|127\.0\.0\.1|10\.0\.2\.2)(:\d+)?\/assets\//i.test(uri)) return true;
  // iOS: files inside the installed .app bundle, on a device or a simulator.
  // Anchored on the bundle container, not on ".app/" alone — an Android package
  // directory such as /data/user/0/com.app/ contains that too.
  if (/^file:\/\/\/.*\/Bundle\/Application\/[^/]+\/[^/]+\.app\//.test(uri)) return true;
  // Android: the APK's assets.
  if (/^(asset:\/|file:\/\/\/android_asset\/)/.test(uri)) return true;
  return false;
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/**
 * SHA-256, in plain JavaScript.
 *
 * Hermes has no `crypto.subtle`, and a native module would mean a rebuild for
 * every app that installs this. The hash has to match the server's exactly —
 * it is the image's address — and the tests check it against Node's.
 */
export function sha256Hex(bytes: Uint8Array): string {
  const length = bytes.length;
  const padded = new Uint8Array(((length + 9 + 63) >>> 6) << 6);
  padded.set(bytes);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(length / 0x20000000));
  view.setUint32(padded.length - 4, (length << 3) >>> 0);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const a = w[i - 15]!;
      const b = w[i - 2]!;
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }

    let a = h[0]!; let b = h[1]!; let c = h[2]!; let d = h[3]!;
    let e = h[4]!; let f = h[5]!; let g = h[6]!; let hh = h[7]!;
    for (let i = 0; i < 64; i += 1) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (hh + s1 + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) | 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (s0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] = (h[0]! + a) | 0; h[1] = (h[1]! + b) | 0; h[2] = (h[2]! + c) | 0; h[3] = (h[3]! + d) | 0;
    h[4] = (h[4]! + e) | 0; h[5] = (h[5]! + f) | 0; h[6] = (h[6]! + g) | 0; h[7] = (h[7]! + hh) | 0;
  }

  let out = '';
  for (let i = 0; i < 8; i += 1) out += h[i]!.toString(16).padStart(8, '0');
  return out;
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Standard base64 with padding; no `btoa` on older Hermes, and `btoa` wants a binary string anyway. */
export function toBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  let chunk = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    chunk += ALPHABET[(n >>> 18) & 63]! + ALPHABET[(n >>> 12) & 63]! + ALPHABET[(n >>> 6) & 63]! + ALPHABET[n & 63]!;
    if (chunk.length >= 8192) { parts.push(chunk); chunk = ''; }
  }
  if (i < bytes.length) {
    const rest = bytes.length - i;
    const n = (bytes[i]! << 16) | ((rest === 2 ? bytes[i + 1]! : 0) << 8);
    chunk += ALPHABET[(n >>> 18) & 63]! + ALPHABET[(n >>> 12) & 63]!
      + (rest === 2 ? ALPHABET[(n >>> 6) & 63]! : '=') + '=';
  }
  parts.push(chunk);
  return parts.join('');
}

export interface AssetUploaderDeps {
  ingestUrl: string;
  projectKey: string;
  fetch: typeof fetch;
  /** Reads an asset's bytes. On React Native this is an arraybuffer XHR. */
  readBytes: (uri: string) => Promise<Uint8Array>;
  store?: KeyValueStore;
  /** Larger files are not uploaded; the image replays as a placeholder. */
  maxBytes?: number;
  debug?: boolean;
}

const MEMORY_KEY = 'anyreplay.assets';
const MEMORY_LIMIT = 300;

/**
 * Turns bundled image URIs into content hashes, uploading each image the
 * project does not hold yet.
 *
 * `hashFor` never waits. An image seen for the first time has no hash on that
 * tick; the work happens in the background, one image at a time, and the hash
 * appears in a later tick's diff. A recording must never stall on a network
 * call, and the first frame of a new image is not worth one.
 */
export class AssetUploader {
  private readonly hashes = new Map<string, string>();
  private readonly failed = new Set<string>();
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private running = false;
  private loaded: Promise<void>;

  constructor(private readonly deps: AssetUploaderDeps) {
    this.loaded = this.load();
  }

  hashFor(uri: string): string | undefined {
    const known = this.hashes.get(uri);
    if (known) return known;
    if (!this.failed.has(uri) && !this.queued.has(uri)) {
      this.queued.add(uri);
      this.queue.push(uri);
      void this.drain();
    }
    return undefined;
  }

  /** Resolves once everything queued so far has been handled. For tests. */
  async idle(): Promise<void> {
    await this.loaded;
    while (this.running || this.queue.length > 0) await new Promise((resolve) => setTimeout(resolve, 1));
  }

  private async load(): Promise<void> {
    try {
      const raw = await this.deps.store?.getItem(MEMORY_KEY);
      const entries = raw ? (JSON.parse(raw) as [string, string][]) : [];
      for (const [uri, hash] of entries) {
        if (typeof uri === 'string' && /^[0-9a-f]{64}$/.test(hash)) this.hashes.set(uri, hash);
      }
    } catch {
      /* a corrupt memory is an empty one */
    }
  }

  private async remember(uri: string, hash: string): Promise<void> {
    this.hashes.set(uri, hash);
    const entries = [...this.hashes.entries()].slice(-MEMORY_LIMIT);
    try { await this.deps.store?.setItem(MEMORY_KEY, JSON.stringify(entries)); } catch { /* best effort */ }
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.loaded;
      while (this.queue.length > 0) {
        const uri = this.queue.shift()!;
        if (this.hashes.has(uri)) continue;
        try {
          const hash = await this.ensure(uri);
          if (hash) await this.remember(uri, hash);
          else this.failed.add(uri);
        } catch (error) {
          this.failed.add(uri);
          if (this.deps.debug) console.warn('[anyreplay] could not upload image', uri, error);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async ensure(uri: string): Promise<string | null> {
    const bytes = await this.deps.readBytes(uri);
    if (bytes.length === 0 || bytes.length > (this.deps.maxBytes ?? 3 * 1024 * 1024)) return null;
    const hash = sha256Hex(bytes);
    const headers = { 'Content-Type': 'application/json' };

    const known = await this.deps.fetch(`${this.deps.ingestUrl}/v1/ingest/assets/known`, {
      method: 'POST', headers, body: JSON.stringify({ projectKey: this.deps.projectKey, hashes: [hash] }),
    });
    if (known.ok) {
      const body = await known.json() as { known?: unknown };
      if (Array.isArray(body.known) && body.known.includes(hash)) return hash;
    }

    const upload = await this.deps.fetch(`${this.deps.ingestUrl}/v1/ingest/assets`, {
      method: 'POST', headers,
      body: JSON.stringify({ projectKey: this.deps.projectKey, sha256: hash, data: toBase64(bytes) }),
    });
    return upload.ok ? hash : null;
  }
}
