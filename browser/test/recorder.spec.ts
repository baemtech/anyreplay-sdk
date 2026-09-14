import { createRecorder, type RecorderHandle } from '../src/recorder';
import { NAVIGATE_TAG, TRACK_TAG } from '../src/events';
import { COOLDOWN_KEY, PAGE_KEY, QUOTA_COOLDOWN_MS, SEQ_KEY } from '../src/visitor';

/**
 * These drive the real rrweb recorder in jsdom. Only `fetch` is stubbed, the
 * way the transport tests stub it: what is asserted is the exact body ingest
 * would have received.
 */
const KEY = 'ar_pk_live_0123456789abcdef01234567';

interface SentChunk {
  seq: number;
  events: { type: number; timestamp: number; data?: { tag?: string; payload?: unknown } }[];
  meta?: Record<string, unknown>;
  flags?: Record<string, unknown>;
}

const ok = () => new Response(JSON.stringify({ accepted: true, duplicate: false }), { status: 202 });
const duplicate = (nextSeq: number) =>
  new Response(JSON.stringify({ accepted: true, duplicate: true, nextSeq }), { status: 202 });
const refused = (status: number) => new Response('{}', { status });

function mockFetch(responses: (Response | Error)[] = [ok()]) {
  const calls: SentChunk[] = [];
  let index = 0;
  const fn = vi.fn(async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)) as SentChunk);
    const next = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    if (next instanceof Error) throw next;
    // A Response body can be read once; each call gets its own copy.
    return next.clone();
  });
  vi.stubGlobal('fetch', fn);
  return { calls, fn };
}

const customEvents = (chunk: SentChunk) => chunk.events.filter((e) => e.type === 5);
const tagged = (chunk: SentChunk, tag: string) => customEvents(chunk).filter((e) => e.data?.tag === tag);

const handles: RecorderHandle[] = [];
const start = (overrides: Record<string, unknown> = {}): RecorderHandle => {
  // A long interval: every flush in these tests is explicit.
  const handle = createRecorder({ projectKey: KEY, ingestUrl: 'https://in.test', flushIntervalMs: 1_000_000, ...overrides });
  handles.push(handle);
  return handle;
};

const originalPushState = history.pushState;
const originalReplaceState = history.replaceState;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  document.body.innerHTML = '<main><h1>Test page</h1><button id="buy">Buy</button></main>';
  document.title = 'Test page';
  history.replaceState(null, '', '/');
});

