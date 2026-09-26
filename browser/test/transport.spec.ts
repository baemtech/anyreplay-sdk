import { resolveOptions } from '../src/config';
import { Transport, withinKeepaliveLimit, type RecordedEvent } from '../src/transport';

const KEY = 'ar_pk_live_0123456789abcdef01234567';
const CONTEXT = { projectKey: KEY, sessionId: '11111111-1111-4111-8111-111111111111', visitorId: 'v123456789012' };

const options = (overrides = {}) =>
  resolveOptions({ projectKey: KEY, ingestUrl: 'https://in.test', flushIntervalMs: 50, ...overrides });

const event = (t = Date.now()): RecordedEvent => ({ type: 3, timestamp: t, data: { source: 2 } });

function mockFetch(responses: (Response | Error)[]) {
  const calls: { url: string; body: unknown }[] = [];
  let index = 0;
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (next instanceof Error) throw next;
    return next!;
  });
  vi.stubGlobal('fetch', fn);
  return { calls, fn };
}

const ok = () => new Response('{}', { status: 202 });
const status = (code: number) => new Response('{}', { status: code });

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Transport', () => {
  it('does not call the network when nothing is buffered', async () => {
    const { fn } = mockFetch([ok()]);
    const transport = new Transport(options(), CONTEXT);
    await transport.flush();
    expect(fn).not.toHaveBeenCalled();
  });

  it('sends buffered events with the session context', async () => {
    const { calls } = mockFetch([ok()]);
    const transport = new Transport(options(), CONTEXT);
    transport.setMeta({ startedAt: 1000, lang: 'tr-TR' });
    transport.push(event());
    transport.push(event());
    await transport.flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://in.test/v1/ingest/events');
    expect(calls[0]!.body).toMatchObject({
      projectKey: KEY, sessionId: CONTEXT.sessionId, visitorId: CONTEXT.visitorId,
      seq: 0, meta: { lang: 'tr-TR' },
    });
    expect((calls[0]!.body as { events: unknown[] }).events).toHaveLength(2);
  });

  it('increments the sequence and stops resending metadata', async () => {
    const { calls } = mockFetch([ok(), ok()]);
    const transport = new Transport(options(), CONTEXT);
    transport.setMeta({ startedAt: 1000 });

    transport.push(event()); await transport.flush();
    transport.push(event()); await transport.flush();

    expect((calls[0]!.body as { seq: number }).seq).toBe(0);
    expect((calls[1]!.body as { seq: number }).seq).toBe(1);
    expect(calls[0]!.body).toHaveProperty('meta');
    // Metadata describes the session, not each chunk.
    expect(calls[1]!.body).not.toHaveProperty('meta');
  });

  it('flushes automatically once the chunk fills up', async () => {
    const { fn } = mockFetch([ok()]);
    const transport = new Transport(options({ maxEventsPerChunk: 3 }), CONTEXT);
    transport.push(event()); transport.push(event()); transport.push(event());
    await vi.waitFor(() => expect(fn).toHaveBeenCalledTimes(1));
  });

  it('never sends credentials to the ingest endpoint', async () => {
    const { fn } = mockFetch([ok()]);
    const transport = new Transport(options(), CONTEXT);
    transport.push(event());
    await transport.flush();
    expect(fn.mock.calls[0]![1]).toMatchObject({ credentials: 'omit' });
  });

  /**
   * A browser rejects a `keepalive` request whose body exceeds 64 KiB, and the
   * rejection arrives as a bare TypeError — the transport cannot tell it apart
   * from being offline, so it counts a failure and, five of those later, stops
   * for good. Sizing the flag by event count walks straight into it: the first
   * chunk of every session is a Meta plus one full DOM snapshot, two events and
   * routinely hundreds of kilobytes. A site would record nothing at all while
   * its snippet looked perfectly installed.
   */
  describe('keepalive', () => {
    /** One event whose serialised form is comfortably over the 64 KiB cap. */
    const snapshot = (): RecordedEvent => ({
      type: 2, timestamp: Date.now(), data: { node: 'x'.repeat(200 * 1024) },
    });

    it('is off for a chunk too large to send with it, however few events it holds', async () => {
      const { fn } = mockFetch([ok()]);
      const transport = new Transport(options(), CONTEXT);
      transport.push(snapshot());
      await transport.flush();

      const init = fn.mock.calls[0]![1];
      expect(String(init.body).length).toBeGreaterThan(64 * 1024);
      expect(init.keepalive).toBe(false);
    });

    it('stays on for a small chunk, so the tail of a session still survives unload', async () => {
      const { fn } = mockFetch([ok()]);
      const transport = new Transport(options(), CONTEXT);
      transport.push(event());
      await transport.flush();
      expect(fn.mock.calls[0]![1].keepalive).toBe(true);
    });

    it('measures bytes, not characters', () => {
      // 30k astral-plane characters: 30k UTF-16 code units, 120k UTF-8 bytes.
      expect(withinKeepaliveLimit('𝄞'.repeat(15_000))).toBe(false);
      expect(withinKeepaliveLimit('a'.repeat(15_000))).toBe(true);
    });
  });

  describe('failure handling', () => {
    it('keeps events and retries after a network error', async () => {
      const { fn } = mockFetch([new Error('offline'), ok()]);
      const transport = new Transport(options(), CONTEXT);
      transport.push(event());

      await transport.flush();
      expect(transport.bufferedCount).toBe(1); // retained, not dropped
      expect(transport.sentChunks).toBe(0);

      await transport.flush();
      expect(transport.sentChunks).toBe(1);
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('keeps events and retries after a 5xx', async () => {
      mockFetch([status(503), ok()]);
      const transport = new Transport(options(), CONTEXT);
      transport.push(event());
      await transport.flush();
      expect(transport.bufferedCount).toBe(1);
      await transport.flush();
      expect(transport.sentChunks).toBe(1);
    });

    it('retries a 429 rather than giving up', async () => {
      mockFetch([status(429), ok()]);
      const transport = new Transport(options(), CONTEXT);
      transport.push(event());
      await transport.flush();
      expect(transport.isStopped).toBe(false);
      expect(transport.bufferedCount).toBe(1);
    });

    it.each([400, 403, 404, 422])('stops permanently on %d', async (code) => {
      // A rejected key or origin cannot be fixed by retrying; continuing would
      // hammer the endpoint from every page load forever.
      const { fn } = mockFetch([status(code)]);
      const stopped: string[] = [];
      const transport = new Transport(options(), CONTEXT, { onStopped: (r) => stopped.push(r) });
      transport.push(event());
      await transport.flush();

      expect(transport.isStopped).toBe(true);
      expect(stopped).toEqual([`rejected_${code}`]);

      transport.push(event());
      await transport.flush();
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('gives up after the configured number of consecutive failures', async () => {
      mockFetch([status(503)]);
      const transport = new Transport(options({ maxConsecutiveFailures: 3 }), CONTEXT);
      transport.push(event());
      for (let i = 0; i < 3; i += 1) await transport.flush();
      expect(transport.isStopped).toBe(true);
    });

    it('resets the failure count after a success', async () => {
      mockFetch([status(503), ok(), status(503)]);
      const transport = new Transport(options({ maxConsecutiveFailures: 2 }), CONTEXT);
      transport.push(event()); await transport.flush();
      await transport.flush();               // succeeds, counter resets
      transport.push(event()); await transport.flush(); // first failure again
      expect(transport.isStopped).toBe(false);
    });

    it('bounds the retry buffer so a long outage cannot exhaust memory', async () => {
      mockFetch([new Error('offline')]);
      const transport = new Transport(options({ maxEventsPerChunk: 10, maxConsecutiveFailures: 1000 }), CONTEXT);
      for (let i = 0; i < 500; i += 1) transport.push(event(i));
      for (let i = 0; i < 20; i += 1) await transport.flush();
      expect(transport.bufferedCount).toBeLessThanOrEqual(100);
    });
  });

  describe('sendBeacon on page hide', () => {
    it('hands the tail of the session to the browser', () => {
      const beacon = vi.fn((_url: string, _body: BodyInit) => true);
      vi.stubGlobal('navigator', { sendBeacon: beacon });
      const transport = new Transport(options(), CONTEXT);
      transport.push(event());

      expect(transport.flushWithBeacon()).toBe(true);
      expect(beacon).toHaveBeenCalledTimes(1);
      expect((beacon.mock.calls[0] as unknown as [string, Blob])[0]).toBe('https://in.test/v1/ingest/events');
      expect(transport.bufferedCount).toBe(0);
    });

    it('keeps the events when the browser refuses to queue them', () => {
      vi.stubGlobal('navigator', { sendBeacon: vi.fn(() => false) });
      const transport = new Transport(options(), CONTEXT);
      transport.push(event());
      expect(transport.flushWithBeacon()).toBe(false);
      expect(transport.bufferedCount).toBe(1);
    });

    it('does nothing when there is no beacon support', () => {
      vi.stubGlobal('navigator', {});
      const transport = new Transport(options(), CONTEXT);
      transport.push(event());
      expect(transport.flushWithBeacon()).toBe(false);
      expect(transport.bufferedCount).toBe(1);
    });

    it('is a no-op with an empty buffer', () => {
      const beacon = vi.fn(() => true);
      vi.stubGlobal('navigator', { sendBeacon: beacon });
      expect(new Transport(options(), CONTEXT).flushWithBeacon()).toBe(false);
      expect(beacon).not.toHaveBeenCalled();
    });
  });

  describe('resuming a session', () => {
    const duplicate = (nextSeq: number) =>
      new Response(JSON.stringify({ accepted: true, duplicate: true, nextSeq }), { status: 202 });

    it('continues from the chunk number it was given', async () => {
      const { calls } = mockFetch([ok()]);
      const transport = new Transport(options(), { ...CONTEXT, initialSeq: 7 });
      transport.push(event());
      await transport.flush();
      expect(calls[0]!.body).toMatchObject({ seq: 7 });
    });

    it('reserves the next number before the request leaves', async () => {
      const reserved: number[] = [];
      let reservedAtSend: number[] = [];
      vi.stubGlobal('fetch', vi.fn(async () => { reservedAtSend = [...reserved]; return ok(); }));
      const transport = new Transport(options(), CONTEXT, { onSeqReserved: (n) => reserved.push(n) });
      transport.push(event());
      await transport.flush();
      expect(reservedAtSend).toEqual([1]);
    });

    it('resends events the server discarded under a number an earlier page used', async () => {
      const { calls } = mockFetch([duplicate(4), ok()]);
      const transport = new Transport(options(), CONTEXT);
      transport.push(event(1));
      await transport.flush();

      await vi.waitFor(() => expect(calls).toHaveLength(2));
      expect(calls.map((c) => (c.body as { seq: number }).seq)).toEqual([0, 4]);
      expect((calls[1]!.body as { events: unknown[] }).events).toHaveLength(1);
    });

    it('treats a duplicate answer to a retry as delivered, not as a collision', async () => {
      const { calls } = mockFetch([new Error('offline'), duplicate(1), ok()]);
      const transport = new Transport(options(), CONTEXT);
      transport.push(event());
      await transport.flush();
      await transport.flush();
      // The first attempt had landed; sending the same events again would
      // record them twice.
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(calls).toHaveLength(2);
      transport.push(event());
      await transport.flush();
      expect(calls.map((c) => (c.body as { seq: number }).seq)).toEqual([0, 0, 1]);
    });

    it('recovers a resumed session whose stored number was already used by the previous page', async () => {
      // Page one's last chunk left by beacon after the number was reserved,
      // so page two resumes at a number the server already holds.
      const { calls } = mockFetch([duplicate(6), ok()]);
      const reserved: number[] = [];
      const transport = new Transport(options(), { ...CONTEXT, initialSeq: 5 }, { onSeqReserved: (n) => reserved.push(n) });
      transport.setMeta({ startedAt: 1000 });
      transport.push(event(1));
      await transport.flush();

      await vi.waitFor(() => expect(transport.sentChunks).toBe(7));
      expect(calls.map((c) => (c.body as { seq: number }).seq)).toEqual([5, 6]);
      // The page's metadata still travels with the chunk that finally lands.
      expect(calls[1]!.body).toHaveProperty('meta');
      expect(reserved).toEqual([6, 7]);
    });

    it('stops moving to new numbers after a few collisions instead of looping', async () => {
      const { calls } = mockFetch(Array.from({ length: 10 }, (_, i) => duplicate(100 + i)));
      const transport = new Transport(options(), CONTEXT);
      transport.push(event());
      await transport.flush();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(calls).toHaveLength(4);
    });
  });

  it('carries the session cap in the metadata when asked to', async () => {
    const { calls } = mockFetch([ok()]);
    const transport = new Transport(options(), CONTEXT);
    transport.setMeta({ startedAt: 1000, sessionCap: 250 });
    transport.push(event());
    await transport.flush();
    expect(calls[0]!.body).toMatchObject({ meta: { sessionCap: 250 } });
  });

  it('sends merged flags with the chunk', async () => {
    const { calls } = mockFetch([ok()]);
    const transport = new Transport(options(), CONTEXT);
    transport.mergeFlags({ pageCount: 1 });
    transport.mergeFlags({ hasError: true });
    transport.push(event());
    await transport.flush();
    expect((calls[0]!.body as { flags: unknown }).flags).toEqual({ pageCount: 1, hasError: true });
  });

  it('omits the flags key entirely when nothing has been flagged', async () => {
    const { calls } = mockFetch([ok()]);
    const transport = new Transport(options(), CONTEXT);
    transport.push(event());
    await transport.flush();
    expect(calls[0]!.body).not.toHaveProperty('flags');
  });

  it('ignores pushes once stopped', () => {
    const transport = new Transport(options(), CONTEXT);
    transport.stop('test');
    transport.push(event());
    expect(transport.bufferedCount).toBe(0);
  });
});
