/**
 * Crashes: the crash clip, and what a dying process leaves for the next launch.
 *
 * A crash clip is the last ~30 seconds before a crash, for a visitor who is
 * not being recorded (sampled out). The recorder keeps reading the screen for
 * such a visitor — consent is still required — but into a ring in memory
 * instead of a transport: a fresh Meta and full snapshot every 10 seconds
 * starts a segment, and segments older than the window are dropped whole, so
 * what is kept always opens with a complete screen. Nothing leaves the device
 * unless the app crashes; then the ring goes to ingest as a new session whose
 * meta says `kind: 'crash_clip'`.
 *
 * React Native's fatal handler is followed by the process being torn down, so
 * an upload started there rarely finishes. What would be lost — the clip, or
 * the unsent tail of a normal recording with the fatal error in it — is
 * written to the app's store before the app's own handler runs, and sent on
 * the next launch. The store's interface is asynchronous: the write is
 * *started* before the handler chains on, which is as early as JavaScript can
 * start it, but whether the native side finishes it before the process dies
 * depends on the storage library. A store that offers `setItemSync` (MMKV, for
 * one) is written synchronously and does not have that limitation.
 */
import type { KeyValueStore } from './session.js';
import { MAX_EVENT_BYTES, TARGET_CHUNK_BYTES, isTreeEvent, utf8Length } from './transport.js';
import type { ChunkFlags, RecordedEvent, SessionMeta } from './wire.js';

/** A fresh full snapshot this often starts a new segment of the ring. */
export const CLIP_SEGMENT_MS = 10_000;
/** How far back a clip reaches: segments back to the one that starts at or before now − this. */
export const CLIP_WINDOW_MS = 30_000;
/** What the ring may hold, in serialised bytes. */
export const CLIP_MAX_BYTES = 2 * 1024 * 1024;
/** How long the recorder keeps going after the crash, for the aftermath, when the process survives. */
export const CLIP_AFTERMATH_MS = 2_000;
/** At most one clip per visitor in this long. */
export const CLIP_COOLDOWN_MS = 5 * 60_000;
/** How long the remote switch is believed before it is asked again. */
export const CONFIG_TTL_MS = 10 * 60_000;
/**
 * The most a normal recording's unsent tail may weigh when written to the
 * store. AsyncStorage on Android refuses rows near 2 MB; above this only the
 * events that stand on their own (the error among them) are kept.
 */
export const MAX_PERSISTED_TAIL_BYTES = 1536 * 1024;

interface Sized { event: RecordedEvent; bytes: number }
interface Segment { startedAt: number; items: Sized[]; bytes: number; overflowed: boolean }

const sizeOf = (event: RecordedEvent): number => {
  try { return utf8Length(JSON.stringify(event)); } catch { return -1; }
};

/**
 * The rolling buffer behind a crash clip.
 *
 * Kept in segments, each opened by the recorder with a Meta and a full
 * snapshot, so dropping the oldest segment never leaves a mutation pointing
 * at a tree the reader does not have.
 */
export class ClipRing {
  private segments: Segment[] = [];
  private total = 0;

  constructor(private readonly limits: { windowMs: number; maxBytes: number; segmentMs: number } = {
    windowMs: CLIP_WINDOW_MS, maxBytes: CLIP_MAX_BYTES, segmentMs: CLIP_SEGMENT_MS,
  }) {}

  /** True when the recorder should open a new segment (send a whole screen) now. */
  needsSegment(now: number): boolean {
    const last = this.segments[this.segments.length - 1];
    return !last || now - last.startedAt >= this.limits.segmentMs;
  }

  startSegment(now: number): void {
    this.segments.push({ startedAt: now, items: [], bytes: 0, overflowed: false });
    this.trim(now);
  }

