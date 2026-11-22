import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRecorder, type Host } from '../src/recorder.js';
import { MemoryStore } from '../src/session.js';
import {
  CLIP_MAX_BYTES, ClipRing, boundTail, clipUpload, parsePending, remoteCrashClip, splitChunks,
} from '../src/crash.js';
import type { CapturedElement } from '../src/tree.js';
import type { RecordedEvent } from '../src/wire.js';

const KEY = 'ar_pk_live_0123456789abcdef01234567';
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

type Handler = (error: unknown, isFatal?: boolean) => void;

/** React Native's ErrorUtils, with the app's own handler underneath ours. */
function installErrorUtils(appHandler: Handler) {
  let handler: Handler | undefined = appHandler;
  (globalThis as { ErrorUtils?: unknown }).ErrorUtils = {
    getGlobalHandler: () => handler,
    setGlobalHandler: (next: Handler) => { handler = next; },
  };
  return { crash: (error: unknown, fatal = true) => handler?.(error, fatal) };
}

interface Post { url: string; method: string; body?: Record<string, unknown> }

function fakeHost(config: { crashClip?: boolean; online?: boolean } = {}) {
  let clock = 1_700_000_000_000;
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const posts: Post[] = [];
  let text = 'Merhaba';

  const host: Host = {
    now: () => clock,
    screen: () => ({ width: 390, height: 844 }),
    platform: () => ({ os: 'ios', version: '17.4', model: 'iPhone15,2' }),
    locale: () => 'tr-TR',
    snapshot: () => {
      const elements = new Map<number, CapturedElement>([
        [2, { id: 2, tag: 'Text', text, rect: { x: 0, y: 0, width: 200, height: 40 }, children: [] }],
      ]);
      return { elements, rootId: 2 };
    },
    setInterval: (fn) => { nextTimer += 1; timers.set(nextTimer, fn); return nextTimer; },
    clearInterval: (handle) => { timers.delete(handle as number); },
    fetch: (async (url: string, init?: { method?: string; body?: string }) => {
      if (config.online === false) throw new TypeError('Network request failed');
      const method = init?.method ?? 'GET';
      posts.push({ url: String(url), method, ...(init?.body ? { body: JSON.parse(init.body) } : {}) });
      if (String(url).includes('/v1/ingest/config')) {
        return { ok: true, status: 200, json: async () => ({ crashClip: config.crashClip ?? false, maskAllInputs: true }) } as Response;
      }
      return { ok: true, status: 202, json: async () => ({ accepted: true }) } as Response;
    }) as unknown as typeof fetch,
  };

  return {
    host,
    posts,
    chunks: () => posts.filter((p) => p.url.endsWith('/v1/ingest/events')).map((p) => p.body!),
    advance: (ms: number) => { clock += ms; },
    now: () => clock,
    setText: (next: string) => { text = next; },
    /** Fires every timer once, in the order they were set. */
    fire: () => { for (const fn of [...timers.values()]) fn(); },
    timerCount: () => timers.size,
  };
}

const ev = (timestamp: number, type = 3, data: unknown = { source: 0, adds: [], removes: [], texts: [], attributes: [] }): RecordedEvent =>
  ({ type, timestamp, data });

describe('the crash clip ring', () => {
  it('keeps segments back to the one that starts at or before now − 30 s', () => {
    const ring = new ClipRing();
    const t0 = 1_000_000;
    for (let s = 0; s < 6; s += 1) {
      const at = t0 + s * 10_000;
      expect(ring.needsSegment(at)).toBe(true);
      ring.startSegment(at);
      ring.push(ev(at, 4, { width: 1, height: 1 }));
      ring.push(ev(at, 2, { node: {} }));
      ring.push(ev(at + 5_000));
      expect(ring.needsSegment(at + 5_000)).toBe(false);
    }
    // Now is t0 + 55 s: the segment that starts at t0 + 20 s is the newest at or before now − 30 s.
    const events = ring.events();
    expect(events[0]!.timestamp).toBe(t0 + 20_000);
    expect(events[0]!.type).toBe(4);
    expect(ring.segmentCount).toBe(4);
  });

  it('holds its byte cap by dropping whole segments, oldest first', () => {
    const ring = new ClipRing({ windowMs: 1_000_000, maxBytes: 2_000, segmentMs: 10 });
    const big = 'x'.repeat(600);
    for (let s = 0; s < 5; s += 1) {
      ring.startSegment(s * 10);
      ring.push(ev(s * 10, 4, { width: 1, height: 1, pad: big }));
    }
    expect(ring.bytes).toBeLessThanOrEqual(2_000);
    // Each segment is about 650 bytes: the newest three fit.
    expect(ring.segmentCount).toBe(3);
    expect(ring.events()[0]!.timestamp).toBe(20);
  });

  it('one segment over the cap stops taking tree events, but still takes the error', () => {
    const ring = new ClipRing({ windowMs: 30_000, maxBytes: 500, segmentMs: 10_000 });
    ring.startSegment(0);
    ring.push(ev(0, 2, { node: { pad: 'x'.repeat(400) } }));
    ring.push(ev(1, 3, { source: 0, pad: 'y'.repeat(200) }));
    ring.push(ev(2, 3, { source: 0 }));
    ring.push(ev(3, 5, { tag: 'anyreplay.error', payload: { kind: 'fatal' } }));
    expect(ring.events().map((e) => e.type)).toEqual([2, 5]);
  });

  it('a 2 MB cap by default', () => expect(CLIP_MAX_BYTES).toBe(2 * 1024 * 1024));
});

