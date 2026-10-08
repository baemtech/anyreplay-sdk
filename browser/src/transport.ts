import type { ResolvedOptions } from './config.js';

export interface RecordedEvent {
  type: number;
  timestamp: number;
  data?: unknown;
}

export interface SessionMeta {
  startedAt: number;
  url?: string;
  lang?: string;
  userAgent?: string;
  screenWidth?: number;
  screenHeight?: number;
  referrer?: string;
  /** `maxSessionsPerMonth`, sent only with chunk 0 of a new session. */
  sessionCap?: number;
  /** What this SDK records on — always `web` for this one. */
  platform?: string;
  /** This SDK, so a session says which release recorded it. */
  sdk?: { name: string; version: string };
  /** Only from a wrapper that knows the app (`ShellInfo` in recorder.ts). */
  appVersion?: string;
  deviceModel?: string;
}

export interface ChunkFlags {
  hasError?: boolean;
  hasRageClick?: boolean;
  pageCount?: number;
}

export interface TransportContext {
  projectKey: string;
  sessionId: string;
  visitorId: string;
  /** The first chunk number to use. Non-zero when a page resumes a session. */
  initialSeq?: number;
}

/** How many times one chunk may move to a new chunk number before giving up. */
const MAX_STALE_RECOVERIES = 3;

/** rrweb's event types this file has to tell apart. */
const EVENT_FULL_SNAPSHOT = 2;
const EVENT_INCREMENTAL = 3;

/**
 * Ingest refuses a body over 512 KB with `413` (`MAX_CHUNK_BYTES` in
 * apps/ingest/src/config.ts). Nothing this transport builds may exceed it.
 */
export const MAX_BODY_BYTES = 512 * 1024;

/**
 * What one chunk aims for when several events share it: half the hard limit.
 *
 * The margin is for the envelope (meta, flags) and for a self-hosted ingest
 * configured a little lower than ours. A full snapshot bigger than this still
 * goes, alone, as long as it is under the hard limit.
 */
export const TARGET_CHUNK_BYTES = 256 * 1024;

/**
 * The smallest body limit a run of `413`s can shrink this transport to. Below
 * it every rrweb snapshot would be "too large", and an ingest that refuses
 * 8 KB is misconfigured rather than strict.
 */
const MIN_BODY_BYTES = 8 * 1024;

/** Room left for the envelope when deciding which events fit. */
const ENVELOPE_SLACK_BYTES = 1024;

/** One flush sends at most this many chunks back to back; the next tick continues. */
const MAX_CHUNKS_PER_FLUSH = 20;

/** Backoff after a delivery failure: 2 s, 4 s, 8 s … at most a minute, each with jitter. */
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 60_000;

/**
 * The longest `Retry-After` honoured. A server asking for more is either
 * misconfigured or answering for someone else; an hour of silence would cost
 * the whole visit, and ten minutes inside the in-memory buffer is already
 * most of it.
 */
const MAX_RETRY_AFTER_MS = 10 * 60_000;

/**
 * Refusals of a chunk's contents (`400`, `422`) in a row before the transport
 * stops. One is a bad event and costs that chunk; three in a row means every
 * chunk is refused — a visitor id or key ingest will never take — and going
 * on would upload a fresh snapshot every few seconds for nothing.
 */
const MAX_CONSECUTIVE_REFUSALS = 3;

/**
 * The first free chunk number, when ingest says the one just sent was taken.
 *
 * Ingest answers a repeated (session, seq) with 202 and `duplicate: true`,
 * because to the server it looks like a retry. When this transport had never
 * sent that number before, it was not a retry: the number was used by an
 * earlier page of the session, or by another tab sharing it, and the events
 * were discarded. Servers that know the answer say where numbering continues.
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

/**
 * How long the server asked us to wait, from `Retry-After`: either a number
 * of seconds or an HTTP date. Undefined when there is no usable header —
 * including when the browser hides it, which it does on a cross-origin
 * response unless ingest lists it in `Access-Control-Expose-Headers`.
 */
export function retryAfterMs(response: Response, now = Date.now()): number | undefined {
  let raw: string | null | undefined;
  try {
    raw = response.headers?.get?.('Retry-After');
  } catch {
    return undefined;
  }
  if (!raw) return undefined;
  const text = raw.trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Math.min(MAX_RETRY_AFTER_MS, Number(text) * 1000);
  const date = Date.parse(text);
  if (Number.isNaN(date)) return undefined;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, date - now));
}

