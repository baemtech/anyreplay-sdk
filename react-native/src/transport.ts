import type { ChunkFlags, RecordedEvent, SessionMeta } from './wire.js';

/**
 * Ships chunks to ingest, in the wire format the web recorder already uses.
 *
 * Same endpoint, same schema, same rate limits, same origin rules. The server
 * does not need to know a phone is calling, which is why mobile sessions
 * appear in the dashboard, obey retention and get translated without a line of
 * server code being written for them.
 *
 * What differs is what a phone can promise. There is no `sendBeacon`, so the
 * tail of a session is flushed when the app goes to the background instead of
 * when a tab unloads; and a phone is offline far more often than a browser, so
 * a failed chunk is kept and retried rather than dropped — for as long as it
 * takes, backing off, because a tunnel is not a reason to stop recording.
 */

export interface TransportOptions {
  ingestUrl: string;
  projectKey: string;
  sessionId: string;
  visitorId: string;
  maxEventsPerChunk: number;
  /** Keeps at most this many events while offline before dropping the oldest. */
  maxBufferedEvents: number;
  /** The first chunk number to use. Non-zero when a relaunch resumes a session. */
  initialSeq?: number;
  /** The app's bundle id or package name, sent with every chunk; see `appId` in config.ts. */
  appId?: string;
  /**
   * The clock the events are stamped with, read again as each request leaves
   * and sent as `sentAt`. Ingest compares it with its own to catch a device
   * that runs ahead — simulators and test phones often do — so it must be the
   * same clock as the event timestamps. Also the clock backoff is measured
   * on. Defaults to `Date.now`.
   */
  now?: () => number;
  /** How many serialised bytes of events one chunk aims for. Defaults to 256 KB. */
  chunkBytes?: number;
  /** Jitter source, for tests. Defaults to `Math.random`. */
  random?: () => number;
  debug?: boolean;
}

/** How many times one flush may move to a new chunk number before giving up. */
const MAX_STALE_RECOVERIES = 3;

/** What ingest accepts as one request body. Above it the answer is 413. */
export const MAX_BODY_BYTES = 512 * 1024;
/**
 * What a chunk aims for: half the limit. The envelope — ids, meta, flags — is
 * small, but a chunk that aims at the limit itself is one long screen name
 * away from a 413, and a 413 costs a round trip to learn.
 */
export const TARGET_CHUNK_BYTES = 256 * 1024;
/** Room left for everything in a body that is not an event. */
const ENVELOPE_BYTES = 16 * 1024;
/** One event bigger than this can never be sent, alone or otherwise. */
export const MAX_EVENT_BYTES = MAX_BODY_BYTES - ENVELOPE_BYTES;
/** A 413 halves what a chunk aims for, but never below this. */
const MIN_CHUNK_BYTES = 8 * 1024;

/** First wait after a failure; it doubles with each failure in a row. */
export const BACKOFF_BASE_MS = 2_000;
/** The longest wait between attempts, however long the outage. */
export const BACKOFF_MAX_MS = 60_000;
/**
 * The longest `Retry-After` taken at its word. Ingest sends seconds; a
 * misconfigured proxy could send a date next year, and a recording that
 * waits until then has simply stopped without saying so.
 */
const RETRY_AFTER_MAX_MS = 10 * 60_000;

/**
 * The first free chunk number, when ingest says the one just sent was taken.
 *
 * Ingest answers a repeated (session, seq) with 202 and `duplicate: true`,
 * because to the server it looks like a retry. When this transport never sent
 * that number, it was not a retry — an earlier launch of the session used it —
 * and the events were discarded. The server says where numbering continues.
 */
async function staleSeqHint(response: Response, sent: number): Promise<number | undefined> {
  try {
    if (typeof response.json !== 'function') return undefined;
    const reply = await response.json() as { duplicate?: unknown; nextSeq?: unknown };
    if (reply.duplicate !== true) return undefined;
    const next = reply.nextSeq;
    return typeof next === 'number' && Number.isInteger(next) && next > sent ? next : undefined;
  } catch {
    return undefined;
  }
}

