import { createRecorder, type ClipRing, type RecorderHandle } from '../src/recorder';
import { CLIP_AFTERMATH_MS, CLIP_COOLDOWN_MS, CLIP_SENT_KEY, CONFIG_KEY } from '../src/clip';
import { ERROR_TAG } from '../src/diagnostics';
import { SESSION_KEY, VISITOR_KEY } from '../src/visitor';

/**
 * Crash clips and fatal errors, against the real rrweb in jsdom. Only `fetch`
 * is stubbed: chunks are read back as ingest would receive them, and the
 * config request is answered by URL.
 */
const KEY = 'ar_pk_live_0123456789abcdef01234567';

interface SentChunk {
  sessionId: string;
  visitorId: string;
  seq: number;
  events: { type: number; timestamp: number; data?: { tag?: string; payload?: Record<string, unknown> } }[];
  meta?: Record<string, unknown>;
  flags?: Record<string, unknown>;
}

function mockIngest(config: Record<string, unknown> | null = { crashClip: true, maskAllInputs: true }) {
  const chunks: SentChunk[] = [];
  const configCalls: string[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/v1/ingest/config')) {
      configCalls.push(url);
      return config ? new Response(JSON.stringify(config), { status: 200 }) : new Response('{}', { status: 404 });
    }
    chunks.push(JSON.parse(String(init?.body)) as SentChunk);
    return new Response(JSON.stringify({ accepted: true, duplicate: false }), { status: 202 });
  });
  vi.stubGlobal('fetch', fn);
  return { chunks, configCalls, fn };
}

const handles: RecorderHandle[] = [];
const start = (overrides: Record<string, unknown> = {}): RecorderHandle => {
  const handle = createRecorder({
    projectKey: KEY, ingestUrl: 'https://in.test', flushIntervalMs: 1_000_000, sampleRate: 0, ...overrides,
  });
  handles.push(handle);
  return handle;
};

/** Lets the config answer arrive and rrweb take its first snapshot. */
const settle = () => vi.advanceTimersByTimeAsync(10);

const errorsIn = (chunk: SentChunk) => chunk.events.filter((e) => e.type === 5 && e.data?.tag === ERROR_TAG);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  localStorage.clear();
  sessionStorage.clear();
  document.body.innerHTML = '<main><h1>Checkout</h1><input id="name" value="Ada Lovelace"><button id="pay">Pay</button></main>';
});

