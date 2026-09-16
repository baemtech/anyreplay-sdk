import { createRecorder, type RecorderHandle } from '../src/recorder';
import { NAVIGATE_TAG, TRACK_TAG } from '../src/events';
import { COOLDOWN_KEY, PAGE_KEY, QUOTA_COOLDOWN_MS, SEQ_KEY, SESSION_KEY, VISITOR_KEY } from '../src/visitor';

/**
 * These drive the real rrweb recorder in jsdom. Only `fetch` is stubbed, the
 * way the transport tests stub it: what is asserted is the exact body ingest
 * would have received.
 */
const KEY = 'ar_pk_live_0123456789abcdef01234567';

interface SentChunk {
  seq: number;
  visitorId?: string;
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

describe('consent', () => {
  /** A few seconds of a visitor using the page: clicks, typing, DOM changes, a route change, a tab switch. */
  const interact = async (): Promise<void> => {
    document.body.innerHTML += '<input id="name"><section id="live"></section>';
    const button = document.getElementById('buy')!;
    const input = document.getElementById('name') as HTMLInputElement;
    for (let second = 0; second < 5; second += 1) {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 10, clientY: 10 }));
      input.value = `ada ${second}`;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('live')!.appendChild(document.createElement('p'));
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('pagehide'));
      await vi.advanceTimersByTimeAsync(1000);
    }
    history.pushState(null, '', '/somewhere-else');
  };

  it('writes nothing, sends nothing and observes nothing until consent is granted', async () => {
    vi.useFakeTimers();
    try {
      const { calls, fn } = mockFetch();
      // The default flush interval, so the timer would have fired if it existed.
      const handle = start({ requireConsent: true, flushIntervalMs: 5000, maxSessionsPerMonth: 100 });
      handle.track('boot');
      await interact();

      expect(handle.status()).toBe('awaiting-consent');
      expect(handle.sessionId()).toBeNull();
      expect(localStorage.length).toBe(0);
      expect(sessionStorage.length).toBe(0);
      expect(fn).not.toHaveBeenCalled();
      // No hooks either: the router is untouched.
      expect(history.pushState).toBe(originalPushState);
      // Nothing to send, nothing to stop — and neither creates state.
      await handle.flush();
      expect(localStorage.length + sessionStorage.length).toBe(0);

      handle.consent(true);
      expect(handle.status()).toBe('recording');
      expect(handle.sessionId()).toMatch(/^[0-9a-f-]{36}$/);
      expect(localStorage.getItem(VISITOR_KEY)).toMatch(/^v[0-9a-f]{24}$/);
      expect(sessionStorage.getItem(SESSION_KEY)).toBe(handle.sessionId());
      await handle.flush();

      expect(calls).toHaveLength(1);
      expect(calls[0]!.seq).toBe(0);
      // A session that begins now: the snapshot, the cap, and the event queued while waiting.
      expect(calls[0]!.events.map((e) => e.type).slice(0, 2)).toEqual([4, 2]);
      expect(calls[0]!.meta).toMatchObject({ sessionCap: 100 });
      expect(tagged(calls[0]!, TRACK_TAG).map((e) => (e.data!.payload as { name: string }).name)).toEqual(['boot']);
      expect(calls[0]!.visitorId).toBe(localStorage.getItem(VISITOR_KEY));
    } finally {
      vi.useRealTimers();
    }
  });

  it('forgets the visitor when consent is withdrawn after it was granted', async () => {
    const { fn } = mockFetch();
    const handle = start({ requireConsent: true });
    handle.consent(true);
    await handle.flush();
    expect(fn).toHaveBeenCalledTimes(1);
    const visitorId = localStorage.getItem(VISITOR_KEY);
    expect(visitorId).not.toBeNull();

    handle.consent(false);
    expect(handle.status()).toBe('stopped');
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    // Stopped for good on this page: nothing more is recorded or sent.
    handle.track('after');
    handle.consent(true);
    expect(handle.status()).toBe('stopped');
    await handle.flush();
    expect(fn).toHaveBeenCalledTimes(1);

    // The next page starts out waiting again, and a fresh acceptance is a new visitor.
    const next = start({ requireConsent: true });
    expect(next.status()).toBe('awaiting-consent');
    expect(localStorage.length).toBe(0);
    next.consent(true);
    expect(localStorage.getItem(VISITOR_KEY)).not.toBe(visitorId);
  });

  it('honours a withdrawal made on a later page, when this page never recorded', async () => {
    const { fn } = mockFetch();
    const earlier = start();
    await earlier.flush();
    earlier.stop();
    expect(localStorage.length).toBe(1);
    expect(sessionStorage.length).toBeGreaterThan(0);

    const handle = start({ requireConsent: true });
    handle.consent(false);
    expect(handle.status()).toBe('stopped');
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not read an id left by an earlier acceptance as consent', async () => {
    const { fn } = mockFetch();
    // What an earlier page load stored — before a refusal the recorder cannot see.
    localStorage.setItem(VISITOR_KEY, 'v0123456789abcdef01234567');
    sessionStorage.setItem(SESSION_KEY, '11111111-1111-4111-8111-111111111111');
    sessionStorage.setItem('anyreplay.sts', String(Date.now()));

    const handle = start({ requireConsent: true });
    expect(handle.status()).toBe('awaiting-consent');
    expect(handle.sessionId()).toBeNull();
    await handle.flush();
    expect(fn).not.toHaveBeenCalled();
    // Untouched: nothing added, nothing refreshed.
    expect(localStorage.length).toBe(1);
    expect(sessionStorage.length).toBe(2);
  });

  it('decides sampling when consent is granted, not when the page loads', () => {
    const { fn } = mockFetch();
    const handle = start({ requireConsent: true, sampleRate: 0 });
    expect(handle.status()).toBe('awaiting-consent');
    expect(localStorage.length).toBe(0);

    handle.consent(true);
    expect(handle.status()).toBe('sampled-out');
    expect(fn).not.toHaveBeenCalled();
    // The decision is stored with the id, so it holds on the next page.
    expect(localStorage.getItem(VISITOR_KEY)).not.toBeNull();
    expect(() => handle.track('x')).not.toThrow();
    handle.identify({ userId: 'u1' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('keeps a cool-down from a refused session even when consent arrives later', async () => {
    const { fn } = mockFetch();
    sessionStorage.setItem(COOLDOWN_KEY, String(Date.now() + QUOTA_COOLDOWN_MS));
    const handle = start({ requireConsent: true });
    handle.consent(true);
    expect(handle.status()).toBe('stopped');
    await handle.flush();
    expect(fn).not.toHaveBeenCalled();
  });

  it('holds an identity given before consent and sends it once recording starts', async () => {
    const { fn } = mockFetch();
    const handle = start({ requireConsent: true });
    handle.identify({ userId: 'u1', email: 'ada@example.com' });
    expect(fn).not.toHaveBeenCalled();
    expect(localStorage.length + sessionStorage.length).toBe(0);

    handle.consent(true);
    await vi.waitFor(() => expect(fn.mock.calls.some(([url]) => String(url).endsWith('/v1/ingest/identify'))).toBe(true));
    const [, init] = fn.mock.calls.find(([url]) => String(url).endsWith('/v1/ingest/identify'))!;
    expect(JSON.parse(String(init.body))).toEqual({
      projectKey: KEY, sessionId: handle.sessionId(), userId: 'u1', email: 'ada@example.com',
    });
  });

  it('drops an identity given before consent when consent is refused', async () => {
    const { fn } = mockFetch();
    const handle = start({ requireConsent: true });
    handle.identify({ userId: 'u1' });
    handle.consent(false);
    await handle.flush();
    expect(fn).not.toHaveBeenCalled();
  });

  it('stays stopped after stop() even if consent is granted later', async () => {
    const { fn } = mockFetch();
    const handle = start({ requireConsent: true });
    handle.stop();
    expect(handle.status()).toBe('stopped');
    handle.consent(true);
    expect(handle.status()).toBe('stopped');
    await handle.flush();
    expect(fn).not.toHaveBeenCalled();
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });

  it('resolves the identity at once when consent is not required, as before', async () => {
    const { calls } = mockFetch();
    const handle = start();
    expect(handle.status()).toBe('recording');
    expect(handle.sessionId()).toMatch(/^[0-9a-f-]{36}$/);
    expect(localStorage.getItem(VISITOR_KEY)).toMatch(/^v[0-9a-f]{24}$/);
    expect(sessionStorage.getItem(SESSION_KEY)).toBe(handle.sessionId());
    expect(sessionStorage.getItem(PAGE_KEY)).toBe('1');
    await handle.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.visitorId).toBe(localStorage.getItem(VISITOR_KEY));

    // A sampled-out visitor still gets an id, so the decision holds across pages.
    localStorage.clear();
    const out = start({ sampleRate: 0 });
    expect(out.status()).toBe('sampled-out');
    expect(out.sessionId()).not.toBeNull();
    expect(localStorage.getItem(VISITOR_KEY)).not.toBeNull();
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
