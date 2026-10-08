import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRecorder, type Host } from '../src/recorder.js';
import { consent, identify, init, stop } from '../src/native.js';
import { MemoryStore } from '../src/session.js';
import { watchNavigation } from '../src/navigation.js';
import type { CapturedElement } from '../src/tree.js';
import { EVENT, SOURCE } from '../src/wire.js';
import packageJson from '../package.json';

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

  it('names its platform, its own release, the app version and the model on the first chunk', async () => {
    const f = fakeHost({ platform: () => ({ os: 'android', version: '34', model: 'Pixel 8' }) });
    f.setScreen(el({ id: 2, tag: 'Text', text: 'Merhaba' }));
    await createRecorder({ projectKey: KEY, appVersion: '3.4.1', storage: new MemoryStore() }, f.host);
    f.tickFlush();

    expect(f.posts[0]!.body.meta).toMatchObject({
      platform: 'react-native',
      sdk: { name: '@anyreplay/react-native', version: packageJson.version },
      appVersion: '3.4.1',
      deviceModel: 'Pixel 8',
    });
    expect(f.posts[0]!.body).not.toHaveProperty('appId');
  });

  it('leaves out a model the platform does not offer', async () => {
    const f = fakeHost({ platform: () => ({ os: 'ios', version: '17.4' }) });
    f.setScreen(el({ id: 2, tag: 'Text', text: 'Merhaba' }));
    await createRecorder({ projectKey: KEY, storage: new MemoryStore() }, f.host);
    f.tickFlush();
    expect(f.posts[0]!.body.meta).not.toHaveProperty('deviceModel');
    expect(f.posts[0]!.body.meta).not.toHaveProperty('appVersion');
  });

  it('sends its app id with every chunk and with identify', async () => {
    const f = fakeHost();
    f.setScreen(el({ id: 2, tag: 'Text', text: 'Merhaba' }));
    const rec = await createRecorder({ projectKey: KEY, appId: 'com.example.shop', storage: new MemoryStore() }, f.host);
    rec.identify({ userId: 'u1' });
    f.tickFlush();
    // Let the first request settle, so the next flush is not refused as in flight.
    await new Promise((resolve) => setTimeout(resolve, 0));
    f.advance(500);
    f.setScreen(el({ id: 2, tag: 'Text', text: 'Hoşça kal' }));
    f.tickSnapshot();
    await rec.flush();

    const chunks = f.posts.filter((p) => p.url.endsWith('/v1/ingest/events'));
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) expect(chunk.body.appId).toBe('com.example.shop');
    await vi.waitFor(() => expect(f.posts.some((p) => p.url.endsWith('/v1/ingest/identify'))).toBe(true));
    expect(f.posts.find((p) => p.url.endsWith('/v1/ingest/identify'))!.body.appId).toBe('com.example.shop');
  });

  it('refuses an app id or app version that ingest would not accept', async () => {
    const { host } = fakeHost();
    await expect(createRecorder({ projectKey: KEY, appId: 'com example' }, host)).rejects.toThrow(/appId/);
    await expect(createRecorder({ projectKey: KEY, appVersion: 'x'.repeat(41) }, host)).rejects.toThrow(/appVersion/);
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

  /**
   * A card number typed into a note, one tick per keystroke, through the
   * snapshot and every mutation that leaves the device. The note is recorded;
   * the card number in it never shows more than six digits.
   */
  it('never sends more than six digits of a card number written inside a note', async () => {
    const f = fakeHost();
    const note = 'Not: kartım 4242 4242 4242 4242, teşekkürler';
    const field = (text: string) => el({ id: 2, tag: 'TextInput', text, rect: { x: 0, y: 0, width: 300, height: 120 } });
    f.setScreen(field('N'));
    await createRecorder({ projectKey: KEY, storage: new MemoryStore() }, f.host);
    for (let n = 2; n <= note.length; n += 1) {
      f.advance(500);
      f.setScreen(field(note.slice(0, n)));
      f.tickSnapshot();
    }
    f.tickFlush();

    const json = JSON.stringify(f.eventsSent());
    const words = [...json.matchAll(/"(?:textContent|value)":"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!);
    expect(words.length).toBeGreaterThan(note.length - 2);
    for (const text of words) expect(text.replace(/[^0-9]/g, '').length, text).toBeLessThanOrEqual(6);
    expect(words).toContain('Not: kartım **** **** **** ****, teşekkürler');
    expect(json).not.toContain('"masked":true');
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
    rec.screen('One'); rec.screen('Two'); rec.screen('Three');
    f.tickFlush();
    expect((f.posts[0]!.body.flags as { pageCount: number }).pageCount).toBe(3);
  });

  /**
   * The navigation binding reports the route the app starts on as soon as it
   * attaches. That names the first screen; it is not a second one — a
   * one-screen session used to report two.
   */
  it('counts the first screen once when the navigation binding names it', async () => {
    const f = fakeHost();
    f.setScreen(el({ id: 2 }));
    const rec = await createRecorder({ projectKey: KEY, storage: new MemoryStore() }, f.host);
    let report = (): void => {};
    let route = 'Home';
    watchNavigation({ getCurrentRoute: () => ({ name: route }), addListener: (_e, fn) => { report = fn; return () => {}; } }, rec.screen);
    await rec.flush();
    expect(f.posts).toHaveLength(1);
    expect((f.posts[0]!.body.flags as { pageCount: number }).pageCount).toBe(1);
    expect(f.eventsSent().filter((e) => e.type === EVENT.meta && (e.data as { href?: string }).href === 'Home')).toHaveLength(1);

    route = 'Cart'; report();
    f.advance(500); f.tickSnapshot();
    await rec.flush();
    expect((f.posts.at(-1)!.body.flags as { pageCount: number }).pageCount).toBe(2);
  });

  it('starts the recording on the screen named before consent, and counts it once', async () => {
    const f = fakeHost();
    f.setScreen(el({ id: 2 }));
    const rec = await createRecorder({ projectKey: KEY, requireConsent: true, storage: new MemoryStore() }, f.host);
    rec.screen('Onboarding');
    rec.consent(true);
    await vi.waitFor(() => expect(rec.status()).toBe('recording'));
    f.tickFlush();
    await vi.waitFor(() => expect(f.posts).toHaveLength(1));

    const events = f.eventsSent();
    expect(events[0]).toMatchObject({ type: EVENT.meta, data: { width: 390, height: 844 } });
    expect(events[1]).toMatchObject({ type: EVENT.meta, data: { href: 'Onboarding' } });
    expect(events[2]!.type).toBe(EVENT.fullSnapshot);
    expect(f.posts[0]!.body.meta).toMatchObject({ url: 'Onboarding' });
    expect((f.posts[0]!.body.flags as { pageCount: number }).pageCount).toBe(1);
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

  it('flags a rage tap that follows a stray tap somewhere else', async () => {
    const f = fakeHost();
    f.setScreen(el({ id: 2 }));
    const rec = await createRecorder({ projectKey: KEY, storage: new MemoryStore() }, f.host);
    // Measured from the oldest tap in the window, the first one hid the burst.
    rec.touch(10, 10); f.advance(100);
    rec.touch(200, 400); f.advance(100);
    rec.touch(203, 398); f.advance(100);
    rec.touch(199, 402);
    f.tickFlush();

    expect((f.posts[0]!.body.flags as { hasRageClick?: boolean }).hasRageClick).toBe(true);
  });

  it('flags an error that was tracked before recording started', async () => {
    const f = fakeHost();
    f.setScreen(el({ id: 2 }));
    const rec = await createRecorder({ projectKey: KEY, requireConsent: true, storage: new MemoryStore() }, f.host);
    rec.trackError(new Error('boot failed'));
    rec.consent(true);
    await vi.waitFor(() => expect(rec.status()).toBe('recording'));
    f.tickFlush();

    expect(JSON.stringify(f.posts[0]!.body.events)).toContain('boot failed');
    expect((f.posts[0]!.body.flags as { hasError?: boolean }).hasError).toBe(true);
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
    // The identity given while waiting went out too, once the session's first chunk was accepted.
    await vi.waitFor(() => expect(f.posts.some((p) => p.url.endsWith('/v1/ingest/identify'))).toBe(true));
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

  it('records a person who refused and then accepted on the same launch', async () => {
    const f = fakeHost();
    const store = new WatchedStore();
    f.setScreen(el({ id: 2 }));
    const rec = await createRecorder({ projectKey: KEY, requireConsent: true, storage: store }, f.host);
    rec.track('asked');
    rec.consent(false);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(rec.status()).toBe('awaiting-consent');
    expect(store.writes).toEqual([]);
    expect(f.posts).toHaveLength(0);

    rec.track('changed_mind');
    rec.consent(true);
    await vi.waitFor(() => expect(rec.status()).toBe('recording'));
    expect(await store.getItem('anyreplay.vid')).toMatch(/^v[0-9a-f]{24}$/);
    f.tickFlush();
    const sent = JSON.stringify(f.posts);
    // What was tagged for the refused answer went with it.
    expect(sent).toContain('changed_mind');
    expect(sent).not.toContain('"asked"');
  });

  it('honours a refusal that lands while consent is reading the store, and a yes after it', async () => {
    const f = fakeHost();
    const store = new MemoryStore();
    f.setScreen(el({ id: 2 }));
    const rec = await createRecorder({ projectKey: KEY, requireConsent: true, storage: store }, f.host);
    rec.consent(true);
    rec.consent(false);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(rec.status()).toBe('awaiting-consent');
    expect(await store.getItem('anyreplay.vid')).toBeNull();
    f.tickFlush();
    expect(f.posts).toHaveLength(0);

    // Yes, no, yes in one breath: the last answer wins.
    rec.consent(true);
    rec.consent(false);
    rec.consent(true);
    await vi.waitFor(() => expect(rec.status()).toBe('recording'));
    expect(await store.getItem('anyreplay.vid')).toMatch(/^v[0-9a-f]{24}$/);
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
    expect(rec.status()).toBe('recording');

    online = true;
    // Inside the backoff nothing is attempted; past it, the buffer goes.
    await rec.flush();
    expect(posts).toHaveLength(0);
    f.advance(2_000);
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
    // After the session's first chunk: before it, ingest has no session to attach it to.
    await vi.waitFor(() => expect(rec.status()).toBe('recording'));
    await rec.flush();
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
    // A no: still asking, so a later yes can start it.
    expect(rec.status()).toBe('awaiting-consent');
    consent(true);
    await vi.waitFor(() => expect(rec.status()).toBe('recording'));
  });
});

describe('what the device says it is', () => {
  const agentFor = async (platform: ReturnType<Host['platform']>) => {
    const f = fakeHost({ platform: () => platform });
    f.setScreen(el({ id: 2 }));
    await createRecorder({ projectKey: KEY, storage: new MemoryStore() }, f.host);
    f.tickFlush();
    return (f.posts[0]!.body.meta as { userAgent: string }).userAgent;
  };

  const release = packageJson.version.split('.').slice(0, 2).join('.');

  /**
   * The dashboard's device filter is built from how ingest reads this string:
   * "iPad", or "Android" without "Mobile", is a tablet. Every iPad and
   * Android tablet used to say iPhone/Mobile and was filed as a phone.
   * (conformance.test.ts holds these to the server's own classifier.)
   */
  it.each([
    [{ os: 'ios', version: '17.4' }, '(iPhone; iOS 17.4) Mobile'],
    [{ os: 'ios', version: '17.4', tablet: true }, '(iPad; iOS 17.4) Tablet'],
    [{ os: 'android', version: '14', model: 'Pixel 8' }, '(Android 14; Pixel 8) Mobile'],
    [{ os: 'android', version: '14', model: 'SM-X710', tablet: true }, '(Android 14; SM-X710) Tablet'],
  ] as const)('%o says %s', async (platform, device) => {
    expect(await agentFor(platform)).toBe(`AnyReplayRN/${release} ${device}`);
  });

  it('leaves out a model that would change how the agent string reads', async () => {
    const ua = await agentFor({ os: 'android', version: '14', model: 'Galaxy Tab Mobile 10', tablet: true });
    expect(ua).toBe(`AnyReplayRN/${release} (Android 14) Tablet`);
  });
});

describe('the screen changing shape', () => {
  it('sends the new size and a whole screen when the device rotates', async () => {
    let size = { width: 390, height: 844 };
    const f = fakeHost({ screen: () => size });
    f.setScreen(el({ id: 2, tag: 'Text', text: 'Merhaba' }));
    const rec = await createRecorder({ projectKey: KEY, storage: new MemoryStore() }, f.host);
    f.advance(500);
    size = { width: 844, height: 390 };
    f.setScreen(el({ id: 2, tag: 'Text', text: 'Merhaba', rect: { x: 0, y: 0, width: 400, height: 40 } }));
    f.tickSnapshot();
    await rec.flush();

    const events = f.eventsSent();
    const rotated = events.findIndex((e, i) => i > 0 && e.type === EVENT.meta && (e.data as { width?: number }).width === 844);
    expect(rotated).toBeGreaterThan(0);
    expect(events[rotated + 1]!.type).toBe(EVENT.fullSnapshot);
    expect((events[rotated + 1]!.data as { node: { attributes: { w: number } } }).node.attributes.w).toBe(844);
  });
});

describe('coming back to the app', () => {
  it('starts a new session after 30 idle minutes, as a launch would', async () => {
    const store = new MemoryStore();
    const f = fakeHost();
    f.setScreen(el({ id: 2, tag: 'Text', text: 'Merhaba' }));
    const rec = await createRecorder({ projectKey: KEY, storage: store }, f.host);
    rec.screen('Home');
    rec.identify({ userId: 'u1' });
    await rec.flush({ force: true });
    const first = rec.sessionId();

    f.advance(31 * 60 * 1000);
    rec.foreground();
    await rec.flush();

    expect(rec.sessionId()).not.toBe(first);
    const chunks = f.posts.filter((p) => p.url.endsWith('/v1/ingest/events')).map((p) => p.body);
    const next = chunks.filter((c) => c.sessionId === rec.sessionId());
    expect(next[0]).toMatchObject({ seq: 0, visitorId: chunks[0]!.visitorId });
    expect(next[0]!.meta).toMatchObject({ url: 'Home', screenWidth: 390 });
    const events = next[0]!.events as { type: number; data: Record<string, unknown> }[];
    expect(events.slice(0, 3).map((e) => e.type)).toEqual([EVENT.meta, EVENT.meta, EVENT.fullSnapshot]);
    expect(events[1]!.data).toEqual({ href: 'Home' });
    expect(next[0]!.flags).toEqual({ pageCount: 1 });
    // The same person came back, so the new session is theirs too.
    await vi.waitFor(() => expect(f.posts.filter((p) => p.url.endsWith('/identify')).map((p) => p.body.sessionId)).toContain(rec.sessionId()));
    expect(await store.getItem('anyreplay.sid')).toBe(rec.sessionId());
    expect(await store.getItem('anyreplay.seq')).not.toBeNull();
  });

  it('keeps the session after a shorter absence, and sends a whole screen again', async () => {
    const f = fakeHost();
    f.setScreen(el({ id: 2, tag: 'Text', text: 'Merhaba' }));
    const rec = await createRecorder({ projectKey: KEY, storage: new MemoryStore() }, f.host);
    await rec.flush();
    const first = rec.sessionId();

    f.advance(29 * 60 * 1000);
    rec.foreground();
    f.tickSnapshot();
    await rec.flush();

    expect(rec.sessionId()).toBe(first);
    expect(f.eventsSent().filter((e) => e.type === EVENT.fullSnapshot)).toHaveLength(2);
  });
});

/**
 * Ingest as it behaves: a chunk creates the session, and identify attaches
 * traits to a session that exists — to one that does not it answers `202
 * { applied: false }` and keeps nothing (contract §8.2).
 */
function fakeIngest(options: { forgetFirstIdentify?: boolean } = {}) {
  const sessions = new Set<string>();
  const identifies: { sessionId: string; userId?: string; email?: string; appliedTo: boolean }[] = [];
  let forget = options.forgetFirstIdentify === true;
  const fetch = (async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { sessionId: string; userId?: string; email?: string };
    if (String(url).endsWith('/v1/ingest/events')) {
      sessions.add(body.sessionId);
      return new Response(JSON.stringify({ accepted: true, duplicate: false }), { status: 202 });
    }
    // A server that lost a race: the row is there, but this answer says it was not.
    const applied = sessions.has(body.sessionId) && !forget;
    forget = false;
    identifies.push({ ...body, appliedTo: applied });
    return new Response(JSON.stringify({ applied }), { status: applied ? 200 : 202 });
  }) as unknown as typeof globalThis.fetch;
  const linked = () => identifies.filter((i) => i.appliedTo).map((i) => `${i.sessionId}:${i.userId ?? i.email}`);
  return { fetch, identifies, linked };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('identify and the session it names', () => {
  it('holds an identity given right after init until the first chunk has made the session', async () => {
    const server = fakeIngest();
    const f = fakeHost({ fetch: server.fetch });
    f.setScreen(el({ id: 2, tag: 'Text', text: 'Merhaba' }));
    const rec = await createRecorder({ projectKey: KEY, storage: new MemoryStore() }, f.host);
    rec.identify({ userId: 'u1', email: 'ada@example.com' });
    await settle();
    expect(server.identifies).toHaveLength(0);

    await rec.flush();
    await vi.waitFor(() => expect(server.linked()).toEqual([`${rec.sessionId()}:u1`]));
    expect(server.identifies[0]).toMatchObject({ userId: 'u1', email: 'ada@example.com' });

    rec.touch(10, 10);
    await rec.flush();
    await settle();
    expect(server.identifies).toHaveLength(1);
  });

  it('holds one given through the module before init finished, too', async () => {
    const server = fakeIngest();
    const f = fakeHost({ fetch: server.fetch });
    f.setScreen(el({ id: 2 }));
    const ready = init({ projectKey: KEY, storage: new MemoryStore() }, f.host);
    identify({ userId: 'u_early' });
    const rec = (await ready)!;
    await settle();
    expect(server.identifies).toHaveLength(0);
    await rec.flush();
    await vi.waitFor(() => expect(server.linked()).toEqual([`${rec.sessionId()}:u_early`]));
    stop();
  });

  it('sends an identity given once the session exists straight away', async () => {
    const server = fakeIngest();
    const f = fakeHost({ fetch: server.fetch });
    f.setScreen(el({ id: 2 }));
    const rec = await createRecorder({ projectKey: KEY, storage: new MemoryStore() }, f.host);
    await rec.flush();
    rec.identify({ userId: 'u2' });
    await vi.waitFor(() => expect(server.linked()).toEqual([`${rec.sessionId()}:u2`]));
  });

  it('tries once more, after the next accepted chunk, when ingest says it applied nothing', async () => {
    const server = fakeIngest({ forgetFirstIdentify: true });
    const f = fakeHost({ fetch: server.fetch });
    f.setScreen(el({ id: 2 }));
    const rec = await createRecorder({ projectKey: KEY, storage: new MemoryStore() }, f.host);
    await rec.flush();
    rec.identify({ userId: 'u3' });
    await vi.waitFor(() => expect(server.identifies).toHaveLength(1));
    expect(server.identifies[0]!.appliedTo).toBe(false);
    await settle();

    rec.touch(10, 10);
    await rec.flush();
    await vi.waitFor(() => expect(server.linked()).toEqual([`${rec.sessionId()}:u3`]));

    rec.touch(20, 20);
    await rec.flush();
    await settle();
    expect(server.identifies).toHaveLength(2);
  });

  it('names the session after a long absence once that session exists', async () => {
    const server = fakeIngest();
    const f = fakeHost({ fetch: server.fetch });
    f.setScreen(el({ id: 2 }));
    const rec = await createRecorder({ projectKey: KEY, storage: new MemoryStore() }, f.host);
    rec.identify({ userId: 'u4' });
    await rec.flush();
    const first = rec.sessionId();
    await vi.waitFor(() => expect(server.linked()).toEqual([`${first}:u4`]));

    f.advance(31 * 60 * 1000);
    rec.foreground();
    await rec.flush();
    await vi.waitFor(() => expect(server.linked()).toEqual([`${first}:u4`, `${rec.sessionId()}:u4`]));
    // Each session's identify was applied the first time: none went before its session existed.
    expect(server.identifies.every((i) => i.appliedTo)).toBe(true);
  });
});

describe('a full quota', () => {
  const quota = () => fakeHost({
    fetch: (async () => ({ ok: false, status: 402 }) as Response) as unknown as typeof fetch,
  });

  /** The browser SDK's rule: a quota is a monthly fact, and asking again on every launch is a flood. */
  it('stops, and does not start again for two minutes across launches', async () => {
    const store = new MemoryStore();
    const first = quota();
    first.setScreen(el({ id: 2 }));
    const rec = await createRecorder({ projectKey: KEY, storage: store }, first.host);
    await rec.flush();
    expect(rec.status()).toBe('stopped');
    await vi.waitFor(async () => expect(await store.getItem('anyreplay.cd')).not.toBeNull());

    const second = fakeHost();
    second.setScreen(el({ id: 2 }));
    second.advance(60_000);
    const again = await createRecorder({ projectKey: KEY, storage: store }, second.host);
    expect(again.status()).toBe('stopped');
    second.tickFlush();
    expect(second.posts).toEqual([]);

    const later = fakeHost();
    later.setScreen(el({ id: 2 }));
    later.advance(2 * 60_000 + 1);
    const recovered = await createRecorder({ projectKey: KEY, storage: store }, later.host);
    expect(recovered.status()).toBe('recording');
  });

  it('forgets the cool-down with everything else when consent is withdrawn', async () => {
    const store = new MemoryStore();
    const f = quota();
    f.setScreen(el({ id: 2 }));
    const rec = await createRecorder({ projectKey: KEY, storage: store }, f.host);
    await rec.flush();
    await vi.waitFor(async () => expect(await store.getItem('anyreplay.cd')).not.toBeNull());
    rec.consent(false);
    await vi.waitFor(async () => expect(await store.getItem('anyreplay.cd')).toBeNull());
  });
});

describe('a long outage', () => {
  /**
   * Dropping the oldest buffered events used to leave the mutations after
   * them pointing at nodes the reader never received, until the next
   * navigation. Now the next thing the tree gets is a whole tree.
   */
  it('sends a whole screen after dropping events, so nothing points at a lost tree', async () => {
    let online = false;
    const delivered: Record<string, unknown>[] = [];
    const f = fakeHost({
      fetch: (async (_url: string, init: { body: string }) => {
        if (!online) throw new Error('offline');
        delivered.push(JSON.parse(init.body));
        return { ok: true, status: 202 } as Response;
      }) as unknown as typeof fetch,
    });
    f.setScreen(el({ id: 2, children: [4] }), el({ id: 4, tag: 'Text', text: 'sayaç 0' }));
    const rec = await createRecorder({ projectKey: KEY, maxBufferedEvents: 20, storage: new MemoryStore() }, f.host);
    rec.screen('Sayaç');
    for (let n = 1; n <= 40; n += 1) {
      f.advance(500);
      // Each tick adds a node, so a mutation after a lost one names a parent the reader never saw.
      f.setScreen(
        el({ id: 2, children: [4, ...Array.from({ length: n }, (_, i) => 100 + i * 2)] }),
        el({ id: 4, tag: 'Text', text: `sayaç ${n}` }),
        ...Array.from({ length: n }, (_, i) => el({ id: 100 + i * 2, tag: 'Text', text: `satır ${i}` })),
      );
      f.tickSnapshot();
      if (n % 10 === 0) await rec.flush();
    }
    online = true;
    f.advance(60_000);
    f.tickSnapshot();
    await rec.flush();

    expect(delivered.length).toBeGreaterThan(0);
    const events = delivered.flatMap((c) => c.events as { type: number; data: Record<string, unknown> }[]);
    const snapshot = events.findIndex((e) => e.type === EVENT.fullSnapshot);
    // The canvas and the screen name come back before the tree does, and no
    // mutation arrives before it: each would name nodes the reader never got.
    expect(events.slice(snapshot - 2, snapshot).map((e) => e.data)).toEqual([{ width: 390, height: 844 }, { href: 'Sayaç' }]);
    expect(events.slice(0, snapshot).some((e) => e.type === EVENT.incremental && e.data.source === SOURCE.mutation)).toBe(false);
    // (conformance.test.ts reads a stream like this one with the checker.)
    expect(rec.status()).toBe('recording');
  });
});
