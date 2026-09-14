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

/** How many times one flush may move to a new chunk number before giving up. */
const MAX_STALE_RECOVERIES = 3;

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

export type TransportState = 'open' | 'stopped';

/**
 * The Fetch standard caps the total body size of in-flight `keepalive`
 * requests at 64 KiB, and a browser rejects an oversized one outright — the
 * promise rejects with a bare TypeError, indistinguishable from being offline.
 *
 * The margin below is for the request headers, which count towards the same
 * budget, and for a second flush overlapping the first.
 */
const KEEPALIVE_BODY_LIMIT_BYTES = 56 * 1024;

/**
 * Whether a payload may be sent with `keepalive`.
 *
 * Deciding this from the event *count* is the trap: the first chunk of every
 * session is a Meta plus a single full DOM snapshot — two events, and on a real
 * page routinely several hundred kilobytes. Sizing by count marks it as small,
 * the browser refuses it, and the recorder counts a network failure it can
 * never recover from; after `maxConsecutiveFailures` it stops for good. The
 * symptom is a site that records nothing at all while the snippet looks
 * perfectly installed.
 */
export function withinKeepaliveLimit(payload: string): boolean {
  const bytes = typeof TextEncoder === 'function'
    ? new TextEncoder().encode(payload).length
    // No TextEncoder: assume the worst rather than risk the rejection.
    : payload.length * 3;
  return bytes <= KEEPALIVE_BODY_LIMIT_BYTES;
}

export interface TransportHooks {
  onStopped?: (reason: string) => void;
  onSent?: (seq: number, eventCount: number) => void;
  /** Called with the next free chunk number before a request using the current one leaves. */
  onSeqReserved?: (nextSeq: number) => void;
}

/**
 * Ships buffered events to ingest.
 *
 * Three properties matter more than throughput here, because this code runs
 * inside somebody else's product:
 *
 *  - It must never throw into the host page.
 *  - It must never keep retrying a request the server has rejected on its
 *    merits (a bad key, a disallowed origin) — that is an infinite loop.
 *  - It must not lose the tail of a session when the tab closes.
 */
export class Transport {
  private buffer: RecordedEvent[] = [];
  private seq = 0;
  private consecutiveFailures = 0;
  private state: TransportState = 'open';
  private timer: ReturnType<typeof setInterval> | undefined;
  private pendingMeta: SessionMeta | undefined;
  private flags: ChunkFlags = {};
  private inFlight = false;
  /** The chunk number of the last request that left, to tell a retry from a first attempt. */
  private lastAttemptedSeq = -1;
  private staleRecoveries = 0;

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

  get bufferedCount(): number {
    return this.buffer.length;
  }

  get sentChunks(): number {
    return this.seq;
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
    this.timer = undefined;
    this.buffer = [];
    this.hooks.onStopped?.(reason);
  }

  push(event: RecordedEvent): void {
    if (this.state === 'stopped') return;
    this.buffer.push(event);
    if (this.buffer.length >= this.options.maxEventsPerChunk) void this.flush();
  }

  private body(events: RecordedEvent[]): string {
    return JSON.stringify({
      projectKey: this.context.projectKey,
      sessionId: this.context.sessionId,
      visitorId: this.context.visitorId,
      seq: this.seq,
      events,
      ...(this.pendingMeta ? { meta: this.pendingMeta } : {}),
      ...(Object.keys(this.flags).length > 0 ? { flags: this.flags } : {}),
    });
  }

  /** Sends whatever is buffered. Safe to call when there is nothing to send. */
  async flush(): Promise<void> {
    if (this.state === 'stopped' || this.inFlight || this.buffer.length === 0) return;

    this.inFlight = true;
    const events = this.buffer;
    this.buffer = [];
    let resend = false;

    try {
      const retry = this.lastAttemptedSeq === this.seq;
      this.lastAttemptedSeq = this.seq;
      // Reserved before the request leaves: a page that is closed mid-flight
      // must not hand this number to the next page of the same session.
      this.hooks.onSeqReserved?.(this.seq + 1);
      const payload = this.body(events);
      const response = await fetch(`${this.options.ingestUrl}/v1/ingest/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        // Ingest is unauthenticated by design; sending credentials would be a
        // cross-site cookie leak for no benefit.
        credentials: 'omit',
        keepalive: withinKeepaliveLimit(payload),
      });

      if (response.ok) {
        const nextSeq = retry ? undefined : await staleSeqHint(response, this.seq);
        if (nextSeq !== undefined && this.staleRecoveries < MAX_STALE_RECOVERIES) {
          // These events were new and the server discarded them. Send them
          // again under the first number it has not seen.
          this.staleRecoveries += 1;
          this.seq = nextSeq;
          this.requeue(events);
          resend = true;
          return;
        }
        this.staleRecoveries = 0;
        this.seq += 1;
        this.pendingMeta = undefined;
        this.consecutiveFailures = 0;
        this.hooks.onSent?.(this.seq - 1, events.length);
        return;
      }

      // 4xx other than 429 is a verdict, not a hiccup: the key is wrong, the
      // origin is not allowed, or the payload is malformed. Retrying cannot
      // change the answer, so stop instead of hammering the endpoint forever.
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        this.stop(`rejected_${response.status}`);
        return;
      }

      this.requeue(events);
      this.registerFailure();
    } catch {
      // Network error: the user may simply be offline. Keep the events.
      this.requeue(events);
      this.registerFailure();
    } finally {
      this.inFlight = false;
      if (resend) void this.flush();
    }
  }

  /**
   * Puts a failed batch back at the front of the queue.
   *
   * Bounded on purpose: a long offline period must not grow the buffer until
   * the tab runs out of memory. Older events are dropped first — a replay
   * missing its beginning is still useful; a crashed page is not.
   */
  private requeue(events: RecordedEvent[]): void {
    const limit = this.options.maxEventsPerChunk * 10;
    this.buffer = [...events, ...this.buffer].slice(-limit);
  }

  private registerFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.options.maxConsecutiveFailures) {
      this.stop('too_many_failures');
    }
  }

  /**
   * Last-gasp send when the page is going away.
   *
   * `fetch` is cancelled once the document unloads, so the tail of every
   * session would be lost. `sendBeacon` hands the payload to the browser, which
   * delivers it after the page is gone.
   */
  flushWithBeacon(): boolean {
    if (this.state === 'stopped' || this.buffer.length === 0) return false;

    const events = this.buffer;
    const payload = this.body(events);
    this.buffer = [];

    try {
      if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
        // text/plain avoids a CORS preflight, which cannot complete during unload.
        this.hooks.onSeqReserved?.(this.seq + 1);
        const blob = new Blob([payload], { type: 'text/plain;charset=UTF-8' });
        const queued = navigator.sendBeacon(`${this.options.ingestUrl}/v1/ingest/events`, blob);
        if (queued) {
          this.seq += 1;
          this.pendingMeta = undefined;
          return true;
        }
      }
    } catch {
      /* fall through */
    }

    this.buffer = events;
    return false;
  }
}
