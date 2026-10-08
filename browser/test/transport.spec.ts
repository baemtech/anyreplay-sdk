import { resolveOptions } from '../src/config';
import {
  KEEPALIVE_BODY_LIMIT_BYTES, MAX_BODY_BYTES, Transport, retryAfterMs, withinKeepaliveLimit, type RecordedEvent,
} from '../src/transport';

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

      await transport.flush(true);
      expect(transport.sentChunks).toBe(1);
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('keeps events and retries after a 5xx', async () => {
      mockFetch([status(503), ok()]);
      const transport = new Transport(options(), CONTEXT);
      transport.push(event());
      await transport.flush();
      expect(transport.bufferedCount).toBe(1);
      await transport.flush(true);
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

    it('resends a failed chunk byte for byte under the same number, newer events behind it', async () => {
      const { calls } = mockFetch([new Error('offline'), ok()]);
      const transport = new Transport(options(), CONTEXT);
      transport.push(event(1));
      await transport.flush();
      transport.push(event(2));
      await transport.flush(true);

      const sent = calls.map((c) => c.body as { seq: number; events: RecordedEvent[] });
      expect(sent.map((b) => b.seq)).toEqual([0, 0, 1]);
      // Otherwise ingest, having stored the first attempt, would discard the
      // newer event as part of a "retry".
      expect(sent[1]!.events).toEqual(sent[0]!.events);
      expect(sent[2]!.events.map((e) => e.timestamp)).toEqual([2]);
    });

    it.each([401, 402, 403, 404])('stops permanently on %d', async (code) => {
      // A rejected key or origin, or a full plan, cannot be fixed by retrying;
      // continuing would hammer the endpoint from every page load forever.
      const { fn } = mockFetch([status(code)]);
      const stopped: string[] = [];
      const transport = new Transport(options(), CONTEXT, { onStopped: (r) => stopped.push(r) });
      transport.push(event());
      await transport.flush();

      expect(transport.isStopped).toBe(true);
      expect(stopped).toEqual([`rejected_${code}`]);

      transport.push(event());
      await transport.flush(true);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it.each([400, 422])('drops a chunk refused with %d and goes on recording', async (code) => {
      const { calls } = mockFetch([status(code), ok()]);
      const warnings: string[] = [];
      const transport = new Transport(options(), CONTEXT, { onWarning: (w) => warnings.push(w) });
      transport.push(event(1));
      await transport.flush();
      expect(transport.isStopped).toBe(false);
      expect(transport.bufferedCount).toBe(0);
      expect(warnings.join()).toContain(String(code));

      transport.push(event(2));
      await transport.flush();
      // A new number: the refused one is never reused for different events.
      expect(calls.map((c) => (c.body as { seq: number }).seq)).toEqual([0, 1]);
      expect(transport.sentChunks).toBe(2);
    });

    it('stops when every chunk is refused, rather than re-sending snapshots forever', async () => {
      mockFetch([status(422)]);
      const stopped: string[] = [];
      const transport = new Transport(options(), CONTEXT, { onStopped: (r) => stopped.push(r) });
      for (let i = 0; i < 3; i += 1) { transport.push(event(i + 1)); await transport.flush(); }
      expect(stopped).toEqual(['rejected_422']);
    });

    it('never stops over failures by default', async () => {
      mockFetch([new Error('offline')]);
      const transport = new Transport(options(), CONTEXT);
      transport.push(event());
      for (let i = 0; i < 50; i += 1) await transport.flush(true);
      expect(transport.isStopped).toBe(false);
      expect(transport.bufferedCount).toBe(1);
    });

    it('gives up after maxConsecutiveFailures, when the page asks for that', async () => {
      mockFetch([status(503)]);
      const stopped: string[] = [];
      const transport = new Transport(options({ maxConsecutiveFailures: 3 }), CONTEXT, { onStopped: (r) => stopped.push(r) });
      transport.push(event());
      for (let i = 0; i < 3; i += 1) await transport.flush(true);
      expect(stopped).toEqual(['too_many_failures']);
    });

    it('resets the failure count after a success', async () => {
      mockFetch([status(503), ok(), status(503)]);
      const transport = new Transport(options({ maxConsecutiveFailures: 2 }), CONTEXT);
      transport.push(event()); await transport.flush();
      await transport.flush(true);               // succeeds, counter resets
      transport.push(event()); await transport.flush(true); // first failure again
      expect(transport.isStopped).toBe(false);
    });

    it('bounds the retry buffer so a long outage cannot exhaust memory', async () => {
      mockFetch([new Error('offline')]);
      const transport = new Transport(options({ maxEventsPerChunk: 10 }), CONTEXT);
      for (let i = 0; i < 500; i += 1) transport.push(event(i));
      for (let i = 0; i < 20; i += 1) await transport.flush(true);
      expect(transport.bufferedCount).toBeLessThanOrEqual(100);
    });
  });

  describe('backoff', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      // The top of every jitter range, so the waits are exact.
      vi.spyOn(Math, 'random').mockReturnValue(0.999999);
    });
    afterEach(() => { vi.useRealTimers(); });

    /** Records the time (ms after the start) at which each request left. */
    const timeline = (responses: (Response | Error)[]) => {
      const start = Date.now();
      const at: number[] = [];
      vi.stubGlobal('fetch', vi.fn(async () => {
        at.push(Date.now() - start);
        const next = responses[Math.min(at.length - 1, responses.length - 1)]!;
        if (next instanceof Error) throw next;
        return next.clone();
      }));
      return at;
    };

    it('waits 2 s, 4 s, 8 s … up to a minute between attempts, and keeps trying', async () => {
      const at = timeline([new Error('offline')]);
      const transport = new Transport(options({ flushIntervalMs: 1_000_000 }), CONTEXT);
      transport.push(event());
      await transport.flush();
      await vi.advanceTimersByTimeAsync(10 * 60_000);

      const gaps = at.slice(1).map((t, i) => t - at[i]!);
      expect(gaps.slice(0, 7).map((g) => Math.round(g / 1000))).toEqual([2, 4, 8, 16, 32, 60, 60]);
      expect(Math.max(...gaps)).toBeLessThanOrEqual(60_000);
      expect(transport.isStopped).toBe(false);
    });

    it('puts jitter on each wait so tabs that lost the same network do not return together', async () => {
      vi.mocked(Math.random).mockReturnValue(0);
      const at = timeline([new Error('offline'), ok()]);
      const transport = new Transport(options({ flushIntervalMs: 1_000_000 }), CONTEXT);
      transport.push(event());
      await transport.flush();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(at[1]).toBe(1_000); // half of the 2 s ceiling
    });

    it('does not let the flush timer cut a backoff short', async () => {
      const at = timeline([new Error('offline'), new Error('offline'), new Error('offline'), ok()]);
      const transport = new Transport(options({ flushIntervalMs: 500 }), CONTEXT);
      transport.start();
      transport.push(event());
      await vi.advanceTimersByTimeAsync(20_000);
      // Ticks every 500 ms; the attempts still keep to 2 s, 4 s, 8 s.
      expect(at.slice(0, 4).map((t) => Math.round(t / 100) * 100)).toEqual([500, 2_500, 6_500, 14_500]);
      transport.stop('test');
    });

    it('tries again at once when the browser comes back online', async () => {
      const at = timeline([new Error('offline'), new Error('offline'), new Error('offline'), ok()]);
      const transport = new Transport(options({ flushIntervalMs: 1_000_000 }), CONTEXT);
      transport.push(event());
      await transport.flush();
      await vi.advanceTimersByTimeAsync(2_000 + 4_000);
      expect(at).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(1_000);
      transport.resume();
      await vi.advanceTimersByTimeAsync(0);
      expect(at.map((t) => Math.round(t))).toEqual([0, 2_000, 6_000, 7_000]);
      expect(transport.bufferedCount).toBe(0);
    });

    it('honours Retry-After in seconds on a 429, even over a resume', async () => {
      const limited = new Response('{}', { status: 429, headers: { 'Retry-After': '30' } });
      const at = timeline([limited, ok()]);
      const transport = new Transport(options({ flushIntervalMs: 1_000_000 }), CONTEXT);
      transport.push(event());
      await transport.flush();
      await vi.advanceTimersByTimeAsync(29_000);
      transport.resume();
      await transport.flush(true);
      expect(at).toEqual([0]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(at).toEqual([0, 30_000]);
    });

    it('honours Retry-After as an HTTP date on a 503', async () => {
      const when = new Date(Date.now() + 45_000).toUTCString();
      const unavailable = new Response('{}', { status: 503, headers: { 'Retry-After': when } });
      const at = timeline([unavailable, ok()]);
      const transport = new Transport(options({ flushIntervalMs: 1_000_000 }), CONTEXT);
      transport.push(event());
      await transport.flush();
      await vi.advanceTimersByTimeAsync(60_000);
      // HTTP dates have whole seconds; the wait is the date, not our 2 s.
      expect(at[1]).toBeGreaterThanOrEqual(44_000);
      expect(at[1]).toBeLessThanOrEqual(45_000);
    });

    it('reads Retry-After and caps an absurd one at ten minutes', () => {
      const r = (value: string) => retryAfterMs(new Response('{}', { status: 429, headers: { 'Retry-After': value } }), 0);
      expect(r('7')).toBe(7_000);
      expect(r('86400')).toBe(600_000);
      expect(r(new Date(90_000).toUTCString())).toBe(90_000);
      expect(r('soon')).toBeUndefined();
      expect(retryAfterMs(status(429))).toBeUndefined();
    });

    it('keeps buffering, within the cap, while it waits', async () => {
      timeline([new Error('offline')]);
      const transport = new Transport(options({ flushIntervalMs: 1_000_000, maxEventsPerChunk: 10 }), CONTEXT);
      transport.push(event(1));
      await transport.flush();
      for (let i = 0; i < 250; i += 1) transport.push({ type: 5, timestamp: 2 + i, data: { tag: 't', payload: {} } });
      expect(transport.bufferedCount).toBe(100);
    });
  });

  describe('chunk size', () => {
    /** An event whose JSON is about `kb` kilobytes; an incremental one unless told otherwise. */
    const big = (t: number, kb: number, type = 3): RecordedEvent => ({ type, timestamp: t, data: { source: 0, pad: 'x'.repeat(kb * 1024) } });

    it('sends a backlog as several chunks under the body limit, in order, none lost', async () => {
      const { calls, fn } = mockFetch([new Error('offline'), ok()]);
      const transport = new Transport(options(), CONTEXT);
      transport.push(event(1));
      await transport.flush();
      // An outage's worth: 1999 more events of ~1 KB each, about 2 MB.
      for (let i = 2; i <= 2000; i += 1) transport.push(big(i, 1));
      await transport.flush(true);

      const bodies = fn.mock.calls.map((c) => String(c[1]!.body));
      const delivered = calls.slice(1).map((c) => c.body as { seq: number; events: RecordedEvent[] });
      expect(delivered.length).toBeGreaterThan(5);
      for (const body of bodies) expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(MAX_BODY_BYTES);
      for (const chunk of delivered) expect(chunk.events.length).toBeLessThanOrEqual(200);
      expect(delivered.map((c) => c.seq)).toEqual(delivered.map((_, i) => i));
      const stamps = delivered.flatMap((c) => c.events.map((e) => e.timestamp));
      expect(stamps).toEqual(Array.from({ length: 2000 }, (_, i) => i + 1));
      expect(transport.bufferedCount).toBe(0);
    });

    it('sends a large snapshot alone, as long as it is under the limit', async () => {
      const { calls } = mockFetch([ok()]);
      const transport = new Transport(options(), CONTEXT);
      transport.push(event(1));
      transport.push(big(2, 400, 2));
      transport.push(event(3));
      await transport.flush();
      expect(calls.map((c) => (c.body as { events: unknown[] }).events.length)).toEqual([1, 1, 1]);
    });

    it('drops a single event too large for any chunk, with a warning, and asks for a new snapshot', async () => {
      const { calls } = mockFetch([ok()]);
      const warnings: string[] = [];
      const resync = vi.fn();
      const transport = new Transport(options(), CONTEXT, { onWarning: (w) => warnings.push(w), onResyncNeeded: resync });
      transport.push(event(1));
      await transport.flush();
      transport.push(big(2, 600));
      transport.push({ type: 5, timestamp: 3, data: { tag: 'x' } });
      await transport.flush();

      expect(transport.isStopped).toBe(false);
      expect(warnings.join()).toMatch(/dropped one event of 6\d\d KB/);
      expect(resync).toHaveBeenCalledTimes(1);
      expect(calls.map((c) => (c.body as { events: RecordedEvent[] }).events.map((e) => e.timestamp))).toEqual([[1], [3]]);
    });

    it('stops, rather than looping, when the page snapshot alone is too large', async () => {
      const { fn } = mockFetch([ok()]);
      const stopped: string[] = [];
      const transport = new Transport(options(), CONTEXT, { onStopped: (r) => stopped.push(r) });
      transport.push(big(1, 600, 2));
      await transport.flush();
      expect(stopped).toEqual(['snapshot_too_large']);
      expect(fn).not.toHaveBeenCalled();
    });

    it('treats a 413 as "smaller, please": re-cuts the chunk and carries on', async () => {
      const { calls } = mockFetch([status(413), ok()]);
      const transport = new Transport(options(), CONTEXT);
      for (let i = 1; i <= 100; i += 1) transport.push(big(i, 2));
      await transport.flush();

      expect(transport.isStopped).toBe(false);
      const sent = calls.map((c) => c.body as { seq: number; events: RecordedEvent[] });
      const firstSize = JSON.stringify(sent[0]).length;
      expect(sent.length).toBeGreaterThan(2);
      for (const chunk of sent.slice(1)) expect(JSON.stringify(chunk).length).toBeLessThanOrEqual(firstSize / 2);
      // The refused number is not used again for a different cut.
      expect(sent.slice(1).every((c) => c.seq !== sent[0]!.seq)).toBe(true);
      expect(sent.slice(1).flatMap((c) => c.events.map((e) => e.timestamp))).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    });

    it('stops on a 413 that even the smallest chunk gets', async () => {
      mockFetch([status(413)]);
      const stopped: string[] = [];
      const transport = new Transport(options(), CONTEXT, { onStopped: (r) => stopped.push(r) });
      for (let i = 1; i <= 20; i += 1) transport.push(event(i));
      for (let i = 0; i < 10 && !transport.isStopped; i += 1) await transport.flush(true);
      expect(stopped).toEqual(['rejected_413']);
    });
  });

  describe('dropping events', () => {
    const custom = (t: number): RecordedEvent => ({ type: 5, timestamp: t, data: { tag: 'anyreplay.track', payload: { name: 'n' } } });
    const snapshot = (t: number): RecordedEvent => ({ type: 2, timestamp: t, data: { node: {} } });

    it('asks for a full snapshot, and keeps no DOM change until it arrives', async () => {
      mockFetch([new Error('offline')]);
      const resync = vi.fn();
      const transport = new Transport(options({ maxEventsPerChunk: 10 }), CONTEXT, { onResyncNeeded: resync });
      transport.push(snapshot(1));
      for (let t = 2; t <= 10; t += 1) transport.push(event(t));
      // The tenth event set off a flush; let it fail, so its chunk is waiting.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
      for (let t = 11; t <= 100; t += 1) transport.push(event(t));
      expect(resync).not.toHaveBeenCalled();

      transport.push(event(101)); // one over the cap of 100
      expect(resync).toHaveBeenCalledTimes(1);
      // The chunk waiting to be retried held the snapshot; what was left are
      // DOM changes against it, and they go with it.
      expect(transport.bufferedCount).toBe(0);

      transport.push(event(102));
      transport.push(custom(103));
      expect(transport.bufferedCount).toBe(1);
      transport.push({ type: 4, timestamp: 104, data: { width: 1, height: 1 } });
      transport.push(snapshot(105));
      transport.push(event(106));
      expect(transport.bufferedCount).toBe(4);
      expect(resync).toHaveBeenCalledTimes(1);
    });

    it('sends a fresh snapshot ahead of any DOM change after the gap', async () => {
      const { calls } = mockFetch([new Error('offline'), ok()]);
      let transport: Transport | undefined;
      const resync = vi.fn(() => {
        transport!.push({ type: 4, timestamp: 500, data: { width: 1, height: 1 } });
        transport!.push(snapshot(501));
      });
      transport = new Transport(options({ maxEventsPerChunk: 10 }), CONTEXT, { onResyncNeeded: resync });
      transport.push(snapshot(1));
      await transport.flush();
      for (let t = 2; t <= 120; t += 1) transport.push(t % 10 === 0 ? custom(t) : event(t));
      transport.push(event(502));
      await transport.flush(true);

      expect(resync).toHaveBeenCalled();
      const events = calls.slice(1).flatMap((c) => (c.body as { events: RecordedEvent[] }).events);
      const firstSnapshot = events.findIndex((e) => e.type === 2);
      expect(firstSnapshot).toBeGreaterThan(-1);
      expect(events.slice(0, firstSnapshot).every((e) => e.type !== 3)).toBe(true);
      expect(events.at(-1)!.timestamp).toBe(502);
    });

    it('does not reuse the number of a dropped chunk for other events', async () => {
      const { calls } = mockFetch([new Error('offline'), ok()]);
      const transport = new Transport(options({ maxEventsPerChunk: 10 }), CONTEXT, { onResyncNeeded: () => {} });
      for (let t = 1; t <= 5; t += 1) transport.push(custom(t));
      await transport.flush();
      for (let t = 6; t <= 200; t += 1) transport.push(custom(t));
      await transport.flush(true);
      const seqs = calls.map((c) => (c.body as { seq: number }).seq);
      expect(seqs[0]).toBe(0);
      expect(seqs.slice(1).every((s) => s > 0)).toBe(true);
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

    /** What each beacon carried, read back from its Blob. */
    const beaconBodies = async (beacon: ReturnType<typeof vi.fn>) =>
      Promise.all(beacon.mock.calls.map(async (call) => {
        // jsdom's Blob has no text(); FileReader it is.
        const text = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.readAsText(call[1] as Blob);
        });
        return { bytes: new TextEncoder().encode(text).length, body: JSON.parse(text) as { seq: number; events: RecordedEvent[] } };
      }));

    const kb = (t: number, size: number): RecordedEvent => ({ type: 3, timestamp: t, data: { source: 0, pad: 'x'.repeat(size * 1024) } });

    it('splits a large tail into beacons the browser will take, oldest first, numbered in order', async () => {
      const beacon = vi.fn((_url: string, _body: BodyInit) => true);
      vi.stubGlobal('navigator', { sendBeacon: beacon });
      const transport = new Transport(options(), CONTEXT);
      for (let t = 1; t <= 150; t += 1) transport.push(kb(t, 1)); // ~150 KB

      expect(transport.flushWithBeacon(true)).toBe(true);
      const sent = await beaconBodies(beacon);
      expect(sent.length).toBeGreaterThanOrEqual(3);
      for (const s of sent) expect(s.bytes).toBeLessThanOrEqual(KEEPALIVE_BODY_LIMIT_BYTES);
      expect(sent.map((s) => s.body.seq)).toEqual(sent.map((_, i) => i));
      expect(sent.flatMap((s) => s.body.events.map((e) => e.timestamp))).toEqual(Array.from({ length: 150 }, (_, i) => i + 1));
      expect(transport.bufferedCount).toBe(0);
    });

    it('sends what fits when the browser runs out of room, and keeps the rest under an unused number', async () => {
      let room = 1;
      const beacon = vi.fn((_url: string, _body: BodyInit) => room-- > 0);
      vi.stubGlobal('navigator', { sendBeacon: beacon });
      const { calls } = mockFetch([ok()]);
      const transport = new Transport(options(), CONTEXT);
      for (let t = 1; t <= 150; t += 1) transport.push(kb(t, 1));

      expect(transport.flushWithBeacon(true)).toBe(true);
      const [first] = await beaconBodies(beacon);
      expect(first!.body.seq).toBe(0);
      const left = 150 - first!.body.events.length;
      expect(transport.bufferedCount).toBe(left);

      // The page survived (a hidden tab); the rest goes by fetch, numbered on.
      await transport.flush();
      expect((calls[0]!.body as { seq: number }).seq).toBe(1);
    });

    it('carries an event too big for any beacon by an ordinary request instead', async () => {
      const beacon = vi.fn((_url: string, _body: BodyInit) => true);
      vi.stubGlobal('navigator', { sendBeacon: beacon });
      const { calls } = mockFetch([ok()]);
      const transport = new Transport(options(), CONTEXT);
      transport.push(event(1));
      transport.push({ type: 2, timestamp: 2, data: { node: 'x'.repeat(100 * 1024) } });

      transport.flushWithBeacon();
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      expect((await beaconBodies(beacon)).map((s) => s.body.seq)).toEqual([0]);
      expect(calls[0]!.body).toMatchObject({ seq: 1 });
      expect((calls[0]!.body as { events: RecordedEvent[] }).events[0]!.type).toBe(2);
      expect(transport.isStopped).toBe(false);
    });

    it('keeps a hidden tab’s events for the retry while deliveries are failing', async () => {
      mockFetch([new Error('offline')]);
      const beacon = vi.fn((_url: string, _body: BodyInit) => true);
      vi.stubGlobal('navigator', { sendBeacon: beacon });
      const transport = new Transport(options(), CONTEXT);
      transport.push(event(1));
      await transport.flush();
      transport.push(event(2));

      expect(transport.flushWithBeacon()).toBe(false);
      expect(beacon).not.toHaveBeenCalled();
      expect(transport.bufferedCount).toBe(2);
      transport.stop('test');
    });

    it('sends a chunk that failed earlier first, under its own number', async () => {
      mockFetch([new Error('offline')]);
      const beacon = vi.fn((_url: string, _body: BodyInit) => true);
      vi.stubGlobal('navigator', { sendBeacon: beacon });
      const transport = new Transport(options(), CONTEXT);
      transport.push(event(1));
      await transport.flush();
      transport.push(event(2));

      transport.flushWithBeacon(true);
      const sent = await beaconBodies(beacon);
      expect(sent.map((s) => [s.body.seq, s.body.events.map((e) => e.timestamp)])).toEqual([[0, [1]], [1, [2]]]);
      expect(transport.bufferedCount).toBe(0);
    });

    it('waits out a server Retry-After when the tab is only hidden, but not when the page goes', async () => {
      mockFetch([new Response('{}', { status: 429, headers: { 'Retry-After': '60' } })]);
      const beacon = vi.fn((_url: string, _body: BodyInit) => true);
      vi.stubGlobal('navigator', { sendBeacon: beacon });
      const transport = new Transport(options(), CONTEXT);
      transport.push(event(1));
      await transport.flush();

      expect(transport.flushWithBeacon()).toBe(false);
      expect(beacon).not.toHaveBeenCalled();
      expect(transport.flushWithBeacon(true)).toBe(true);
      expect(beacon).toHaveBeenCalledTimes(1);
      transport.stop('test');
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
      await transport.flush(true);
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