describe('chunks for stored and clipped uploads', () => {
  it('splits by count and leaves no chunk empty', () => {
    const events = Array.from({ length: 5 }, (_, i) => ev(i));
    expect(splitChunks(events, 2).map((c) => c.length)).toEqual([2, 2, 1]);
    expect(splitChunks([], 2)).toEqual([]);
  });

  it('a clip is a new session: seq from 0, meta.kind crash_clip, startedAt its first event, hasError', () => {
    const events = Array.from({ length: 3 }, (_, i) => ev(100 + i));
    const upload = clipUpload(events, { sessionId: 's', visitorId: 'v' }, { startedAt: 999, platform: 'react-native' }, 2)!;
    expect(upload.chunks.map((c) => c.seq)).toEqual([0, 1]);
    expect(upload.chunks[0]!.meta).toMatchObject({ startedAt: 100, kind: 'crash_clip', platform: 'react-native' });
    expect(upload.chunks[1]!.meta).toBeUndefined();
    expect(upload.chunks.every((c) => c.flags?.hasError)).toBe(true);
  });

  it('a stored tail too heavy for the store keeps the moments that stand on their own', () => {
    const tree = ev(1, 2, { node: { pad: 'x'.repeat(2000) } });
    const error = ev(2, 5, { tag: 'anyreplay.error', payload: { kind: 'fatal' } });
    expect(boundTail([tree, error], 1000)).toEqual([error]);
    expect(boundTail([tree, error], 10_000)).toEqual([tree, error]);
  });

  it('refuses a stored value that is not an upload', () => {
    expect(parsePending('nope')).toBeNull();
    expect(parsePending(JSON.stringify({ sessionId: 's', visitorId: 'v', chunks: [] }))).toBeNull();
    expect(parsePending(JSON.stringify({ sessionId: 's', visitorId: 'v', chunks: [{ seq: -1, events: [] }] }))).toBeNull();
  });
});

describe('the remote switch', () => {
  it('asks ingest once and believes the answer for ten minutes', async () => {
    const f = fakeHost({ crashClip: true });
    const store = new MemoryStore();
    const target = { ingestUrl: 'https://in.example', projectKey: KEY, appId: 'com.example.shop' };
    expect(await remoteCrashClip(store, f.host.fetch, target, 'anyreplay.cfg', 0)).toBe(true);
    expect(f.posts[0]!.url).toBe(`https://in.example/v1/ingest/config?projectKey=${KEY}&appId=com.example.shop`);
    expect(await remoteCrashClip(store, f.host.fetch, target, 'anyreplay.cfg', 9 * 60_000)).toBe(true);
    expect(f.posts).toHaveLength(1);
    await remoteCrashClip(store, f.host.fetch, target, 'anyreplay.cfg', 10 * 60_000);
    expect(f.posts).toHaveLength(2);
  });

  it('offline, an older answer stands; with none, no clip', async () => {
    const store = new MemoryStore();
    const target = { ingestUrl: 'https://in.example', projectKey: KEY };
    const offline = fakeHost({ online: false });
    expect(await remoteCrashClip(store, offline.host.fetch, target, 'cfg', 0)).toBe(false);
    await store.setItem('cfg', JSON.stringify({ at: 0, crashClip: true }));
    expect(await remoteCrashClip(store, offline.host.fetch, target, 'cfg', 60 * 60_000)).toBe(true);
  });
});