  push(event: RecordedEvent): void {
    const last = this.segments[this.segments.length - 1];
    // Nothing to attach it to: a mutation before the first snapshot means nothing.
    if (!last) return;
    const bytes = sizeOf(event);
    if (bytes < 0 || bytes > MAX_EVENT_BYTES) return;
    if (isTreeEvent(event)) {
      // One segment alone over the cap: what it would add to the tree cannot
      // be kept, and a later diff would point at what was not, so the tree
      // waits for the next segment. Taps and errors still go in.
      if (last.overflowed) return;
      if (this.segments.length === 1 && this.total + bytes > this.limits.maxBytes) {
        last.overflowed = true;
        return;
      }
    }
    last.items.push({ event, bytes });
    last.bytes += bytes;
    this.total += bytes;
    this.trim(event.timestamp);
  }

  private trim(now: number): void {
    // Keep the newest segment that starts at or before now − window, and
    // everything after it: that is what reaches back the whole window.
    while (this.segments.length > 1 && this.segments[1]!.startedAt <= now - this.limits.windowMs) {
      this.total -= this.segments.shift()!.bytes;
    }
    while (this.segments.length > 1 && this.total > this.limits.maxBytes) {
      this.total -= this.segments.shift()!.bytes;
    }
  }

  get bytes(): number { return this.total; }
  get segmentCount(): number { return this.segments.length; }
  events(): RecordedEvent[] { return this.segments.flatMap((s) => s.items.map((i) => i.event)); }
  clear(): void { this.segments = []; this.total = 0; }
}

/** Splits events into chunk-sized groups, oldest first; an event no chunk could carry is left out. */
export function splitChunks(events: RecordedEvent[], maxEvents: number, maxBytes = TARGET_CHUNK_BYTES): RecordedEvent[][] {
  const out: RecordedEvent[][] = [];
  let current: RecordedEvent[] = [];
  let bytes = 0;
  for (const event of events) {
    const size = sizeOf(event);
    if (size < 0 || size > MAX_EVENT_BYTES) continue;
    if (current.length > 0 && (current.length >= maxEvents || bytes + size + 1 > maxBytes)) {
      out.push(current);
      current = [];
      bytes = 0;
    }
    current.push(event);
    bytes += size + 1;
  }
  if (current.length > 0) out.push(current);
  return out;
}

/**
 * The unsent tail of a recording, small enough to write to a store. Over the
 * limit, the tree events go and the moments that stand on their own stay —
 * the fatal error among them, which is what marks the session as crashed.
 */
export function boundTail(events: RecordedEvent[], maxBytes = MAX_PERSISTED_TAIL_BYTES): RecordedEvent[] {
  const total = events.reduce((sum, e) => sum + Math.max(0, sizeOf(e)), 0);
  if (total <= maxBytes) return events;
  return events.filter((e) => !isTreeEvent(e));
}

/** Chunks waiting to be sent for one session, as written to the store. */
export interface PendingUpload {
  sessionId: string;
  visitorId: string;
  appId?: string;
  chunks: { seq: number; events: RecordedEvent[]; meta?: SessionMeta; flags?: ChunkFlags }[];
}

export function parsePending(raw: string | null | undefined): PendingUpload | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as PendingUpload;
    if (!value || typeof value.sessionId !== 'string' || typeof value.visitorId !== 'string'
      || !Array.isArray(value.chunks) || value.chunks.length === 0) return null;
    for (const chunk of value.chunks) {
      if (!Number.isInteger(chunk.seq) || chunk.seq < 0 || !Array.isArray(chunk.events)) return null;
    }
    return value;
  } catch {
    return null;
  }
}

/** A crash clip as chunks of a new session: `kind: 'crash_clip'`, starting at its first kept event. */
export function clipUpload(
  events: RecordedEvent[],
  ids: { sessionId: string; visitorId: string; appId?: string },
  meta: SessionMeta,
  maxEvents: number,
): PendingUpload | null {
  const groups = splitChunks(events, maxEvents);
  if (groups.length === 0) return null;
  const startedAt = groups[0]![0]!.timestamp;
  return {
    ...ids,
    chunks: groups.map((group, seq) => ({
      seq,
      events: group,
      ...(seq === 0 ? { meta: { ...meta, startedAt, kind: 'crash_clip' as const } } : {}),
      flags: { hasError: true },
    })),
  };
}