afterEach(() => {
  for (const handle of handles.splice(0)) handle.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('crash clips', () => {
  it('sends nothing for a sampled-out visitor until something breaks', async () => {
    const { chunks } = mockIngest();
    const handle = start({ crashClip: true });
    await settle();
    expect(handle.status()).toBe('sampled-out');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(chunks).toEqual([]);
  });

  it('uploads the buffer as a session of its own after a fatal error, with the aftermath', async () => {
    const { chunks } = mockIngest();
    const handle = start({ crashClip: true });
    await settle();
    const before = Date.now();
    handle.trackError(new Error('checkout state lost'), { fatal: true });
    document.getElementById('pay')!.textContent = 'Paying…';
    await vi.advanceTimersByTimeAsync(CLIP_AFTERMATH_MS - 50);
    expect(chunks).toEqual([]);
    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(chunks.length).toBeGreaterThan(0));

    const [first] = chunks;
    expect(first!.seq).toBe(0);
    expect(first!.meta).toMatchObject({ kind: 'crash_clip', platform: 'web' });
    expect(first!.meta).not.toHaveProperty('sessionCap');
    // Starts on a snapshot, and says so.
    expect(first!.events[0]!.type).toBe(4);
    expect(first!.events[1]!.type).toBe(2);
    expect(first!.meta!.startedAt).toBe(first!.events[0]!.timestamp);
    expect(first!.meta!.startedAt as number).toBeLessThanOrEqual(before);
    expect(first!.flags).toMatchObject({ hasError: true });
    // A fresh session id, not the one the visitor's pages share.
    expect(first!.sessionId).not.toBe(sessionStorage.getItem(SESSION_KEY));
    expect(first!.visitorId).toBe(localStorage.getItem(VISITOR_KEY));
    expect(errorsIn(first!).map((e) => e.data!.payload!.kind)).toEqual(['fatal']);
    // The change made after the error is in it too.
    expect(first!.events.some((e) => e.type === 3 && e.timestamp >= before)).toBe(true);
  });

  it('cuts a clip on an uncaught window error, but not on a handled one', async () => {
    const { chunks } = mockIngest();
    const handle = start({ crashClip: true });
    await settle();
    handle.trackError(new Error('handled'));
    await vi.advanceTimersByTimeAsync(CLIP_AFTERMATH_MS + 10);
    expect(chunks).toEqual([]);

    window.dispatchEvent(new ErrorEvent('error', { error: new TypeError('x is undefined'), message: 'x is undefined' }));
    await vi.advanceTimersByTimeAsync(CLIP_AFTERMATH_MS + 10);
    await vi.waitFor(() => expect(chunks.length).toBeGreaterThan(0));
    expect(chunks[0]!.meta!.kind).toBe('crash_clip');
    expect(errorsIn(chunks[0]!).map((e) => e.data!.payload!.kind)).toEqual(['error', 'error']);
  });

  it('cuts at most one clip per visitor every five minutes', async () => {
    const { chunks } = mockIngest();
    const handle = start({ crashClip: true });
    await settle();
    handle.trackError(new Error('one'), { fatal: true });
    await vi.advanceTimersByTimeAsync(CLIP_AFTERMATH_MS + 10);
    await vi.waitFor(() => expect(chunks.length).toBeGreaterThan(0));
    const sessions = () => new Set(chunks.map((c) => c.sessionId)).size;
    expect(sessions()).toBe(1);
    expect(Number(localStorage.getItem(CLIP_SENT_KEY))).toBeGreaterThan(0);

    handle.trackError(new Error('two'), { fatal: true });
    await vi.advanceTimersByTimeAsync(CLIP_AFTERMATH_MS + 10);
    expect(sessions()).toBe(1);

    // Clip mode carried on after the first clip: the next checkout, ten
    // seconds after the last snapshot, starts the ring again.
    await vi.advanceTimersByTimeAsync(11_000);
    document.body.append('later');
    await settle();
    // Five minutes on (the stamp is what any page of the visitor reads).
    localStorage.setItem(CLIP_SENT_KEY, String(Date.now() - CLIP_COOLDOWN_MS - 1));
    handle.trackError(new Error('three'), { fatal: true });
    await vi.advanceTimersByTimeAsync(CLIP_AFTERMATH_MS + 10);
    await vi.waitFor(() => expect(sessions()).toBe(2));
  });

  it('does not clip a fatal error reported from an earlier run', async () => {
    const { chunks } = mockIngest();
    const handle = start({ crashClip: true });
    await settle();
    handle.trackError(new Error('main process died yesterday'), { fatal: true, clip: false });
    await vi.advanceTimersByTimeAsync(CLIP_AFTERMATH_MS + 10);
    expect(chunks).toEqual([]);
  });

  it('records nothing without consent, and a refusal ends clip mode and forgets its keys', async () => {
    const { chunks, configCalls } = mockIngest();
    const handle = start({ crashClip: true, requireConsent: true });
    handle.trackError(new Error('before consent'), { fatal: true });
    await vi.advanceTimersByTimeAsync(CLIP_AFTERMATH_MS + 10);
    expect(chunks).toEqual([]);
    expect(configCalls).toEqual([]);

    handle.consent(true);
    await settle();
    handle.trackError(new Error('after consent'), { fatal: true });
    await vi.advanceTimersByTimeAsync(CLIP_AFTERMATH_MS + 10);
    await vi.waitFor(() => expect(chunks.length).toBeGreaterThan(0));
    const sent = chunks.length;
    localStorage.setItem(CONFIG_KEY, '{}');

    handle.consent(false);
    expect(localStorage.getItem(CLIP_SENT_KEY)).toBeNull();
    expect(localStorage.getItem(CONFIG_KEY)).toBeNull();
    // Handled here, so the test runner does not report it as its own.
    window.addEventListener('error', (event) => event.preventDefault(), { once: true });
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('after refusal'), cancelable: true }));
    await vi.advanceTimersByTimeAsync(CLIP_AFTERMATH_MS + 10);
    expect(chunks).toHaveLength(sent);
  });

  it('asks the project when the page did not decide, and makes no clip when it says no', async () => {
    const { chunks, configCalls } = mockIngest({ crashClip: false, maskAllInputs: true });
    const handle = start();
    await settle();
    expect(configCalls).toHaveLength(1);
    handle.trackError(new Error('boom'), { fatal: true });
    await vi.advanceTimersByTimeAsync(CLIP_AFTERMATH_MS + 10);
    expect(chunks).toEqual([]);
  });

  it('clips when the project says yes, from a cached answer on the next page', async () => {
    const { chunks, configCalls } = mockIngest({ crashClip: true, maskAllInputs: true });
    start();
    await settle();
    handles.splice(0).forEach((h) => h.stop());
    const handle = start();
    await settle();
    expect(configCalls).toHaveLength(1);
    handle.trackError(new Error('boom'), { fatal: true });
    await vi.advanceTimersByTimeAsync(CLIP_AFTERMATH_MS + 10);
    await vi.waitFor(() => expect(chunks.length).toBeGreaterThan(0));
  });

  it('lets crashClip: false in the page win without asking, and makes no clip without an answer', async () => {
    const off = mockIngest({ crashClip: true, maskAllInputs: true });
    const handle = start({ crashClip: false });
    await settle();
    handle.trackError(new Error('boom'), { fatal: true });
    await vi.advanceTimersByTimeAsync(CLIP_AFTERMATH_MS + 10);
    expect(off.configCalls).toEqual([]);
    expect(off.chunks).toEqual([]);
    handles.splice(0).forEach((h) => h.stop());

    const down = mockIngest(null);
    const other = start();
    await settle();
    other.trackError(new Error('boom'), { fatal: true });
    await vi.advanceTimersByTimeAsync(CLIP_AFTERMATH_MS + 10);
    expect(down.configCalls).toHaveLength(1);
    expect(down.chunks).toEqual([]);
  });

  it('masks the clip as it would mask a recording, and follows the project\'s masking answer', async () => {
    const masked = mockIngest({ crashClip: true, maskAllInputs: true });
    start().trackError(new Error('boom'), { fatal: true });
    await settle();
    // The config answer arrives after the fatal call above: no clip mode yet, so no clip.
    expect(masked.chunks).toEqual([]);
    handles.splice(0).forEach((h) => h.stop());
    localStorage.removeItem(CLIP_SENT_KEY);

    const handle = start();
    await settle();
    handle.trackError(new Error('boom'), { fatal: true });
    await vi.advanceTimersByTimeAsync(CLIP_AFTERMATH_MS + 10);
    await vi.waitFor(() => expect(masked.chunks.length).toBeGreaterThan(0));
    const text = JSON.stringify(masked.chunks.flatMap((c) => c.events));
    expect(text).not.toContain('Ada Lovelace');
    handles.splice(0).forEach((h) => h.stop());

    localStorage.clear();
    const open = mockIngest({ crashClip: true, maskAllInputs: false });
    const unmasked = start();
    await settle();
    unmasked.trackError(new Error('boom'), { fatal: true });
    await vi.advanceTimersByTimeAsync(CLIP_AFTERMATH_MS + 10);
    await vi.waitFor(() => expect(open.chunks.length).toBeGreaterThan(0));
    expect(JSON.stringify(open.chunks.flatMap((c) => c.events))).toContain('Ada Lovelace');
  });

  it('makes no clip for a recorded visitor, and never asks for the config', async () => {
    const { chunks, configCalls } = mockIngest();
    const handle = start({ sampleRate: 1, crashClip: true });
    await settle();
    handle.trackError(new Error('boom'), { fatal: true });
    await vi.advanceTimersByTimeAsync(CLIP_AFTERMATH_MS + 10);
    expect(configCalls).toEqual([]);
    expect(chunks.every((c) => c.meta?.kind === undefined)).toBe(true);
  });
});

