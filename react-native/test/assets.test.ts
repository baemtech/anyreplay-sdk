import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AssetUploader, isBundledAsset, sha256Hex, toBase64 } from '../src/assets.js';
import { MemoryStore } from '../src/session.js';

const KEY = 'ar_pk_live_0123456789abcdef01234567';

describe('sha256Hex', () => {
  it.each([0, 1, 3, 55, 56, 63, 64, 65, 119, 120, 1000, 65_537])('matches Node for %i bytes', (size) => {
    const bytes = randomBytes(size);
    expect(sha256Hex(new Uint8Array(bytes))).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('matches the published test vector', () => {
    expect(sha256Hex(new TextEncoder().encode('abc')))
      .toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('toBase64', () => {
  it.each([0, 1, 2, 3, 4, 5, 6, 9000, 20_000])('matches Node for %i bytes', (size) => {
    const bytes = randomBytes(size);
    expect(toBase64(new Uint8Array(bytes))).toBe(bytes.toString('base64'));
  });
});

describe('isBundledAsset', () => {
  it.each([
    'http://localhost:8081/assets/assets/images/icon.png?platform=ios&hash=abc',
    'http://10.0.2.2:8081/assets/assets/images/icon.png?platform=android',
    'file:///var/containers/Bundle/Application/1A2B/BabyPix.app/assets/images/icon.png',
    'file:///Users/me/Library/Developer/CoreSimulator/Devices/D1/data/Containers/Bundle/Application/1A2B/BabyPix.app/assets/icon.png',
    'file:///android_asset/images/icon.png',
    'asset:/images/icon.png',
  ])('treats %s as the app’s own', (uri) => { expect(isBundledAsset(uri)).toBe(true); });

  it.each([
    'file:///var/mobile/Containers/Data/Application/1A2B/Library/Caches/ImagePicker/1.jpg',
    'file:///data/user/0/com.app/cache/ImagePicker/1.jpg',
    'ph://ED7AC36B-A150-4C38-BB8C-B6D696F4F2ED/L0/001',
    'content://media/external/images/media/12',
    'https://cdn.example.com/a.png',
    'http://localhost:8081/something-else.png',
  ])('never reads %s', (uri) => { expect(isBundledAsset(uri)).toBe(false); });
});

function fakeServer(options: { known?: string[]; uploadStatus?: number } = {}) {
  const held = new Set(options.known ?? []);
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string, init: { body: string }) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ path, body });
    if (path.endsWith('/known')) {
      const hashes = body.hashes as string[];
      return { ok: true, status: 200, json: async () => ({ known: hashes.filter((h) => held.has(h)) }) };
    }
    const status = options.uploadStatus ?? 201;
    if (status < 300) held.add(body.sha256 as string);
    return { ok: status < 300, status, json: async () => ({}) };
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('AssetUploader', () => {
  const ICON = new Uint8Array(randomBytes(2048));
  const HASH = createHash('sha256').update(ICON).digest('hex');
  const URI = 'http://localhost:8081/assets/assets/images/icon.png?platform=ios';

  it('uploads an image the project does not hold, then answers with its hash', async () => {
    const server = fakeServer();
    let reads = 0;
    const uploader = new AssetUploader({
      ingestUrl: 'https://in.test', projectKey: KEY, fetch: server.fetchImpl,
      readBytes: async () => { reads += 1; return ICON; },
    });

    expect(uploader.hashFor(URI)).toBeUndefined();
    uploader.hashFor(URI);
    uploader.hashFor(URI);
    await uploader.idle();

    expect(uploader.hashFor(URI)).toBe(HASH);
    expect(reads).toBe(1);
    expect(server.calls.map((c) => c.path)).toEqual(['/v1/ingest/assets/known', '/v1/ingest/assets']);
    expect(server.calls[1]!.body).toEqual({ projectKey: KEY, sha256: HASH, data: Buffer.from(ICON).toString('base64') });
  });

  it('uploads nothing when the project already holds the image', async () => {
    const server = fakeServer({ known: [HASH] });
    const uploader = new AssetUploader({
      ingestUrl: 'https://in.test', projectKey: KEY, fetch: server.fetchImpl, readBytes: async () => ICON,
    });
    uploader.hashFor(URI);
    await uploader.idle();
    expect(uploader.hashFor(URI)).toBe(HASH);
    expect(server.calls.map((c) => c.path)).toEqual(['/v1/ingest/assets/known']);
  });

  it('remembers across launches, so a relaunch sends no request at all', async () => {
    const store = new MemoryStore();
    const first = fakeServer();
    const a = new AssetUploader({ ingestUrl: 'https://in.test', projectKey: KEY, fetch: first.fetchImpl, readBytes: async () => ICON, store });
    a.hashFor(URI);
    await a.idle();

    const second = fakeServer();
    const b = new AssetUploader({ ingestUrl: 'https://in.test', projectKey: KEY, fetch: second.fetchImpl, readBytes: async () => ICON, store });
    await b.idle();
    expect(b.hashFor(URI)).toBe(HASH);
    await b.idle();
    expect(second.calls).toEqual([]);
  });

  it('gives up on an image the server refuses, without asking again', async () => {
    const server = fakeServer({ uploadStatus: 403 });
    const uploader = new AssetUploader({
      ingestUrl: 'https://in.test', projectKey: KEY, fetch: server.fetchImpl, readBytes: async () => ICON,
    });
    uploader.hashFor(URI);
    await uploader.idle();
    expect(uploader.hashFor(URI)).toBeUndefined();
    await uploader.idle();
    expect(server.calls).toHaveLength(2);
  });

  it('does not read past its size limit into an upload', async () => {
    const server = fakeServer();
    const uploader = new AssetUploader({
      ingestUrl: 'https://in.test', projectKey: KEY, fetch: server.fetchImpl,
      readBytes: async () => ICON, maxBytes: 1024,
    });
    uploader.hashFor(URI);
    await uploader.idle();
    expect(uploader.hashFor(URI)).toBeUndefined();
    expect(server.calls).toEqual([]);
  });

  it('never lets a failed read reach the app', async () => {
    const uploader = new AssetUploader({
      ingestUrl: 'https://in.test', projectKey: KEY, fetch: fakeServer().fetchImpl,
      readBytes: async () => { throw new Error('gone'); },
    });
    expect(() => uploader.hashFor(URI)).not.toThrow();
    await uploader.idle();
    expect(uploader.hashFor(URI)).toBeUndefined();
  });
});
