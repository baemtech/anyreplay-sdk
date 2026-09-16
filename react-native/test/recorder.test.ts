import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRecorder, type Host } from '../src/recorder.js';
import { consent, identify, init, stop } from '../src/native.js';
import { MemoryStore } from '../src/session.js';
import type { CapturedElement } from '../src/tree.js';
import { EVENT, SOURCE } from '../src/wire.js';

const KEY = 'ar_pk_live_0123456789abcdef01234567';

/**
 * A host with no React Native in it.
 *
 * The whole recorder is reachable through this interface, which is what lets
 * the decisions that matter — what gets recorded, what gets masked, what is
 * sent and when — be tested without a simulator.
 */
function fakeHost(overrides: Partial<Host> = {}) {
  let clock = 1_700_000_000_000;
  const timers: (() => void)[] = [];
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  let elements = new Map<number, CapturedElement>();

  const host: Host = {
    now: () => clock,
    screen: () => ({ width: 390, height: 844 }),
    platform: () => ({ os: 'ios', version: '17.4', model: 'iPhone15,2' }),
    locale: () => 'tr-TR',
    snapshot: () => (elements.size > 0 ? { elements, rootId: 2 } : null),
    setInterval: (fn) => { timers.push(fn); return timers.length - 1; },
    clearInterval: () => {},
    fetch: (async (url: string, init: { body: string }) => {
      posts.push({ url: String(url), body: JSON.parse(init.body) });
      return { ok: true, status: 202 } as Response;
    }) as unknown as typeof fetch,
    ...overrides,
  };

  return {
    host,
    posts,
    advance: (ms: number) => { clock += ms; },
    setScreen: (...items: CapturedElement[]) => { elements = new Map(items.map((i) => [i.id, i])); },
    tickSnapshot: () => timers[0]?.(),
    tickFlush: () => timers[1]?.(),
    eventsSent: () => posts.flatMap((p) => (p.body.events as { type: number; data?: unknown }[]) ?? []),
  };
}

const el = (over: Partial<CapturedElement> & { id: number }): CapturedElement => ({
  tag: 'View', rect: { x: 0, y: 0, width: 200, height: 40 }, children: [], ...over,
});