/** `Retry-After` in milliseconds — seconds or an HTTP date — or undefined when absent or unreadable. */
export function retryAfterMs(response: Response, now: number): number | undefined {
  let raw: string | null | undefined;
  try { raw = response.headers?.get?.('Retry-After'); } catch { return undefined; }
  if (!raw) return undefined;
  const value = raw.trim();
  if (/^[0-9]+(\.[0-9]+)?$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/**
 * UTF-8 length of a string, which is what ingest's 512 KB limit counts.
 *
 * Counted by hand rather than with `TextEncoder`, which older Hermes builds do
 * not have. A lone surrogate is counted as the three bytes its replacement
 * character takes, as `JSON.stringify` output never contains one anyway.
 */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; i += 1; } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Whether the replayed screen depends on this event: a snapshot, a mutation,
 * or a Meta (the canvas size, the screen name). Taps and custom events stand
 * on their own — losing one loses that one moment and nothing after it.
 */
export function isTreeEvent(event: RecordedEvent): boolean {
  if (event.type === 2 || event.type === 4) return true;
  return event.type === 3 && (event.data as { source?: unknown } | undefined)?.source === 0;
}

export interface TransportHooks {
  onStopped?: (reason: string) => void;
  onSent?: (seq: number, events: number) => void;
  /** Called with the next free chunk number before a request using the current one leaves. */
  onSeqReserved?: (nextSeq: number) => void;
  /**
   * Called when events the replayed screen depends on were dropped — the
   * offline buffer overflowed, or one event was too big to send. Every later
   * snapshot and mutation still buffered has already been dropped with them,
   * because they describe changes to a tree the reader will never have; the
   * recorder answers with a fresh Meta and full snapshot, so the next thing
   * the tree receives is a whole tree again.
   */
  onDropped?: (count: number) => void;
}

export type TransportState = 'open' | 'stopped';

interface Buffered { event: RecordedEvent; bytes: number }

export class Transport {
  private buffer: Buffered[] = [];
  private seq = 0;
  private consecutiveFailures = 0;
  private state: TransportState = 'open';
  private inFlight = false;
  /** The chunk number of the last request that left, to tell a retry from a first attempt. */
  private lastAttemptedSeq = -1;
  private staleRecoveries = 0;
  private pendingMeta: SessionMeta | undefined;
  private flags: ChunkFlags = {};
  /** No attempt before this (epoch ms, on `now`), after a failure. */
  private retryAt = 0;
  /** The part of `retryAt` the server asked for with `Retry-After`; not even a background flush jumps it. */
  private serverRetryAt = 0;
  /** What a chunk aims for; halved by a 413 until the backlog is through. */
  private chunkBytes: number;
  /** And how many events, halved alongside it, so a run of 413s always ends. */
  private chunkEvents: number;
  /** Whether ingest has accepted anything from this transport yet. */
  private delivered = false;
  /** The session's opening Meta was dropped before it was ever sent. */
  private openingLost = false;

  constructor(
    private readonly options: TransportOptions,
    private readonly hooks: TransportHooks = {},
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.seq = options.initialSeq ?? 0;
    this.chunkBytes = options.chunkBytes ?? TARGET_CHUNK_BYTES;
    this.chunkEvents = options.maxEventsPerChunk;
  }

  get isStopped(): boolean { return this.state === 'stopped'; }
  get bufferedCount(): number { return this.buffer.length; }
  get sentChunks(): number { return this.seq; }
  /** When the next attempt may be made, or 0 when it may be made now. */
  get nextAttemptAt(): number { return this.retryAt; }
  /**
   * Whether any chunk has been accepted. Until one has, the recording the
   * reader will see starts with whatever is sent first — which, after a drop,
   * the recorder makes a fresh Meta and snapshot (and a fresh `startedAt`).
   */
  get hasDelivered(): boolean { return this.delivered; }
  /** True once the opening Meta was dropped unsent: the next Meta the recorder sends opens the recording. */
  get lostOpening(): boolean { return this.openingLost && !this.delivered; }

  private now(): number { return (this.options.now ?? Date.now)(); }

  setMeta(meta: SessionMeta): void { this.pendingMeta = meta; }
  mergeFlags(flags: ChunkFlags): void { this.flags = { ...this.flags, ...flags }; }

  push(event: RecordedEvent): void {
    if (this.state === 'stopped') return;
    let bytes: number;
    try { bytes = utf8Length(JSON.stringify(event)); } catch { return; }
    this.buffer.push({ event, bytes });
    this.bound();
    if (this.buffer.length >= this.options.maxEventsPerChunk) void this.flush();
  }

  stop(reason: string): void {
    if (this.state === 'stopped') return;
    this.state = 'stopped';
    this.buffer = [];
    this.hooks.onStopped?.(reason);
  }

  /**
   * Lets the next flush go now instead of waiting out a backoff — the app has
   * just come back to the foreground, which is usually when the network has.
   * A wait the server asked for with `Retry-After` still stands.
   */
  retryNow(): void {
    this.retryAt = this.serverRetryAt > this.now() ? this.serverRetryAt : 0;
  }

  private body(events: RecordedEvent[]): string {
    return JSON.stringify({
      projectKey: this.options.projectKey,
      sessionId: this.options.sessionId,
      visitorId: this.options.visitorId,
      seq: this.seq,
      events,
      ...(this.options.appId ? { appId: this.options.appId } : {}),
      ...(this.pendingMeta ? { meta: this.pendingMeta } : {}),
      ...(Object.keys(this.flags).length > 0 ? { flags: this.flags } : {}),
      // Stamped when the body is built, so a chunk retried after a spell
      // offline carries the time it was actually sent.
      sentAt: this.now(),
    });
  }

  /**
   * Sends what is buffered, as as many chunks as it takes.
   *
   * After an outage the buffer can hold ten chunks' worth; sent as one body
   * it was over ingest's 512 KB limit, ingest answered 413, and the session
   * lost everything after the outage. So the buffer leaves in chunks of at
   * most `maxEventsPerChunk` events and about 256 KB, oldest first, one
   * request at a time. Only what was buffered when the flush began is sent:
   * what arrives meanwhile waits for the next flush, so a backlog does not
   * turn into one request per tick.
   *
   * `force` is the background flush: the only chance to send the tail, so it
   * goes even inside a backoff — but not inside a wait the server asked for.
   */
  async flush(options: { force?: boolean } = {}): Promise<void> {
    if (this.state === 'stopped' || this.inFlight || this.buffer.length === 0) return;
    const now = this.now();
    if (now < this.retryAt && !(options.force && now >= this.serverRetryAt)) return;

    this.inFlight = true;
    try {
      let budget = this.buffer.length;
      while (this.state === 'open' && this.buffer.length > 0 && budget > 0) {
        const before = this.buffer.length;
        const outcome = await this.sendOne();
        if (outcome === 'failed') break;
        // Stale-number recoveries and 413 splits put the same events back,
        // so the budget counts what actually left or was dropped.
        budget -= Math.max(0, before - this.buffer.length);
        if (outcome === 'sent' && this.buffer.length === 0) {
          this.chunkBytes = this.options.chunkBytes ?? TARGET_CHUNK_BYTES;
          this.chunkEvents = this.options.maxEventsPerChunk;
        }
      }
    } finally {
      this.inFlight = false;
    }
  }

  /** One request. `again` means the same events go back for another try right away. */
  private async sendOne(): Promise<'sent' | 'again' | 'failed'> {
    const batch = this.takeBatch();
    if (batch.length === 0) return 'sent';
    const events = batch.map((b) => b.event);

    const retry = this.lastAttemptedSeq === this.seq;
    this.lastAttemptedSeq = this.seq;
    // Reserved before the request leaves: an app killed mid-flight must not
    // hand this number to its next launch.
    this.hooks.onSeqReserved?.(this.seq + 1);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.options.ingestUrl}/v1/ingest/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: this.body(events),
      });
    } catch {
      // Offline, almost always. A phone spends real time with no network and a
      // recording that gave up would lose most of a commute.
      this.requeue(batch);
      this.registerFailure();
      return 'failed';
    }
    if (this.state === 'stopped') return 'failed';

    if (response.ok) {
      const nextSeq = retry ? undefined : await staleSeqHint(response, this.seq);
      if (nextSeq !== undefined && this.staleRecoveries < MAX_STALE_RECOVERIES) {
        // These events were new and the server discarded them. Send them
        // again under the first number it has not seen.
        this.staleRecoveries += 1;
        this.seq = nextSeq;
        this.requeue(batch);
        return 'again';
      }
      this.staleRecoveries = 0;
      this.delivered = true;
      this.seq += 1;
      this.pendingMeta = undefined;
      this.consecutiveFailures = 0;
      this.retryAt = 0;
      this.serverRetryAt = 0;
      this.hooks.onSent?.(this.seq - 1, events.length);
      return 'sent';
    }

    const status = response.status;

    if (status === 413) {
      // The body was too big for this server — a proxy with a lower limit, or
      // events whose size was misjudged. Nothing was stored, so the number is
      // free: send less under it. Halved until it fits; one event that still
      // does not fit is the one thing that cannot be sent, and only it goes.
      this.lastAttemptedSeq = -1;
      if (batch.length > 1) {
        const sent = batch.reduce((sum, b) => sum + b.bytes, 0);
        this.chunkBytes = Math.max(MIN_CHUNK_BYTES, Math.floor(Math.min(this.chunkBytes, sent) / 2));
        this.chunkEvents = Math.max(1, Math.floor(batch.length / 2));
        this.requeue(batch);
        return 'again';
      }
      this.warn(`dropped an event of ${batch[0]!.bytes} bytes that ingest would not take`);
      this.dropped(batch.map((b) => b.event));
      return 'again';
    }

    // Busy, or broken for a moment: the server will want these later.
    if (status === 429 || status === 408 || status >= 500) {
      this.requeue(batch);
      this.registerFailure(status === 429 || status === 503 ? retryAfterMs(response, this.now()) : undefined);
      return 'failed';
    }

    // Everything else is a verdict about this app or this body — a wrong key,
    // a project that is switched off, an app not on the allowed list, a quota
    // (402), a body the schema refuses — and retrying cannot change it.
    // Stopping is the only behaviour that does not turn a misconfigured app
    // into a flood from every install at once.
    this.stop(`rejected_${status}`);
    return 'failed';
  }

  /**
   * The oldest events that fit in one chunk.
   *
   * An event that could never fit in any body — a snapshot of an enormous
   * screen — is dropped here rather than sent to be refused: sent, it would
   * stop the recording; kept, it would block everything behind it.
   */
  private takeBatch(): Buffered[] {
    const batch: Buffered[] = [];
    let bytes = 0;
    while (this.buffer.length > 0 && batch.length < Math.min(this.options.maxEventsPerChunk, this.chunkEvents)) {
      const next = this.buffer[0]!;
      if (next.bytes > MAX_EVENT_BYTES) {
        this.buffer.shift();
        this.warn(`dropped an event of ${next.bytes} bytes; one chunk carries at most ${MAX_BODY_BYTES}`);
        this.dropped([next.event]);
        continue;
      }
      // +1 for the comma between events.
      if (batch.length > 0 && bytes + next.bytes + 1 > this.chunkBytes) break;
      batch.push(this.buffer.shift()!);
      bytes += next.bytes + 1;
    }
    return batch;
  }

  /** Puts a batch back in front of anything newer, oldest first, then holds the bound. */
  private requeue(batch: Buffered[]): void {
    this.buffer = [...batch, ...this.buffer];
    this.bound();
  }

  /**
   * Keeps the buffer bounded, dropping the oldest.
   *
   * Unbounded would be a memory leak with a clock on it: a phone in a tunnel
   * keeps generating events, and an app that grows until it is killed is worse
   * than a recording that is missing its middle.
   */
  private bound(): void {
    const over = this.buffer.length - this.options.maxBufferedEvents;
    if (over <= 0) return;
    const gone = this.buffer.splice(0, over).map((b) => b.event);
    this.warn(`offline buffer full; dropped the oldest ${over} events`);
    this.dropped(gone);
  }

  /**
   * Accounts for events that will never be sent.
   *
   * A mutation describes a change to the tree the reader built from the
   * snapshot and mutations before it. Once one of those is gone, every later
   * snapshot-dependent event still buffered points at nodes the reader does
   * not have (MUT-001), so they go too, and the recorder is asked for a whole
   * new tree. When only taps or custom events were lost, nothing else is
   * touched: nothing depended on them.
   */
  private dropped(events: RecordedEvent[]): void {
    if (!events.some(isTreeEvent)) return;
    const before = this.buffer.length;
    // Before anything was delivered, what is left after a drop would open the
    // recording — and a recording must open with the canvas size (SEQ-002),
    // which is the oldest event and so the first to go. So everything goes,
    // and the recording opens with the fresh Meta and snapshot the recorder
    // sends next. A tap or a tagged moment from the first minutes of an
    // outage is the price; an error among them has already set `hasError`.
    if (!this.delivered) {
      this.openingLost = true;
      this.buffer = [];
    } else {
      this.buffer = this.buffer.filter((b) => !isTreeEvent(b.event));
    }
    try {
      this.hooks.onDropped?.(events.length + before - this.buffer.length);
    } catch { /* a recorder must never break on its own bookkeeping */ }
  }

  /**
   * A failure that is worth trying again — offline, a 5xx, a 429 — waits
   * longer each time it repeats in a row: 2 s, 4 s, 8 s … at most a minute,
   * each with jitter so a fleet of phones coming out of the same outage does
   * not knock on ingest in lockstep. It never stops the recording: the buffer
   * is bounded, so waiting costs nothing but the oldest events of a very
   * long outage.
   */
  private registerFailure(serverWaitMs?: number): void {
    this.consecutiveFailures += 1;
    const now = this.now();
    const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(this.consecutiveFailures - 1, 16));
    const random = this.options.random ?? Math.random;
    let wait = ceiling / 2 + random() * (ceiling / 2);
    if (serverWaitMs !== undefined) {
      const asked = Math.min(serverWaitMs, RETRY_AFTER_MAX_MS);
      this.serverRetryAt = now + asked;
      wait = Math.max(wait, asked);
    }
    this.retryAt = now + Math.round(wait);
  }

  private warn(message: string): void {
    if (this.options.debug) console.warn(`[anyreplay] ${message}`);
  }
}