describe('trackError(error, { fatal: true })', () => {
  it('records kind fatal on a recording, flags it and sends it at once', async () => {
    const { chunks } = mockIngest();
    // An explicit masking choice: no early first chunk to blur what is measured.
    const handle = start({ sampleRate: 1, maskAllInputs: true });
    await settle();
    expect(chunks).toEqual([]);
    handle.trackError(new Error('out of memory'), { fatal: true });
    // No explicit flush: the fatal error sends what the session holds.
    await vi.advanceTimersByTimeAsync(10);
    await vi.waitFor(() => expect(chunks.length).toBeGreaterThan(0));
    const errors = chunks.flatMap(errorsIn);
    expect(errors.map((e) => e.data!.payload!.kind)).toEqual(['fatal']);
    expect(errors[0]!.data!.payload!.message).toBe('Error: out of memory');
    expect(chunks.at(-1)!.flags).toMatchObject({ hasError: true });
  });

  it('holds a fatal error from before consent like any other', async () => {
    const { chunks } = mockIngest();
    const handle = start({ sampleRate: 1, requireConsent: true });
    handle.trackError('fatal before consent', { fatal: true });
    handle.consent(true);
    await settle();
    await handle.flush();
    expect(chunks.flatMap(errorsIn).map((e) => e.data!.payload!.kind)).toEqual(['fatal']);
  });
});