describe('the recorder', () => {
  it('refuses a key that did not come from the dashboard', async () => {
    const { host } = fakeHost();
    await expect(createRecorder({ projectKey: 'nope' }, host)).rejects.toThrow(/projectKey/);
  });

  it('tells the server what device this is, in the words the server already parses', async () => {
    const f = fakeHost();
    f.setScreen(el({ id: 2, tag: 'Text', text: 'Merhaba' }));
    await createRecorder({ projectKey: KEY, storage: new MemoryStore() }, f.host);
    f.tickFlush();

    const meta = f.posts[0]!.body.meta as Record<string, unknown>;
    expect(meta.userAgent).toContain('iPhone; iOS 17.4');
    expect(meta.userAgent).toContain('Mobile');
    expect(meta).toMatchObject({ lang: 'tr-TR', screenWidth: 390, screenHeight: 844 });
  });

  it('sends a whole screen once, then only what changed', async () => {
    const f = fakeHost();
    f.setScreen(el({ id: 2, tag: 'Text', text: 'Merhaba' }));
    await createRecorder({ projectKey: KEY, storage: new MemoryStore() }, f.host);

    f.advance(500);
    f.setScreen(el({ id: 2, tag: 'Text', text: 'Merhaba', rect: { x: 0, y: 20, width: 200, height: 40 } }));
    f.tickSnapshot();
    f.tickFlush();

    const events = f.eventsSent();
    expect(events.filter((e) => e.type === EVENT.fullSnapshot)).toHaveLength(1);

    const mutations = events.filter((e) => e.type === EVENT.incremental);
    expect(mutations).toHaveLength(1);
    // Only the coordinate that moved travels, not the screen it moved on.
    expect(JSON.stringify(mutations[0]!.data)).toContain('"y":20');
    expect(JSON.stringify(mutations[0]!.data)).not.toContain('Merhaba');
  });

  it('says nothing at all when nothing moved', async () => {
    const f = fakeHost();
    f.setScreen(el({ id: 2, tag: 'Text', text: 'Merhaba' }));
    await createRecorder({ projectKey: KEY, storage: new MemoryStore() }, f.host);
    const before = f.eventsSent().length + 1; // +1 for the pending snapshot

    f.advance(500); f.tickSnapshot();
    f.advance(500); f.tickSnapshot();
    f.tickFlush();

    // Two idle ticks added nothing beyond the meta and the first snapshot.
    expect(f.eventsSent().length).toBeLessThanOrEqual(before + 1);
  });

  /**
   * After a navigation almost nothing is the same, so a diff against the old
   * screen would be bigger than the snapshot it replaced.
   */
  it('sends a fresh snapshot after a screen change, not a diff', async () => {
    const f = fakeHost();
    f.setScreen(el({ id: 2, tag: 'Text', text: 'Ana sayfa' }));
    const rec = await createRecorder({ projectKey: KEY, storage: new MemoryStore() }, f.host);

    f.advance(100);
    rec.screen('Settings');
    f.setScreen(el({ id: 2, tag: 'Text', text: 'Ayarlar' }));
    f.advance(500); f.tickSnapshot();
    f.tickFlush();

    expect(f.eventsSent().filter((e) => e.type === EVENT.fullSnapshot)).toHaveLength(2);
  });

  it('counts screens, which is this platform’s page count', async () => {
    const f = fakeHost();
    f.setScreen(el({ id: 2 }));
    const rec = await createRecorder({ projectKey: KEY, storage: new MemoryStore() }, f.host);
    rec.screen('Two'); rec.screen('Three');
    f.tickFlush();
    expect((f.posts[0]!.body.flags as { pageCount: number }).pageCount).toBe(3);
  });

  it('records a tap where it happened', async () => {
    const f = fakeHost();
    f.setScreen(el({ id: 2 }));
    const rec = await createRecorder({ projectKey: KEY, storage: new MemoryStore() }, f.host);
    rec.touch(120.6, 300.2);
    f.tickFlush();

    const tap = f.eventsSent().find(
      (e) => e.type === EVENT.incremental
        && (e.data as { source: number }).source === SOURCE.mouseInteraction,
    );
    expect(tap!.data).toMatchObject({ x: 121, y: 300 });
  });

  it('flags a rage tap, which is the same signal as a rage click', async () => {
    const f = fakeHost();
    f.setScreen(el({ id: 2 }));
    const rec = await createRecorder({ projectKey: KEY, storage: new MemoryStore() }, f.host);
    rec.touch(100, 100); f.advance(100);
    rec.touch(103, 98); f.advance(100);
    rec.touch(101, 102);
    f.tickFlush();

    expect((f.posts[0]!.body.flags as { hasRageClick?: boolean }).hasRageClick).toBe(true);
  });

  it('does not call a rage tap on three taps in three different places', async () => {
    const f = fakeHost();
    f.setScreen(el({ id: 2 }));
    const rec = await createRecorder({ projectKey: KEY, storage: new MemoryStore() }, f.host);
    rec.touch(10, 10); f.advance(100);
    rec.touch(200, 400); f.advance(100);
    rec.touch(50, 700);
    f.tickFlush();

    expect((f.posts[0]!.body.flags as { hasRageClick?: boolean }).hasRageClick).toBeUndefined();
  });

  it('records nothing until consent is given, when consent is required', async () => {
    const f = fakeHost();
    f.setScreen(el({ id: 2, tag: 'Text', text: 'gizli' }));
    const rec = await createRecorder(
      { projectKey: KEY, requireConsent: true, storage: new MemoryStore() }, f.host,
    );

    expect(rec.status()).toBe('awaiting-consent');
    f.advance(500); f.tickSnapshot(); f.tickFlush();
    expect(f.posts).toHaveLength(0);

    rec.consent(true);
    // Consent reads the store before it records, so the switch is asynchronous.
    await vi.waitFor(() => expect(rec.status()).toBe('recording'));
    f.tickFlush();
    expect(JSON.stringify(f.posts)).toContain('gizli');
  });

  /** A store that remembers every write, so a test can say "nothing was stored". */
  class WatchedStore extends MemoryStore {
    writes: string[] = [];
    override async setItem(key: string, value: string): Promise<void> {
      this.writes.push(key);
      await super.setItem(key, value);
    }
  }

  it('stores nothing on the device until consent is given', async () => {
    const f = fakeHost();
    const store = new WatchedStore();
    f.setScreen(el({ id: 2, tag: 'Text', text: 'gizli' }));
    const rec = await createRecorder({ projectKey: KEY, requireConsent: true, storage: store }, f.host);

    f.advance(500); f.tickSnapshot(); f.tickFlush();
    rec.touch(10, 10); rec.screen('Two'); rec.identify({ userId: 'u1' });
    await rec.flush();
    expect(store.writes).toEqual([]);
    expect(rec.sessionId()).toBeNull();
    expect(f.posts).toHaveLength(0);

    rec.consent(true);
    await vi.waitFor(() => expect(rec.status()).toBe('recording'));
    expect(await store.getItem('anyreplay.vid')).toMatch(/^v[0-9a-f]{24}$/);
    expect(await store.getItem('anyreplay.sid')).toBe(rec.sessionId());
    f.tickFlush();
    const chunk = f.posts.find((p) => p.url.endsWith('/v1/ingest/events'))!;
    expect(chunk.body.visitorId).toBe(await store.getItem('anyreplay.vid'));
    // The identity given while waiting went out too, once there was a session.
    expect(f.posts.some((p) => p.url.endsWith('/v1/ingest/identify'))).toBe(true);
  });

  it('does not take an id stored by an earlier launch as consent', async () => {
    const f = fakeHost();
    const store = new WatchedStore();
    await store.setItem('anyreplay.vid', 'v0123456789abcdef01234567');
    store.writes = [];
    f.setScreen(el({ id: 2 }));
    const rec = await createRecorder({ projectKey: KEY, requireConsent: true, storage: store }, f.host);

    f.tickSnapshot(); f.tickFlush();
    expect(rec.status()).toBe('awaiting-consent');
    expect(store.writes).toEqual([]);
    expect(f.posts).toHaveLength(0);
  });

  it('forgets the visitor when consent is withdrawn after it was granted', async () => {
    const f = fakeHost();
    const store = new MemoryStore();
    f.setScreen(el({ id: 2 }));
    const rec = await createRecorder({ projectKey: KEY, requireConsent: true, storage: store }, f.host);
    rec.consent(true);
    await vi.waitFor(() => expect(rec.status()).toBe('recording'));
    const visitorId = await store.getItem('anyreplay.vid');
    expect(visitorId).not.toBeNull();

    rec.consent(false);
    expect(rec.status()).toBe('stopped');
    await vi.waitFor(async () => {
      for (const key of ['anyreplay.vid', 'anyreplay.sid', 'anyreplay.sts', 'anyreplay.seq']) {
        expect(await store.getItem(key)).toBeNull();
      }
    });
    // Stopped for good on this launch.
    rec.consent(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(rec.status()).toBe('stopped');
    expect(await store.getItem('anyreplay.vid')).toBeNull();
  });

  it('empties the keys instead when the store cannot remove them', async () => {
    const values = new Map<string, string>();
    const store = {
      getItem: async (key: string) => values.get(key) ?? null,
      setItem: async (key: string, value: string) => { values.set(key, value); },
    };
    const f = fakeHost();
    f.setScreen(el({ id: 2 }));
    const rec = await createRecorder({ projectKey: KEY, requireConsent: true, storage: store }, f.host);
    rec.consent(false);
    await new Promise((resolve) => setTimeout(resolve, 10));
    // A refusal before anything was stored still stores nothing.
    expect(values.size).toBe(0);

    const second = await createRecorder({ projectKey: KEY, storage: store }, f.host);
    expect(values.get('anyreplay.vid')).toMatch(/^v/);
    second.consent(false);
    await vi.waitFor(() => expect(values.get('anyreplay.vid')).toBe(''));
    // An emptied id reads as absent: the next acceptance is a new visitor.
    const third = await createRecorder({ projectKey: KEY, storage: store }, f.host);
    expect(third.sessionId()).not.toBe(second.sessionId());
    expect(values.get('anyreplay.vid')).toMatch(/^v[0-9a-f]{24}$/);
  });

  it('records nobody when the sample rate is zero', async () => {
    const f = fakeHost();
    f.setScreen(el({ id: 2 }));
    const rec = await createRecorder(
      { projectKey: KEY, sampleRate: 0, storage: new MemoryStore() }, f.host,
    );
    expect(rec.status()).toBe('sampled-out');
    f.tickFlush();
    expect(f.posts).toHaveLength(0);
  });

  /**
   * A wrong key or a project that is switched off cannot be fixed by trying
   * again, and an app that keeps trying is a flood from every install at once.
   */
  it('stops for good when the server refuses the key', async () => {
    const f = fakeHost({
      fetch: (async () => ({ ok: false, status: 403 }) as Response) as unknown as typeof fetch,
    });
    f.setScreen(el({ id: 2 }));
    const rec = await createRecorder({ projectKey: KEY, storage: new MemoryStore() }, f.host);

    await rec.flush();
    expect(rec.status()).toBe('stopped');
  });

  /** A phone spends real time with no network; giving up the first time loses a commute. */
  it('continues the chunk numbering when the app is relaunched into the same session', async () => {
    // Found on a real device: a relaunch inside the idle window resumed the
    // session but numbered its chunks from 0 again, ingest took them for
    // retries, and everything after the relaunch was silently discarded.
    const store = new MemoryStore();

    const first = fakeHost();
    await createRecorder({ projectKey: KEY, storage: store }, first.host);
    first.setScreen(el({ id: 2, tag: 'Text', text: 'Merhaba' }));
    first.tickSnapshot();
    first.tickFlush();
    await vi.waitFor(() => expect(first.posts).toHaveLength(1));

    const second = fakeHost();
    await createRecorder({ projectKey: KEY, storage: store }, second.host);
    second.setScreen(el({ id: 2, tag: 'Text', text: 'Tekrar' }));
    second.tickSnapshot();
    second.tickFlush();
    await vi.waitFor(() => expect(second.posts).toHaveLength(1));

    expect(second.posts[0]!.body.sessionId).toBe(first.posts[0]!.body.sessionId);
    expect(first.posts[0]!.body.seq).toBe(0);
    expect(second.posts[0]!.body.seq).toBe(1);
  });

  it('resends events the server discarded under a number an earlier launch used', async () => {
    const bodies: Record<string, unknown>[] = [];
    const f = fakeHost({
      fetch: (async (_url: string, init: { body: string }) => {
        bodies.push(JSON.parse(init.body));
        const reply = bodies.length === 1 ? { accepted: true, duplicate: true, nextSeq: 6 } : { accepted: true };
        return { ok: true, status: 202, json: async () => reply } as unknown as Response;
      }) as unknown as typeof fetch,
    });
    await createRecorder({ projectKey: KEY, storage: new MemoryStore() }, f.host);
    f.setScreen(el({ id: 2, tag: 'Text', text: 'Merhaba' }));
    f.tickSnapshot();
    f.tickFlush();

    await vi.waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies.map((b) => b.seq)).toEqual([0, 6]);
    expect(bodies[1]!.events).toEqual(bodies[0]!.events);
  });

  it('keeps events through an outage and sends them when the network returns', async () => {
    let online = false;
    const posts: Record<string, unknown>[] = [];
    const f = fakeHost({
      fetch: (async (_url: string, init: { body: string }) => {
        if (!online) throw new Error('offline');
        posts.push(JSON.parse(init.body));
        return { ok: true, status: 202 } as Response;
      }) as unknown as typeof fetch,
    });
    f.setScreen(el({ id: 2, tag: 'Text', text: 'tünelde' }));
    const rec = await createRecorder({ projectKey: KEY, storage: new MemoryStore() }, f.host);

    await rec.flush();
    expect(posts).toHaveLength(0);

    online = true;
    await rec.flush();
    expect(JSON.stringify(posts)).toContain('tünelde');
  });
});