/**
 * Sends stored chunks, oldest first. `done` when every chunk was accepted or
 * refused for good (a 4xx: retrying cannot change it); `retry` when the
 * network or the server failed and the chunks should be kept for later. A
 * chunk sent twice is answered as a duplicate and costs nothing.
 */
export async function uploadPending(
  fetchImpl: typeof fetch,
  target: { ingestUrl: string; projectKey: string; now: () => number },
  upload: PendingUpload,
): Promise<'done' | 'retry'> {
  for (const chunk of upload.chunks) {
    let status: number;
    try {
      const response = await fetchImpl(`${target.ingestUrl}/v1/ingest/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectKey: target.projectKey,
          sessionId: upload.sessionId,
          visitorId: upload.visitorId,
          seq: chunk.seq,
          events: chunk.events,
          ...(upload.appId ? { appId: upload.appId } : {}),
          ...(chunk.meta ? { meta: chunk.meta } : {}),
          ...(chunk.flags && Object.keys(chunk.flags).length > 0 ? { flags: chunk.flags } : {}),
          sentAt: target.now(),
        }),
      });
      status = response.status;
      if (response.ok) continue;
    } catch {
      return 'retry';
    }
    if (status === 429 || status === 408 || status >= 500) return 'retry';
    return 'done';
  }
  return 'done';
}

/**
 * Writes to the store as early as it can be written: synchronously when the
 * store offers it, otherwise by starting the asynchronous write now.
 */
export function persistNow(store: KeyValueStore, key: string, value: string): void {
  try {
    if (store.setItemSync) {
      store.setItemSync(key, value);
      return;
    }
    void store.setItem(key, value).catch(() => {});
  } catch { /* the crash must still reach the app's own handler */ }
}

export async function removeKey(store: KeyValueStore, key: string): Promise<void> {
  if (store.removeItem) await store.removeItem(key);
  else if ((await store.getItem(key)) !== null) await store.setItem(key, '');
}

/** The project's switches as ingest last told them, with when it did. */
export interface RemoteConfig { at: number; crashClip: boolean; maskAllInputs?: boolean }

/**
 * Whether the project wants crash clips, from `GET /v1/ingest/config`.
 *
 * Asked at most every ten minutes; the answer is kept in the store so a
 * launch inside that time asks nothing. When ingest cannot be reached an
 * older answer is used, and with none at all the answer is no.
 */
export async function remoteCrashClip(
  store: KeyValueStore,
  fetchImpl: typeof fetch,
  target: { ingestUrl: string; projectKey: string; appId?: string },
  key: string,
  now: number,
): Promise<boolean> {
  let cached: RemoteConfig | null = null;
  try {
    const raw = await store.getItem(key);
    if (raw) cached = JSON.parse(raw) as RemoteConfig;
  } catch { cached = null; }
  if (cached && typeof cached.at === 'number' && now - cached.at >= 0 && now - cached.at < CONFIG_TTL_MS) {
    return cached.crashClip === true;
  }
  try {
    const query = `projectKey=${encodeURIComponent(target.projectKey)}`
      + (target.appId ? `&appId=${encodeURIComponent(target.appId)}` : '');
    const response = await fetchImpl(`${target.ingestUrl}/v1/ingest/config?${query}`, { method: 'GET' });
    if (!response.ok) return cached?.crashClip === true;
    const reply = await response.json() as { crashClip?: unknown; maskAllInputs?: unknown };
    const fresh: RemoteConfig = {
      at: now,
      crashClip: reply.crashClip === true,
      ...(typeof reply.maskAllInputs === 'boolean' ? { maskAllInputs: reply.maskAllInputs } : {}),
    };
    void store.setItem(key, JSON.stringify(fresh)).catch(() => {});
    return fresh.crashClip;
  } catch {
    return cached?.crashClip === true;
  }
}