describe('crashes in the recorder', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { delete (globalThis as { ErrorUtils?: unknown }).ErrorUtils; });

  it('a sampled-out visitor with clips on sends the last seconds as a crash clip after a fatal error', async () => {
    const f = fakeHost();
    const store = new MemoryStore();
    let storedBeforeApp: string | undefined;
    const errors = installErrorUtils(() => { storedBeforeApp = (store as unknown as { values: Map<string, string> }).values.get('anyreplay.crash.clip'); });
    const rec = await createRecorder({ projectKey: KEY, sampleRate: 0, crashClip: true, storage: store }, f.host);
    await vi.waitFor(() => expect(f.timerCount()).toBe(1));
    expect(rec.status()).toBe('sampled-out');
    expect(f.chunks()).toHaveLength(0);

    for (let i = 0; i < 50; i += 1) {
      f.advance(1_000);
      f.setText(`t${i}`);
      f.fire();
    }
    expect(f.chunks()).toHaveLength(0);

    errors.crash(new Error('boom'), true);
    // Written before the app's own handler ran.
    expect(parsePending(storedBeforeApp)).not.toBeNull();
    f.advance(2_000);
    f.fire();
    await vi.waitFor(() => expect(f.chunks().length).toBeGreaterThan(0));
    await settle();

    const chunks = f.chunks();
    expect(chunks.map((c) => c.seq)).toEqual(chunks.map((_, i) => i));
    const first = chunks[0]!;
    const events = chunks.flatMap((c) => c.events as RecordedEvent[]);
    expect((first.meta as Record<string, unknown>).kind).toBe('crash_clip');
    expect((first.meta as Record<string, unknown>).startedAt).toBe(events[0]!.timestamp);
    expect(events[0]!.type).toBe(4);
    expect(events[1]!.type).toBe(2);
    // About 30 s back, never the whole 50.
    expect(f.now() - events[0]!.timestamp).toBeLessThanOrEqual(42_000);
    expect(f.now() - events[0]!.timestamp).toBeGreaterThanOrEqual(30_000);
    const fatal = events.find((e) => e.type === 5);
    expect(fatal?.data).toMatchObject({ tag: 'anyreplay.error', payload: { kind: 'fatal' } });
    expect(first.flags).toMatchObject({ hasError: true });
    // Sent, so the copy for the next launch is gone.
    await vi.waitFor(async () => expect(await store.getItem('anyreplay.crash.clip')).toBeNull());
  });

  it('makes at most one clip per five minutes, across launches', async () => {
    const f = fakeHost();
    const store = new MemoryStore();
    const errors = installErrorUtils(() => {});
    await createRecorder({ projectKey: KEY, sampleRate: 0, crashClip: true, storage: store }, f.host);
    await vi.waitFor(() => expect(f.timerCount()).toBe(1));
    f.advance(1_000); f.fire();
    errors.crash(new Error('one'));
    f.advance(2_000); f.fire();
    await vi.waitFor(() => expect(f.chunks().length).toBeGreaterThan(0));
    const sessions = () => new Set(f.chunks().map((c) => c.sessionId)).size;
    expect(sessions()).toBe(1);

    f.advance(60_000); f.fire();
    errors.crash(new Error('two'));
    f.advance(2_000); f.fire();
    await settle();
    expect(sessions()).toBe(1);

    f.advance(5 * 60_000); f.fire();
    errors.crash(new Error('three'));
    f.advance(2_000); f.fire();
    await vi.waitFor(() => expect(sessions()).toBe(2));
  });

  it('no clip for a visitor who is recorded, and none when the project has clips off', async () => {
    const recorded = fakeHost({ crashClip: true });
    installErrorUtils(() => {});
    await createRecorder({ projectKey: KEY, storage: new MemoryStore() }, recorded.host);
    expect(recorded.posts.some((p) => p.url.includes('/config'))).toBe(false);

    const off = fakeHost({ crashClip: false });
    const errors = installErrorUtils(() => {});
    await createRecorder({ projectKey: KEY, sampleRate: 0, storage: new MemoryStore() }, off.host);
    await vi.waitFor(() => expect(off.posts.some((p) => p.url.includes('/v1/ingest/config'))).toBe(true));
    await settle();
    expect(off.timerCount()).toBe(0);
    errors.crash(new Error('boom'));
    expect(off.chunks()).toHaveLength(0);
  });

  it('follows the project switch when the app sets none', async () => {
    const f = fakeHost({ crashClip: true });
    installErrorUtils(() => {});
    await createRecorder({ projectKey: KEY, sampleRate: 0, appId: 'com.example.shop', storage: new MemoryStore() }, f.host);
    await vi.waitFor(() => expect(f.timerCount()).toBe(1));
    expect(f.posts[0]!.url).toContain('/v1/ingest/config?projectKey=');
    expect(f.posts[0]!.url).toContain('appId=com.example.shop');
  });

  it('waits for consent, and a refusal forgets stored clips', async () => {
    const f = fakeHost();
    const store = new MemoryStore();
    installErrorUtils(() => {});
    const rec = await createRecorder({ projectKey: KEY, sampleRate: 0, crashClip: true, requireConsent: true, storage: store }, f.host);
    await settle();
    expect(f.timerCount()).toBe(0);
    await store.setItem('anyreplay.crash.clip', JSON.stringify({ sessionId: 's', visitorId: 'v', chunks: [{ seq: 0, events: [] }] }));
    await store.setItem('anyreplay.clipAt', '1');
    rec.consent(false);
    await vi.waitFor(async () => expect(await store.getItem('anyreplay.crash.clip')).toBeNull());
    expect(await store.getItem('anyreplay.clipAt')).toBeNull();
  });

  it('a recording that crashes leaves its tail for the next launch, which sends it first and numbers after it', async () => {
    const store = new MemoryStore();
    const dead = fakeHost({ online: false });
    let storedBeforeApp: string | undefined;
    const errors = installErrorUtils(() => { storedBeforeApp = (store as unknown as { values: Map<string, string> }).values.get('anyreplay.crash.rec'); });
    const rec = await createRecorder({ projectKey: KEY, storage: store }, dead.host);
    const sessionId = rec.sessionId();
    errors.crash(new Error('boom'), true);

    const stored = parsePending(storedBeforeApp);
    expect(stored?.sessionId).toBe(sessionId);
    expect(stored!.chunks[0]!.seq).toBe(0);
    expect(stored!.chunks[0]!.meta).toBeDefined();
    const storedEvents = stored!.chunks.flatMap((c) => c.events);
    expect(storedEvents.find((e) => e.type === 5)?.data).toMatchObject({ payload: { kind: 'fatal' } });
    await settle();

    // The next launch, a minute later: same session, inside the idle window.
    const next = fakeHost();
    next.advance(60_000);
    installErrorUtils(() => {});
    const again = await createRecorder({ projectKey: KEY, storage: store }, next.host);
    expect(again.sessionId()).toBe(sessionId);
    next.fire();
    await again.flush();
    await vi.waitFor(async () => expect(await store.getItem('anyreplay.crash.rec')).toBeNull());

    const chunks = next.chunks();
    expect(chunks[0]!.sessionId).toBe(sessionId);
    expect(chunks[0]!.seq).toBe(0);
    const later = chunks.slice(1).filter((c) => c.sessionId === sessionId);
    expect(later.length).toBeGreaterThan(0);
    for (const chunk of later) expect(chunk.seq as number).toBeGreaterThan(stored!.chunks[stored!.chunks.length - 1]!.seq);
  });

  it('a clip the process died before sending goes on the next launch, then is deleted', async () => {
    const store = new MemoryStore();
    const first = fakeHost();
    const errors = installErrorUtils(() => {});
    await createRecorder({ projectKey: KEY, sampleRate: 0, crashClip: true, storage: store }, first.host);
    await vi.waitFor(() => expect(first.timerCount()).toBe(1));
    first.advance(1_000); first.fire();
    errors.crash(new Error('boom'));
    // The process dies here: the aftermath timer never fires.
    const stored = parsePending(await store.getItem('anyreplay.crash.clip'));
    expect(stored?.chunks[0]!.meta?.kind).toBe('crash_clip');

    const next = fakeHost();
    installErrorUtils(() => {});
    await createRecorder({ projectKey: KEY, sampleRate: 0, crashClip: false, storage: store }, next.host);
    await vi.waitFor(async () => expect(await store.getItem('anyreplay.crash.clip')).toBeNull());
    expect(next.chunks()[0]).toMatchObject({ sessionId: stored!.sessionId, seq: 0, meta: { kind: 'crash_clip' } });
  });

  it('keeps a stored upload while ingest cannot be reached', async () => {
    const store = new MemoryStore();
    const upload = { sessionId: 's1', visitorId: 'v0123456789abcdef01234567', chunks: [{ seq: 3, events: [ev(1, 5, { tag: 'x' })] }] };
    await store.setItem('anyreplay.crash.rec', JSON.stringify(upload));
    const offline = fakeHost({ online: false });
    await createRecorder({ projectKey: KEY, storage: store }, offline.host);
    await settle(); await settle();
    expect(await store.getItem('anyreplay.crash.rec')).not.toBeNull();
  });
});
