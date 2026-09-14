import { describe, expect, it, vi } from 'vitest';
import { createRecorder, type Host } from '../src/recorder.js';
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
    f.tickFlush();
    expect(rec.status()).toBe('recording');
    expect(JSON.stringify(f.posts)).toContain('gizli');
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