/**
 * UTF-8 length of a string, without allocating its encoding.
 *
 * Every event is measured once, on its way into a chunk, and a full snapshot
 * runs to hundreds of kilobytes; `TextEncoder` would copy each of them only to
 * read `.length`. Lone surrogates count as the three bytes their replacement
 * character takes, which is what `JSON.stringify` + UTF-8 produce.
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

export type TransportState = 'open' | 'stopped';

/**
 * The Fetch standard caps the total body size of in-flight `keepalive`
 * requests at 64 KiB, and a browser rejects an oversized one outright — the
 * promise rejects with a bare TypeError, indistinguishable from being offline.
 * `sendBeacon` shares the same budget.
 *
 * The margin below is for the request headers, which count towards the same
 * budget, and for a second flush overlapping the first.
 */
export const KEEPALIVE_BODY_LIMIT_BYTES = 56 * 1024;

/**
 * Whether a payload may be sent with `keepalive`.
 *
 * Deciding this from the event *count* is the trap: the first chunk of every
 * session is a Meta plus a single full DOM snapshot — two events, and on a real
 * page routinely several hundred kilobytes. Sizing by count marks it as small,
 * the browser refuses it, and the recorder counts a network failure for a
 * request that can never succeed. The symptom is a site that records nothing
 * at all while the snippet looks perfectly installed.
 */
export function withinKeepaliveLimit(payload: string): boolean {
  return utf8Length(payload) <= KEEPALIVE_BODY_LIMIT_BYTES;
}

export interface TransportHooks {
  onStopped?: (reason: string) => void;
  onSent?: (seq: number, eventCount: number) => void;
  /** Called with the next free chunk number before a request using the current one leaves. */
  onSeqReserved?: (nextSeq: number) => void;
  /**
   * Called when events had to be dropped and the recording needs a fresh
   * full snapshot to make sense again. The recorder answers by taking one
   * (`record.takeFullSnapshot`); until it arrives, DOM changes are not kept,
   * since they would describe nodes the server never saw.
   */
  onResyncNeeded?: () => void;
  /** Debug-only explanations: an event dropped, a body limit lowered. */
  onWarning?: (message: string) => void;
}

/** A chunk with its number, built once and resent byte-for-byte on every retry. */
interface Chunk {
  seq: number;
  events: RecordedEvent[];
  /** The events, already serialised, in order. */
  parts: string[];
  /** Attempts under the current `seq`. A duplicate answer to a retry means it arrived. */
  attempts: number;
}

type Outcome = 'sent' | 'again' | 'wait' | 'stopped';

/**
 * Ships buffered events to ingest.
 *
 * Three properties matter more than throughput here, because this code runs
 * inside somebody else's product:
 *
 *  - It must never throw into the host page.
 *  - It must never keep retrying a request the server has rejected on its
 *    merits (a bad key, a disallowed origin) — that is an infinite loop.
 *  - It must not lose the session to a network that is merely away: a train
 *    tunnel, a laptop lid, a flaky café connection. It backs off and waits
 *    instead of giving up, and keeps a bounded buffer meanwhile.
 *
 * And one property of every body it sends: under ingest's size limit. An
 * outage leaves up to 2000 events waiting; they go out as a run of chunks of
 * at most 200 events and about 256 KB each, in order, never as one body ingest
 * would refuse.
 */
export class Transport {
  private buffer: RecordedEvent[] = [];
  /** The chunk being delivered: built, numbered, maybe already attempted. */
  private pending: Chunk | undefined;
  /** The next unused chunk number. */
  private seq = 0;
  private consecutiveFailures = 0;
  private consecutiveRefusals = 0;
  private state: TransportState = 'open';
  private timer: ReturnType<typeof setInterval> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingMeta: SessionMeta | undefined;
  private flags: ChunkFlags = {};
  private inFlight = false;
  private staleRecoveries = 0;
  /** Our own backoff after a failure. Cleared when the network comes back. */
  private backoffUntil = 0;
  /** What the server asked for in `Retry-After`. Not cleared by anything but time. */
  private serverWaitUntil = 0;
  /** Largest body this transport will build; lowered by a `413`. */
  private bodyLimit = MAX_BODY_BYTES;
  private targetBytes = TARGET_CHUNK_BYTES;
  /**
   * Set when events were dropped and a full snapshot has been asked for:
   * DOM changes are not kept until it arrives.
   */
  private awaitingSnapshot = false;
  /** Serialised events, so a retry or a re-split does not stringify a snapshot twice. */
  private readonly serialised = new WeakMap<RecordedEvent, string>();

