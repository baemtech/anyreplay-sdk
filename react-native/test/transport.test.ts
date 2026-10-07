import { describe, expect, it } from 'vitest';
import {
  BACKOFF_MAX_MS, MAX_BODY_BYTES, Transport, utf8Length, type TransportHooks, type TransportOptions,
} from '../src/transport.js';
import type { RecordedEvent } from '../src/wire.js';

/**
 * The transport on its own: what leaves, in what size, and what it does with
 * each answer ingest can give (docs/SDK-CONTRACT.md §10).
 */

type Reply = { status: number; headers?: Record<string, string>; json?: unknown } | 'offline';

function harness(replies: (body: Record<string, unknown>, attempt: number) => Reply, options: Partial<TransportOptions> = {}, hooks: TransportHooks = {}) {
  let clock = 1_760_000_000_000;
  const bodies: Record<string, unknown>[] = [];
  const sizes: number[] = [];
  const stops: string[] = [];
  const drops: number[] = [];
  const fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    bodies.push(body);
    sizes.push(utf8Length(init.body));
    const reply = replies(body, bodies.length);
    if (reply === 'offline') throw new TypeError('Network request failed');
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      headers: { get: (name: string) => reply.headers?.[name] ?? null },
      json: async () => reply.json ?? { accepted: true, duplicate: false },
    } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  const transport = new Transport({
    ingestUrl: 'https://in.example.com',
    projectKey: 'ar_pk_live_0123456789abcdef01234567',
    sessionId: '3f1c2a4e-8b7d-4c3e-9a1b-2c3d4e5f6a7b',
    visitorId: 'v0123456789abcdef01234567',
    maxEventsPerChunk: 200,
    maxBufferedEvents: 2000,
    now: () => clock,
    random: () => 0.5,
    ...options,
  }, {
    onStopped: (reason) => stops.push(reason),
    onDropped: (n) => drops.push(n),
    ...hooks,
  }, fetch);
  return { transport, bodies, sizes, stops, drops, advance: (ms: number) => { clock += ms; }, now: () => clock };
}

/** A mutation of about `bytes` bytes, numbered so order can be checked. */
const mutation = (n: number, bytes = 64): RecordedEvent => ({
  type: 3, timestamp: 1_760_000_000_000 + n,
  data: { source: 0, texts: [{ id: 3, value: `${n}:${'x'.repeat(Math.max(0, bytes - 80))}` }], attributes: [], adds: [], removes: [] },
});
const tap = (n: number): RecordedEvent => ({ type: 3, timestamp: 1_760_000_000_000 + n, data: { source: 2, type: 2, x: 10, y: 10 } });
const numberOf = (event: RecordedEvent): number =>
  Number(((event.data as { texts?: { value: string }[] }).texts?.[0]?.value ?? '').split(':')[0]);