afterEach(() => {
  for (const handle of handles.splice(0)) handle.stop();
  history.pushState = originalPushState;
  history.replaceState = originalReplaceState;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('track()', () => {
  it('puts the moment into the chunk stream, after the snapshot, with the recording clock', async () => {
    const { calls } = mockFetch();
    const handle = start();
    const before = Date.now();
    handle.track('checkout_started', { cart: 3, coupon: null });
    await handle.flush();

    expect(calls).toHaveLength(1);
    const types = calls[0]!.events.map((e) => e.type);
    // Meta, then the full snapshot, then the tracked moment.
    expect(types.indexOf(2)).toBeLessThan(types.indexOf(5));
    const [event] = tagged(calls[0]!, TRACK_TAG);
    expect(event!.data).toEqual({ tag: TRACK_TAG, payload: { name: 'checkout_started', properties: { cart: 3, coupon: null } } });
    expect(event!.timestamp).toBeGreaterThanOrEqual(before);
  });

  it('sends an empty object when there are no properties', async () => {
    const { calls } = mockFetch();
    start().track('signup');
    await handles[0]!.flush();
    expect(tagged(calls[0]!, TRACK_TAG)[0]!.data!.payload).toEqual({ name: 'signup', properties: {} });
  });

  it('ignores a bad name or oversize properties, warning only in debug mode', async () => {
    const { calls } = mockFetch();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handle = start({ debug: true });

    handle.track('has spaces');
    handle.track('');
    handle.track('x'.repeat(65));
    handle.track('big', { blob: 'x'.repeat(5000) });
    handle.track('list', ['no'] as unknown as Record<string, unknown>);
    handle.track('fine', { ok: true });
    await handle.flush();

    expect(tagged(calls[0]!, TRACK_TAG).map((e) => (e.data!.payload as { name: string }).name)).toEqual(['fine']);
    expect(warn).toHaveBeenCalledTimes(5);
    expect(warn.mock.calls[0]![0]).toMatch(/track\(\) ignored/);
  });

  it('says nothing about a bad call unless debugging', () => {
    mockFetch();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    start().track('has spaces');
    expect(warn).not.toHaveBeenCalled();
  });

  it('never throws into the page, whatever it is given', () => {
    mockFetch();
    const handle = start();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => handle.track(undefined as unknown as string)).not.toThrow();
    expect(() => handle.track('x', circular)).not.toThrow();
    expect(() => handle.track('x', { fn: () => 1 })).not.toThrow();
  });

  it('queues events tracked while consent is pending and emits them once recording begins', async () => {
    const { calls, fn } = mockFetch();
    const handle = start({ requireConsent: true });
    handle.track('first');
    handle.track('second');
    expect(handle.status()).toBe('awaiting-consent');
    expect(fn).not.toHaveBeenCalled();

    handle.consent(true);
    await handle.flush();

    const names = tagged(calls[0]!, TRACK_TAG).map((e) => (e.data!.payload as { name: string }).name);
    expect(names).toEqual(['first', 'second']);
    const types = calls[0]!.events.map((e) => e.type);
    expect(types.indexOf(2)).toBeLessThan(types.indexOf(5));
  });

  it('keeps the oldest queued events when the queue is full', async () => {
    const { calls } = mockFetch();
    const handle = start({ requireConsent: true });
    for (let i = 0; i < 40; i += 1) handle.track(`e${i}`);
    handle.consent(true);
    await handle.flush();

    const names = tagged(calls[0]!, TRACK_TAG).map((e) => (e.data!.payload as { name: string }).name);
    expect(names).toHaveLength(32);
    expect(names[0]).toBe('e0');
    expect(names.at(-1)).toBe('e31');
  });

  it('holds an event tracked before the document has loaded until rrweb is emitting', async () => {
    const { calls } = mockFetch();
    // rrweb defers its first snapshot to `load` while the document is loading;
    // until then addCustomEvent throws, which the recorder must absorb.
    Object.defineProperty(document, 'readyState', { value: 'loading', configurable: true });
    const handle = start();
    handle.track('boot');
    await handle.flush();
    expect(calls).toHaveLength(0);

    Object.defineProperty(document, 'readyState', { value: 'complete', configurable: true });
    window.dispatchEvent(new Event('load'));
    // Nothing else happens on the page: the queue must be handed over anyway.
    await vi.waitFor(async () => {
      await handle.flush();
      expect(calls.flatMap((c) => tagged(c, TRACK_TAG))).toHaveLength(1);
    });

    const events = calls.flatMap((c) => c.events);
    const types = events.map((e) => e.type);
    expect(types.indexOf(2)).toBeLessThan(types.indexOf(5));
    expect(tagged({ seq: 0, events }, TRACK_TAG).map((e) => (e.data!.payload as { name: string }).name)).toEqual(['boot']);
  });

  it('drops events tracked after recording stopped, without throwing', async () => {
    const { fn } = mockFetch();
    const handle = start();
    await handle.flush();
    handle.stop();
    expect(() => handle.track('late')).not.toThrow();
    await handle.flush();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('is a no-op for a sampled-out visitor', () => {
    const { fn } = mockFetch();
    const handle = start({ sampleRate: 0 });
    expect(handle.status()).toBe('sampled-out');
    expect(() => handle.track('x', { a: 1 })).not.toThrow();
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('route changes', () => {
  it('marks a pushState navigation and counts the page', async () => {
    const { calls } = mockFetch();
    const handle = start();
    document.title = 'Pricing';
    history.pushState({}, '', '/pricing?plan=team');
    await handle.flush();

    const [marker] = tagged(calls[0]!, NAVIGATE_TAG);
    expect(marker!.data!.payload).toEqual({ url: 'http://localhost:3000/pricing?plan=team', title: 'Pricing' });
    expect(calls[0]!.flags).toMatchObject({ pageCount: 2 });
    expect(sessionStorage.getItem(PAGE_KEY)).toBe('2');
  });

  it('counts replaceState only when the URL actually changes', async () => {
    const { calls } = mockFetch();
    const handle = start();
    history.replaceState({ scroll: 10 }, '', '/');
    history.replaceState({ scroll: 20 }, '', '/');
    await handle.flush();
    expect(tagged(calls[0]!, NAVIGATE_TAG)).toHaveLength(0);
    expect(calls[0]!.flags).toMatchObject({ pageCount: 1 });

    history.replaceState(null, '', '/step-2');
    handle.track('poke');
    await handle.flush();
    expect(tagged(calls[1]!, NAVIGATE_TAG)).toHaveLength(1);
    expect(calls[1]!.flags).toMatchObject({ pageCount: 2 });
  });

  it('marks the back button', async () => {
    const { calls } = mockFetch();
    const handle = start();
    history.pushState(null, '', '/a');
    history.pushState(null, '', '/b');
    history.back();
    await vi.waitFor(() => expect(location.pathname).toBe('/a'));
    await handle.flush();

    const urls = tagged(calls[0]!, NAVIGATE_TAG).map((e) => (e.data!.payload as { url: string }).url);
    expect(urls.map((u) => new URL(u).pathname)).toEqual(['/a', '/b', '/a']);
    expect(calls[0]!.flags).toMatchObject({ pageCount: 4 });
  });

  it('leaves the return value and arguments of pushState alone', () => {
    mockFetch();
    start();
    expect(history.pushState({ x: 1 }, '', '/x')).toBeUndefined();
    expect(history.state).toEqual({ x: 1 });
    expect(location.pathname).toBe('/x');
  });
});

describe('continuity across a reload', () => {
  it('resumes the session, continues chunk numbering, and counts the new page', async () => {
    const { calls } = mockFetch();
    const first = start({ maxSessionsPerMonth: 500 });
    await first.flush();
    first.track('before-reload');
    await first.flush();
    first.stop();
    expect(calls.map((c) => c.seq)).toEqual([0, 1]);
    expect(calls[0]!.meta).toMatchObject({ sessionCap: 500 });

    // The next page: same tab, same sessionStorage.
    const second = start({ maxSessionsPerMonth: 500 });
    expect(second.sessionId()).toBe(first.sessionId());
    expect(second.status()).toBe('recording');
    await second.flush();

    expect(calls).toHaveLength(3);
    expect(calls[2]!.seq).toBe(2);
    // A fresh snapshot opens the new page.
    expect(calls[2]!.events.map((e) => e.type).slice(0, 2)).toEqual([4, 2]);
    expect(calls[2]!.flags).toMatchObject({ pageCount: 2 });
    // Meta describes the page, but the cap is only for the chunk that starts a session.
    expect(calls[2]!.meta).toBeDefined();
    expect(calls[2]!.meta).not.toHaveProperty('sessionCap');
  });

  it('moves to the number ingest names when the stored one was already used', async () => {
    const { calls } = mockFetch([ok(), duplicate(3), ok()]);
    const first = start();
    await first.flush();
    first.stop();
    // The previous page's last chunk left by beacon after this was written.
    sessionStorage.setItem(SEQ_KEY, '1');

    const second = start();
    await second.flush();
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    expect(calls.map((c) => c.seq)).toEqual([0, 1, 3]);
    // The events were not lost: the resend carries the same snapshot.
    expect(calls[2]!.events.map((e) => e.type)).toEqual(calls[1]!.events.map((e) => e.type));
    expect(sessionStorage.getItem(SEQ_KEY)).toBe('4');
  });

  it('starts over when the previous page was too long ago', async () => {
    mockFetch();
    const first = start();
    await first.flush();
    first.stop();
    sessionStorage.setItem('anyreplay.sts', String(Date.now() - 31 * 60 * 1000));

    const second = start();
    expect(second.sessionId()).not.toBe(first.sessionId());
    await second.flush();
    expect(sessionStorage.getItem(PAGE_KEY)).toBe('1');
  });
});

describe('stopping', () => {
  it('waits out a cool-down after ingest refuses a new session, then tries again', async () => {
    const { fn } = mockFetch([refused(402)]);
    const first = start();
    await first.flush();
    expect(first.status()).toBe('stopped');
    expect(fn).toHaveBeenCalledTimes(1);
    const until = Number(sessionStorage.getItem(COOLDOWN_KEY));
    expect(until).toBeGreaterThan(Date.now());
    expect(until).toBeLessThanOrEqual(Date.now() + QUOTA_COOLDOWN_MS);

    const second = start();
    expect(second.status()).toBe('stopped');
    second.track('ignored');
    await second.flush();
    expect(fn).toHaveBeenCalledTimes(1);

    sessionStorage.setItem(COOLDOWN_KEY, String(Date.now() - 1));
    const third = start();
    expect(third.status()).toBe('recording');
    await third.flush();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not carry a transport failure over to the next page', async () => {
    const { fn } = mockFetch([new Error('offline')]);
    const first = start({ maxConsecutiveFailures: 1 });
    await first.flush();
    expect(first.status()).toBe('stopped');
    expect(sessionStorage.getItem(COOLDOWN_KEY)).toBeNull();

    const second = start();
    expect(second.status()).toBe('recording');
    await second.flush();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not carry an origin or key rejection over either: one request per page notices the fix', async () => {
    const { fn } = mockFetch([refused(403)]);
    const first = start();
    await first.flush();
    expect(first.status()).toBe('stopped');
    expect(sessionStorage.getItem(COOLDOWN_KEY)).toBeNull();
    expect(start().status()).toBe('recording');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('the CDN global', () => {
  it('routes anyreplay("track", …) to the recorder', async () => {
    const { calls } = mockFetch();
    const { __execute } = await import('../src/cdn');
    __execute('init', { projectKey: KEY, ingestUrl: 'https://in.test', flushIntervalMs: 1_000_000 });
    __execute('track', 'cta_clicked', { id: 'hero' });
    __execute('flush');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(tagged(calls[0]!, TRACK_TAG)[0]!.data!.payload).toEqual({ name: 'cta_clicked', properties: { id: 'hero' } });
    __execute('stop');
  });
});