  constructor(
    private readonly options: ResolvedOptions,
    private readonly context: TransportContext,
    private readonly hooks: TransportHooks = {},
  ) {
    this.seq = context.initialSeq ?? 0;
  }

  get isStopped(): boolean {
    return this.state === 'stopped';
  }

  /** Events not yet delivered, including a chunk waiting to be retried. */
  get bufferedCount(): number {
    return this.buffer.length + (this.pending?.events.length ?? 0);
  }

  /** The number the next undelivered chunk will carry — the count of chunks delivered, for a fresh session. */
  get sentChunks(): number {
    return this.pending?.seq ?? this.seq;
  }

  /** The most events kept while deliveries fail. Older ones are dropped first. */
  private get bufferLimit(): number {
    return this.options.maxEventsPerChunk * 10;
  }

  /** Attaches metadata to the next chunk. Sent once, with the session's first chunk. */
  setMeta(meta: SessionMeta): void {
    this.pendingMeta = meta;
  }

  mergeFlags(flags: ChunkFlags): void {
    this.flags = { ...this.flags, ...flags };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), this.options.flushIntervalMs);
    // Never hold a Node process open; harmless in browsers.
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  stop(reason: string): void {
    this.state = 'stopped';
    if (this.timer) clearInterval(this.timer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.timer = undefined;
    this.retryTimer = undefined;
    this.buffer = [];
    this.pending = undefined;
    this.hooks.onStopped?.(reason);
  }

  push(event: RecordedEvent): void {
    if (this.state === 'stopped') return;
    if (this.awaitingSnapshot) {
      // A DOM change made before the fresh snapshot is already in it.
      if (event.type === EVENT_INCREMENTAL) return;
      if (event.type === EVENT_FULL_SNAPSHOT) this.awaitingSnapshot = false;
    }
    this.buffer.push(event);
    if (this.bufferedCount > this.bufferLimit) this.dropOldest(this.bufferedCount - this.bufferLimit);
    if (this.buffer.length >= this.options.maxEventsPerChunk) void this.flush();
  }

  /**
   * The network is back (`online`), or the page is visible again: try now
   * rather than at the end of the backoff. A server's `Retry-After` still
   * holds — it was not about our connection.
   */
  resume(): void {
    if (this.state === 'stopped') return;
    this.backoffUntil = 0;
    void this.flush();
  }

  /**
   * Sends whatever is buffered, as as many chunks as it takes. Safe to call
   * when there is nothing to send, and while waiting out a failure, when it
   * does nothing. `force` skips our own backoff (an explicit `flush()` from
   * the page) but never the server's `Retry-After`.
   */
  async flush(force = false): Promise<void> {
    if (this.state === 'stopped' || this.inFlight) return;
    const now = Date.now();
    if (now < this.serverWaitUntil) return;
    if (!force && now < this.backoffUntil) return;
    if (!this.pending && this.buffer.length === 0) return;

    this.inFlight = true;
    try {
      // `again` (a re-cut, a dropped chunk, a new number) does not count as a
      // chunk sent, so the attempts are bounded separately.
      for (let sent = 0, tries = 0; sent < MAX_CHUNKS_PER_FLUSH && tries < MAX_CHUNKS_PER_FLUSH * 3 && this.state === 'open'; tries += 1) {
        const chunk = this.pending ?? this.nextChunk(this.bodyLimit, this.targetBytes);
        if (!chunk) break;
        this.pending = chunk;
        const outcome = await this.send(chunk);
        if (outcome === 'sent') sent += 1;
        else if (outcome !== 'again') break;
      }
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Builds the next chunk from the front of the buffer: at most
   * `maxEventsPerChunk` events and `target` bytes, or one event alone up to
   * `limit`. An event too large for any chunk is dropped here — it would be
   * refused, and refused again, and hold up everything behind it. For a
   * beacon (`forBeacon`) it is left where it is instead: an ordinary request
   * can still carry what a beacon cannot.
   */
  private nextChunk(limit: number, target: number, forBeacon = false): Chunk | undefined {
    const envelope = utf8Length(this.envelope(this.seq)) + ENVELOPE_SLACK_BYTES;
    const events: RecordedEvent[] = [];
    const parts: string[] = [];
    let bytes = envelope;

    while (this.buffer.length > 0 && events.length < this.options.maxEventsPerChunk) {
      const event = this.buffer[0]!;
      const part = this.serialise(event);
      const size = utf8Length(part) + 1;
      if (events.length === 0 && bytes + size > limit) {
        if (forBeacon) return undefined;
        this.buffer.shift();
        if (!this.dropOversized(event, size)) return undefined;
        continue;
      }
      if (events.length > 0 && bytes + size > target) break;
      events.push(event);
      parts.push(part);
      bytes += size;
      this.buffer.shift();
    }
    if (events.length === 0) return undefined;

    const chunk: Chunk = { seq: this.seq, events, parts, attempts: 0 };
    this.seq += 1;
    return chunk;
  }

  /**
   * An event that no chunk can carry. A DOM change or a custom event is
   * dropped, and the DOM is re-sent whole if the dropped one described it.
   * A full snapshot that alone exceeds the limit is a page this transport
   * cannot record — re-taking it would only be refused again — so recording
   * stops instead of uploading a snapshot every few seconds forever.
   */
  private dropOversized(event: RecordedEvent, bytes: number): boolean {
    const kb = Math.ceil(bytes / 1024);
    if (event.type === EVENT_FULL_SNAPSHOT) {
      this.hooks.onWarning?.(`page snapshot is ${kb} KB, over the ${Math.floor(this.bodyLimit / 1024)} KB ingest accepts`);
      this.stop('snapshot_too_large');
      return false;
    }
    this.hooks.onWarning?.(`dropped one event of ${kb} KB: larger than ingest accepts`);
    if (event.type === EVENT_INCREMENTAL) this.afterGap();
    return true;
  }

  private serialise(event: RecordedEvent): string {
    let part = this.serialised.get(event);
    if (part === undefined) {
      part = JSON.stringify(event);
      this.serialised.set(event, part);
    }
    return part;
  }

  /** Everything in a chunk's body except its events, as a JSON object. */
  private envelope(seq: number): string {
    return JSON.stringify({
      projectKey: this.context.projectKey,
      sessionId: this.context.sessionId,
      visitorId: this.context.visitorId,
      seq,
      // The app this page runs inside, on every request: ingest reads it only
      // when the request has no real web origin. See `appId` in config.ts.
      ...(this.options.appId ? { appId: this.options.appId } : {}),
      ...(this.pendingMeta ? { meta: this.pendingMeta } : {}),
      ...(Object.keys(this.flags).length > 0 ? { flags: this.flags } : {}),
      // This device's clock as the request leaves, on the same clock as the
      // event timestamps. Ingest compares it with its own to catch a device
      // that runs ahead — a test phone three weeks fast would otherwise list
      // its sessions as starting "in 3 weeks". Stamped here, when the body is
      // built, so a retry or a queue flushed after a spell offline carries
      // the time it was actually sent rather than when it was recorded.
      sentAt: Date.now(),
    });
  }

  /**
   * The body, assembled from the events' cached JSON rather than by
   * stringifying them again: a retry resends exactly the bytes the first
   * attempt sent, which is also what lets ingest read it as a retry.
   */
  private body(chunk: Chunk): string {
    return `{"events":[${chunk.parts.join(',')}],${this.envelope(chunk.seq).slice(1)}`;
  }

  /** One request, and what to do next. */
  private async send(chunk: Chunk): Promise<Outcome> {
    const retry = chunk.attempts > 0;
    chunk.attempts += 1;
    // Reserved before the request leaves: a page that is closed mid-flight
    // must not hand this number to the next page of the same session.
    this.hooks.onSeqReserved?.(chunk.seq + 1);
    const payload = this.body(chunk);

    let response: Response;
    try {
      response = await fetch(`${this.options.ingestUrl}/v1/ingest/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        // Ingest is unauthenticated by design; sending credentials would be a
        // cross-site cookie leak for no benefit.
        credentials: 'omit',
        keepalive: withinKeepaliveLimit(payload),
      });
    } catch {
      // Network error: the visitor may simply be offline. Keep the chunk.
      return this.registerFailure(undefined);
    }
    if (this.state === 'stopped' || this.pending !== chunk) return 'stopped';

    if (response.ok) {
      const nextSeq = retry ? undefined : await staleSeqHint(response, chunk.seq);
      if (nextSeq !== undefined && this.staleRecoveries < MAX_STALE_RECOVERIES) {
        // These events were new and the server discarded them. Send them
        // again under the first number it has not seen.
        this.staleRecoveries += 1;
        chunk.seq = nextSeq;
        chunk.attempts = 0;
        this.seq = Math.max(this.seq, nextSeq + 1);
        return 'again';
      }
      this.pending = undefined;
      this.staleRecoveries = 0;
      this.pendingMeta = undefined;
      this.consecutiveFailures = 0;
      this.consecutiveRefusals = 0;
      this.backoffUntil = 0;
      this.hooks.onSent?.(chunk.seq, chunk.events.length);
      return 'sent';
    }

    const status = response.status;
    if (status === 413) return this.shrink(chunk, utf8Length(payload));

    // The chunk's contents were refused. Retrying the same bytes cannot help,
    // and stopping would lose the rest of the visit over one bad event, so
    // that chunk goes and recording continues — unless every chunk is refused.
    if (status === 400 || status === 422) {
      this.pending = undefined;
      this.consecutiveRefusals += 1;
      if (this.consecutiveRefusals >= MAX_CONSECUTIVE_REFUSALS) {
        this.stop(`rejected_${status}`);
        return 'stopped';
      }
      this.hooks.onWarning?.(`ingest refused a chunk (${status}); its ${chunk.events.length} events are dropped`);
      this.afterGap();
      return 'again';
    }

    // A timeout, a rate limit or a server error: try again later.
    if (status === 408 || status === 429 || status >= 500) {
      return this.registerFailure(retryAfterMs(response));
    }

    // Any other 4xx is a verdict, not a hiccup: the key is wrong, the origin
    // is not allowed (403), the plan is full (402), the URL is not ingest
    // (404). Retrying cannot change the answer, so stop instead of hammering
    // the endpoint from every page load forever.
    this.stop(`rejected_${status}`);
    return 'stopped';
  }

  /**
   * `413`: this ingest takes less than we thought. The chunk was not stored,
   * so its events go back to the front of the queue and are re-cut under a
   * lower limit; its number is not reused, so no number ever carries two
   * different sets of events. A chunk of one event that is still too large is
   * dropped by `nextChunk` on the way back out.
   */
  private shrink(chunk: Chunk, bytes: number): Outcome {
    this.pending = undefined;
    if (this.bodyLimit <= MIN_BODY_BYTES) {
      // Refusing even this little is not a size limit any chunk can meet.
      this.stop('rejected_413');
      return 'stopped';
    }
    this.buffer = [...chunk.events, ...this.buffer];
    this.bodyLimit = Math.max(MIN_BODY_BYTES, Math.min(this.bodyLimit, Math.floor(bytes / 2)));
    this.targetBytes = Math.min(this.targetBytes, this.bodyLimit);
    this.hooks.onWarning?.(`ingest refused ${Math.ceil(bytes / 1024)} KB as too large; sending at most ${Math.floor(this.bodyLimit / 1024)} KB per chunk`);
    return 'again';
  }

  /**
   * Counts a failed delivery and schedules the next attempt: 2 s, 4 s, 8 s …
   * up to a minute, each with jitter so a thousand tabs that lost the same
   * Wi-Fi do not all come back in the same second. The chunk stays pending,
   * to be resent under the same number.
   *
   * Recording does not stop over this unless the page asked for it with
   * `maxConsecutiveFailures`: the buffer exists for exactly this, and a
   * phone in a tunnel for half a minute must not end the visit's recording.
   */
  private registerFailure(serverWaitMs: number | undefined): Outcome {
    this.consecutiveFailures += 1;
    const limit = this.options.maxConsecutiveFailures;
    if (limit > 0 && this.consecutiveFailures >= limit) {
      this.stop('too_many_failures');
      return 'stopped';
    }
    const now = Date.now();
    const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(this.consecutiveFailures - 1, 16));
    const delay = ceiling / 2 + Math.random() * (ceiling / 2);
    this.backoffUntil = now + delay;
    if (serverWaitMs !== undefined) this.serverWaitUntil = now + serverWaitMs;
    this.scheduleRetry(Math.max(this.backoffUntil, this.serverWaitUntil) - now);
    return 'wait';
  }

  /**
   * The attempt at the end of a backoff. It skips the backoff check itself:
   * a timer may fire a fraction of a millisecond "early" against `Date.now`,
   * and refusing then would leave nothing scheduled until the next tick.
   */
  private scheduleRetry(delayMs: number): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.flush(true);
    }, Math.max(0, Math.ceil(delayMs)));
    (this.retryTimer as unknown as { unref?: () => void }).unref?.();
  }

  /**
   * Keeps the buffer bounded during a long outage. Older events go first — a
   * replay missing a stretch is still useful; a crashed page is not. A chunk
   * waiting to be retried is the oldest of all, and goes whole: sending part
   * of it under its number could clash with an attempt that did arrive.
   */
  private dropOldest(count: number): void {
    let remaining = count;
    if (this.pending && !this.inFlight) {
      remaining -= this.pending.events.length;
      this.pending = undefined;
    }
    if (remaining > 0) this.buffer.splice(0, remaining);
    this.hooks.onWarning?.(`dropped ${count} buffered events while ingest could not be reached`);
    this.afterGap();
  }

  /**
   * After events were dropped: DOM changes left before the next full snapshot
   * may describe nodes whose creation was dropped, and a replay applying them
   * breaks. They go, and when the buffer holds no snapshot to start again
   * from, the recorder is asked for one. Custom events, errors and the like
   * do not depend on the DOM and stay.
   */
  private afterGap(): void {
    const snapshot = this.buffer.findIndex((e) => e.type === EVENT_FULL_SNAPSHOT);
    const end = snapshot === -1 ? this.buffer.length : snapshot;
    this.buffer = [
      ...this.buffer.slice(0, end).filter((e) => e.type !== EVENT_INCREMENTAL),
      ...this.buffer.slice(end),
    ];
    if (snapshot === -1 && !this.awaitingSnapshot && this.hooks.onResyncNeeded) {
      this.awaitingSnapshot = true;
      this.hooks.onResyncNeeded();
    }
  }

  /**
   * Last-gasp send when the page is going away or hidden.
   *
   * `fetch` is cancelled once the document unloads, so the tail of every
   * session would be lost. `sendBeacon` hands the payload to the browser, which
   * delivers it after the page is gone — but only up to 64 KB in flight, so
   * the tail goes as a run of small chunks, oldest first, until the browser
   * says it has no room. What it refuses stays buffered for the page's next
   * flush, should there be one (a hidden tab that comes back, a page restored
   * from the back/forward cache).
   *
   * For a tab that is only hidden, and so likely to come back, nothing goes
   * while deliveries are failing or the server asked us to wait: a beacon
   * "queued" while offline is usually a beacon lost, where the buffer and the
   * backoff would have delivered it. On `pagehide` (`final`), the last
   * chance there is, it goes regardless.
   */
  flushWithBeacon(final = false): boolean {
    if (this.state === 'stopped' || (!this.pending && this.buffer.length === 0)) return false;
    if (!final && (this.consecutiveFailures > 0 || Date.now() < this.serverWaitUntil)) return false;
    if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') return false;

    const url = `${this.options.ingestUrl}/v1/ingest/events`;
    let queuedAny = false;
    let tooLarge = false;
    try {
      // A chunk that failed earlier goes first, under its own number. If it
      // is still in flight this may deliver it twice, which ingest reads as a
      // retry; the alternative is losing it with the page.
      const pending = this.pending;
      if (pending) {
        const payload = this.body(pending);
        if (!withinKeepaliveLimit(payload)) {
          tooLarge = true;
        } else {
          if (!this.beacon(url, pending, payload)) return queuedAny;
          queuedAny = true;
          if (!this.inFlight) {
            this.pending = undefined;
            this.pendingMeta = undefined;
          }
        }
      }

      while (!tooLarge && this.buffer.length > 0) {
        const chunk = this.nextChunk(KEEPALIVE_BODY_LIMIT_BYTES, KEEPALIVE_BODY_LIMIT_BYTES, true);
        if (!chunk) {
          // The next event alone is over what a beacon may carry.
          tooLarge = true;
          break;
        }
        const payload = this.body(chunk);
        if (!this.beacon(url, chunk, payload)) {
          // The browser's queue is full. The events go back, and the number
          // with them: nothing was sent under it.
          this.buffer = [...chunk.events, ...this.buffer];
          this.seq = chunk.seq;
          break;
        }
        queuedAny = true;
        this.pendingMeta = undefined;
      }
    } catch {
      /* never into the page */
    }

    // Something too big for any beacon — usually a fresh full snapshot. A
    // hidden page is still alive, and an ordinary request carries it.
    if (tooLarge) void this.flush(true);
    return queuedAny;
  }

  /** Hands one chunk to the browser. False when its beacon queue is full. */
  private beacon(url: string, chunk: Chunk, payload: string): boolean {
    this.hooks.onSeqReserved?.(chunk.seq + 1);
    // text/plain avoids a CORS preflight, which cannot complete during unload.
    const blob = new Blob([payload], { type: 'text/plain;charset=UTF-8' });
    return navigator.sendBeacon(url, blob);
  }
}
