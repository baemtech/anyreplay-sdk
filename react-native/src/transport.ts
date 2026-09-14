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
 * a failed chunk is kept and retried rather than dropped.
 */

export interface TransportOptions {
  ingestUrl: string;
  projectKey: string;
  sessionId: string;
  visitorId: string;
  maxEventsPerChunk: number;
  maxConsecutiveFailures: number;
  /** Keeps at most this many events while offline before dropping the oldest. */
  maxBufferedEvents: number;
  /** The first chunk number to use. Non-zero when a relaunch resumes a session. */
  initialSeq?: number;
}

/** How many times one flush may move to a new chunk number before giving up. */
const MAX_STALE_RECOVERIES = 3;

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

export interface TransportHooks {
  onStopped?: (reason: string) => void;
  onSent?: (seq: number, events: number) => void;
  /** Called with the next free chunk number before a request using the current one leaves. */
  onSeqReserved?: (nextSeq: number) => void;
}

export type TransportState = 'open' | 'stopped';

export class Transport {
  private buffer: RecordedEvent[] = [];
  private seq = 0;
  private consecutiveFailures = 0;
  private state: TransportState = 'open';
  private inFlight = false;
  /** The chunk number of the last request that left, to tell a retry from a first attempt. */
  private lastAttemptedSeq = -1;
  private staleRecoveries = 0;
  private pendingMeta: SessionMeta | undefined;
  private flags: ChunkFlags = {};

  constructor(
    private readonly options: TransportOptions,
    private readonly hooks: TransportHooks = {},
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.seq = options.initialSeq ?? 0;
  }

  get isStopped(): boolean { return this.state === 'stopped'; }
  get bufferedCount(): number { return this.buffer.length; }
  get sentChunks(): number { return this.seq; }

  setMeta(meta: SessionMeta): void { this.pendingMeta = meta; }
  mergeFlags(flags: ChunkFlags): void { this.flags = { ...this.flags, ...flags }; }

  push(event: RecordedEvent): void {
    if (this.state === 'stopped') return;
    this.buffer.push(event);
    if (this.buffer.length >= this.options.maxEventsPerChunk) void this.flush();
  }

  stop(reason: string): void {
    this.state = 'stopped';
    this.buffer = [];
    this.hooks.onStopped?.(reason);
  }

  private body(events: RecordedEvent[]): string {
    return JSON.stringify({
      projectKey: this.options.projectKey,
      sessionId: this.options.sessionId,
      visitorId: this.options.visitorId,
      seq: this.seq,
      events,
      ...(this.pendingMeta ? { meta: this.pendingMeta } : {}),
      ...(Object.keys(this.flags).length > 0 ? { flags: this.flags } : {}),
    });
  }

  async flush(): Promise<void> {
    if (this.state === 'stopped' || this.inFlight || this.buffer.length === 0) return;

    this.inFlight = true;
    const events = this.buffer;
    this.buffer = [];
    let resend = false;

    try {
      const retry = this.lastAttemptedSeq === this.seq;
      this.lastAttemptedSeq = this.seq;
      // Reserved before the request leaves: an app killed mid-flight must not
      // hand this number to its next launch.
      this.hooks.onSeqReserved?.(this.seq + 1);
      const response = await this.fetchImpl(`${this.options.ingestUrl}/v1/ingest/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: this.body(events),
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

      // A 4xx that is not 429 is a verdict — a wrong key, a project that is
      // switched off — and retrying cannot change it. Stopping is the only
      // behaviour that does not turn a misconfigured app into a flood.
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        this.stop(`rejected_${response.status}`);
        return;
      }

      this.requeue(events);
      this.registerFailure();
    } catch {
      // Offline, almost always. A phone spends real time with no network and a
      // recording that gave up the first time would lose most of a commute.
      this.requeue(events);
      this.registerFailure();
    } finally {
      this.inFlight = false;
      if (resend) void this.flush();
    }
  }

  /**
   * Puts a failed batch back, oldest-first and bounded.
   *
   * Unbounded would be a memory leak with a clock on it: a phone in a tunnel
   * keeps generating events, and an app that grows until it is killed is worse
   * than a recording that is missing its middle.
   */
  private requeue(events: RecordedEvent[]): void {
    this.buffer = [...events, ...this.buffer].slice(-this.options.maxBufferedEvents);
  }

  private registerFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.options.maxConsecutiveFailures) {
      this.stop('too_many_failures');
    }
  }
}