describe('the ring, for a shell that keeps it natively', () => {
  it('is handed over each time a segment is complete, and null when clip mode ends', async () => {
    mockIngest();
    const rings: (ClipRing | null)[] = [];
    const handle = createRecorder(
      { projectKey: KEY, ingestUrl: 'https://in.test', flushIntervalMs: 1_000_000, sampleRate: 0, crashClip: true },
      { platform: 'capacitor', sdk: { name: '@anyreplay/capacitor', version: '9.9.9' }, onClipRing: (ring) => { rings.push(ring); } },
    );
    handles.push(handle);
    await settle();
    expect(rings).toEqual([]);
    // rrweb checks out (a new Meta and snapshot) on the first change after the interval.
    const change = async (text: string) => {
      document.getElementById('pay')!.textContent = text;
      await vi.advanceTimersByTimeAsync(50);
    };
    await change('Pay now');
    await vi.advanceTimersByTimeAsync(10_500);
    await change('Paying…');
    expect(rings).toHaveLength(1);
    const ring = rings[0]!;
    expect(ring.events[0]!.type).toBe(4);
    expect(ring.events[1]!.type).toBe(2);
    expect(ring.meta).toMatchObject({ platform: 'capacitor', sdk: { name: '@anyreplay/capacitor' } });
    expect(ring.meta).not.toHaveProperty('sessionCap');
    await vi.advanceTimersByTimeAsync(10_000);
    await change('Paid');
    expect(rings).toHaveLength(2);
    expect(rings[1]!.events.length).toBeGreaterThan(ring.events.length);
    handle.consent(false);
    expect(rings[rings.length - 1]).toBeNull();
  });

  it('is never handed over for a recorded visitor', async () => {
    mockIngest();
    const rings: unknown[] = [];
    const handle = createRecorder(
      { projectKey: KEY, ingestUrl: 'https://in.test', flushIntervalMs: 1_000_000, crashClip: true },
      { platform: 'capacitor', sdk: { name: '@anyreplay/capacitor', version: '9.9.9' }, onClipRing: (ring) => { rings.push(ring); } },
    );
    handles.push(handle);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(handle.status()).toBe('recording');
    handle.stop();
    expect(rings).toEqual([]);
  });
});