/**
 * `init` is asynchronous and the docs call `consent` on the very next line.
 * The binding keeps that decision until the recorder exists.
 */
describe('consent around init', () => {
  afterEach(() => stop());

  it('applies a consent(true) made before init finished', async () => {
    const f = fakeHost();
    const store = new MemoryStore();
    f.setScreen(el({ id: 2, tag: 'Text', text: 'kabul' }));

    const ready = init({ projectKey: KEY, requireConsent: true, storage: store }, f.host);
    consent(true);
    const rec = (await ready)!;
    await vi.waitFor(() => expect(rec.status()).toBe('recording'));
    f.tickFlush();
    expect(JSON.stringify(f.posts)).toContain('kabul');
  });

  it('applies a consent(true) made after init finished, as before', async () => {
    const f = fakeHost();
    f.setScreen(el({ id: 2 }));
    const rec = (await init({ projectKey: KEY, requireConsent: true, storage: new MemoryStore() }, f.host))!;
    expect(rec.status()).toBe('awaiting-consent');
    consent(true);
    await vi.waitFor(() => expect(rec.status()).toBe('recording'));
  });

  it('never starts when consent was refused before init finished, even without requireConsent', async () => {
    const f = fakeHost();
    const store = new MemoryStore();
    f.setScreen(el({ id: 2, tag: 'Text', text: 'ret' }));

    const ready = init({ projectKey: KEY, storage: store }, f.host);
    consent(false);
    const rec = (await ready)!;
    expect(rec.status()).toBe('stopped');
    f.tickSnapshot(); f.tickFlush();
    await rec.flush();
    expect(f.posts).toHaveLength(0);
    expect(await store.getItem('anyreplay.vid')).toBeNull();
  });

  it('sends an identity given right after consent(true), once the recorder is recording', async () => {
    const f = fakeHost();
    f.setScreen(el({ id: 2 }));
    const ready = init({ projectKey: KEY, requireConsent: true, storage: new MemoryStore() }, f.host);
    consent(true);
    identify({ userId: 'u_42' });
    expect(f.posts).toHaveLength(0);
    const rec = (await ready)!;
    await vi.waitFor(() => expect(f.posts.some((p) => p.url.endsWith('/v1/ingest/identify'))).toBe(true));
    const post = f.posts.find((p) => p.url.endsWith('/v1/ingest/identify'))!;
    expect(post.body).toEqual({ projectKey: KEY, sessionId: rec.sessionId(), userId: 'u_42' });
  });

  it('takes the latest decision when several arrive before init finished', async () => {
    const f = fakeHost();
    f.setScreen(el({ id: 2 }));
    const ready = init({ projectKey: KEY, requireConsent: true, storage: new MemoryStore() }, f.host);
    consent(true);
    consent(false);
    const rec = (await ready)!;
    expect(rec.status()).toBe('stopped');
  });
});