describe('the transport', () => {
  /**
   * After an outage the whole buffer used to leave as one body. Above 512 KB
   * ingest answers 413, a 4xx stopped the recording, and the session lost
   * everything after the outage.
   */
  it('sends a backlog as several chunks under 512 KB, in order, numbered one after another', async () => {
    let online = false;
    const f = harness(() => (online ? { status: 202 } : 'offline'), { maxBufferedEvents: 5000 });
    // 2000 events of about 1.5 KB: three megabytes waiting for the network.
    for (let n = 0; n < 2000; n += 1) f.transport.push(mutation(n, 1500));
    // The 200th event started a flush of its own; let it meet the outage.
    await new Promise((resolve) => setTimeout(resolve, 0));
    online = true;
    f.advance(BACKOFF_MAX_MS);
    await f.transport.flush();

    // The first body is the attempt that met the outage.
    const delivered = f.bodies.slice(1);
    expect(delivered.length).toBeGreaterThan(10);
    for (const size of f.sizes) expect(size).toBeLessThan(MAX_BODY_BYTES);
    for (const body of delivered) expect((body.events as unknown[]).length).toBeLessThanOrEqual(200);
    expect(delivered.map((b) => b.seq)).toEqual(delivered.map((_, i) => i));
    const order = delivered.flatMap((b) => (b.events as RecordedEvent[]).map(numberOf));
    expect(order).toEqual([...Array(2000).keys()]);
    expect(f.stops).toEqual([]);
  });

  it('keeps a steady-state chunk to what was buffered when the flush began', async () => {
    const f = harness(() => ({ status: 202 }));
    for (let n = 0; n < 5; n += 1) f.transport.push(mutation(n));
    await f.transport.flush();
    expect(f.bodies).toHaveLength(1);
    expect((f.bodies[0]!.events as unknown[]).length).toBe(5);
  });

  it('drops one event too big for any body, and asks for a fresh tree', async () => {
    const f = harness(() => ({ status: 202 }));
    f.transport.push(tap(-1));
    await f.transport.flush();
    f.bodies.length = 0;
    f.transport.push(mutation(0));
    f.transport.push({ type: 2, timestamp: 1, data: { node: { blob: 'x'.repeat(MAX_BODY_BYTES) } } });
    f.transport.push(mutation(2));
    f.transport.push(tap(3));
    await f.transport.flush();

    const sent = f.bodies.flatMap((b) => b.events as RecordedEvent[]);
    // The mutation before it is sent; the one after it described a tree the
    // reader will never have, so it goes too. The tap stands on its own.
    expect(sent.map((e) => e.timestamp)).toEqual([1_760_000_000_000, 1_760_000_000_003]);
    expect(f.drops).toEqual([2]);
    expect(f.stops).toEqual([]);
  });

  /** A recording opens with the canvas size; if that went unsent, nothing older than the fresh one may open it instead. */
  it('lets nothing stale open the recording when its opening was dropped before anything was delivered', async () => {
    const f = harness(() => 'offline', { maxBufferedEvents: 3 });
    f.transport.push({ type: 4, timestamp: 1, data: { width: 390, height: 844 } });
    f.transport.push(mutation(1));
    f.transport.push(tap(2));
    f.transport.push(mutation(3));
    expect(f.transport.bufferedCount).toBe(0);
    expect(f.transport.lostOpening).toBe(true);
  });

  it('answers a 413 by sending less under the same number, and never stops for it', async () => {
    // A proxy in front of ingest with a 64 KB limit.
    const f = harness((_body, attempt) => (f.sizes[attempt - 1]! > 64 * 1024 ? { status: 413 } : { status: 202 }));
    for (let n = 0; n < 150; n += 1) f.transport.push(mutation(n, 1500));
    await f.transport.flush();

    expect(f.stops).toEqual([]);
    const accepted = f.bodies.filter((_, i) => f.sizes[i]! <= 64 * 1024);
    expect(accepted.map((b) => b.seq)).toEqual(accepted.map((_, i) => i));
    expect(accepted.flatMap((b) => (b.events as RecordedEvent[]).map(numberOf))).toEqual([...Array(150).keys()]);
  });

  it('drops an event a server refuses as too large even alone, and carries on', async () => {
    const f = harness((body) => ((body.events as RecordedEvent[]).some((e) => numberOf(e) === 1) ? { status: 413 } : { status: 202 }));
    for (let n = 0; n < 3; n += 1) f.transport.push(mutation(n));
    await f.transport.flush();
    expect(f.stops).toEqual([]);
    expect(f.drops.length).toBe(1);
    expect(f.transport.bufferedCount).toBe(0);
  });

  /**
   * Five failures in a row used to stop the recording: about 25 seconds in a
   * tunnel. An outage now only makes the transport wait longer between tries.
   */
  it('backs off from failures — 2 s doubling to a minute, with jitter — and never stops for them', async () => {
    const f = harness(() => 'offline');
    f.transport.push(mutation(0));
    const waits: number[] = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await f.transport.flush();
      waits.push(f.transport.nextAttemptAt - f.now());
      // A flush inside the wait sends nothing.
      const before = f.bodies.length;
      await f.transport.flush();
      expect(f.bodies.length).toBe(before);
      f.advance(waits.at(-1)!);
    }
    // random() is 0.5: three quarters of each ceiling.
    expect(waits.slice(0, 6)).toEqual([1500, 3000, 6000, 12000, 24000, 45000]);
    expect(Math.max(...waits)).toBeLessThanOrEqual(BACKOFF_MAX_MS);
    expect(f.transport.isStopped).toBe(false);
    expect(f.stops).toEqual([]);
  });

  it('treats a 5xx and a 429 as worth retrying, not as a verdict', async () => {
    for (const status of [500, 502, 503, 429, 408]) {
      const f = harness(() => ({ status }));
      f.transport.push(mutation(0));
      await f.transport.flush();
      expect(f.transport.isStopped, String(status)).toBe(false);
      expect(f.transport.bufferedCount).toBe(1);
    }
  });

  it('waits at least as long as Retry-After asks, even for a background flush', async () => {
    const f = harness((_b, attempt) => (attempt === 1 ? { status: 429, headers: { 'Retry-After': '30' } } : { status: 202 }));
    f.transport.push(mutation(0));
    await f.transport.flush();
    expect(f.transport.nextAttemptAt - f.now()).toBe(30_000);

    f.advance(10_000);
    f.transport.retryNow();
    await f.transport.flush({ force: true });
    expect(f.bodies).toHaveLength(1);

    f.advance(20_000);
    await f.transport.flush();
    expect(f.bodies).toHaveLength(2);
  });

  it('reads Retry-After given as a date', async () => {
    const f = harness((_b, attempt) => (attempt === 1
      ? { status: 503, headers: { 'Retry-After': new Date(f.now() + 90_000).toUTCString() } }
      : { status: 202 }));
    f.transport.push(mutation(0));
    await f.transport.flush();
    // HTTP dates have whole seconds.
    expect(f.transport.nextAttemptAt - f.now()).toBeGreaterThan(89_000);
  });

  it('lets the app coming back to the foreground cut a backoff short', async () => {
    let online = false;
    const f = harness(() => (online ? { status: 202 } : 'offline'));
    f.transport.push(mutation(0));
    for (let i = 0; i < 5; i += 1) { await f.transport.flush(); f.advance(f.transport.nextAttemptAt - f.now()); }
    await f.transport.flush();
    online = true;
    f.transport.retryNow();
    await f.transport.flush();
    expect(f.transport.bufferedCount).toBe(0);
  });

  it('lets a background flush go inside a backoff the transport chose itself', async () => {
    let online = false;
    const f = harness(() => (online ? { status: 202 } : 'offline'));
    f.transport.push(mutation(0));
    await f.transport.flush();
    online = true;
    await f.transport.flush({ force: true });
    expect(f.transport.bufferedCount).toBe(0);
  });

  it('stops on a refusal: 402, 403, and a body ingest will not read', async () => {
    for (const status of [402, 403, 400, 422]) {
      const f = harness(() => ({ status }));
      f.transport.push(mutation(0));
      await f.transport.flush();
      expect(f.stops, String(status)).toEqual([`rejected_${status}`]);
    }
  });

  it('keeps the newest events when the offline buffer is full, and drops every tree event behind the gap', async () => {
    const f = harness(() => 'offline', { maxBufferedEvents: 10 });
    f.transport.push(tap(0));
    for (let n = 1; n <= 12; n += 1) f.transport.push(mutation(n));
    // Dropping the oldest mutations left every later one pointing at a tree
    // the reader will never have; the recorder is asked for a new one.
    expect(f.drops.length).toBeGreaterThan(0);
    expect(f.transport.bufferedCount).toBeLessThanOrEqual(10);
  });

  it('drops no tree event and asks for nothing when only taps were lost', async () => {
    const f = harness(() => 'offline', { maxBufferedEvents: 3 });
    for (let n = 0; n < 5; n += 1) f.transport.push(tap(n));
    expect(f.transport.bufferedCount).toBe(3);
    expect(f.drops).toEqual([]);
  });
});

describe('utf8Length', () => {
  it('counts bytes as ingest does', () => {
    expect(utf8Length('abc')).toBe(3);
    expect(utf8Length('ğüş')).toBe(6);
    expect(utf8Length('•')).toBe(3);
    expect(utf8Length('😀')).toBe(4);
    expect(utf8Length('Öde ödeme 😀')).toBe(new TextEncoder().encode('Öde ödeme 😀').length);
  });
});
