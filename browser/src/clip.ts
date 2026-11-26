import type { RecordedEvent } from './transport.js';

/**
 * Crash clips (contract §8.6): the last half-minute of a visitor who is not
 * being recorded, kept in memory and sent only when something breaks.
 *
 * A sampled-out visitor is not recorded, and a project that samples does so to
 * record less — so nothing here leaves the page unless the page hits an
 * uncaught error or the app reports a fatal one. Until then the clip is a ring
 * of segments in memory. rrweb takes a fresh full snapshot every
 * `CLIP_CHECKOUT_MS`, and each snapshot (rrweb's Meta + FullSnapshot) starts a
 * segment a replay can begin from; old segments are dropped once a newer one
 * already covers the window. A clip therefore always starts on a snapshot and
 * runs 30–40 seconds.
 */

/** How far back a clip reaches. */
export const CLIP_WINDOW_MS = 30_000;
/** How often clip mode takes a full snapshot (rrweb's `checkoutEveryNms`). */
export const CLIP_CHECKOUT_MS = 10_000;
/**
 * The most a clip keeps, measured as serialised characters — close enough to
 * bytes for a cap whose job is to keep memory in check on a page that
 * mutates its DOM all the time.
 */
export const CLIP_MAX_BYTES = 2 * 1024 * 1024;
/** How long recording goes on after the crash, so the clip shows what followed. */
export const CLIP_AFTERMATH_MS = 2_000;
/** At most one clip per visitor this often, across pages and tabs. */
export const CLIP_COOLDOWN_MS = 5 * 60_000;
/** How long the project's answer is kept before asking again. */
export const CLIP_CONFIG_TTL_MS = 10 * 60_000;

/** `localStorage`: when this visitor's last clip was cut (epoch ms). */
export const CLIP_SENT_KEY = 'anyreplay.clipAt';
/** `localStorage`: the project's answer from `/v1/ingest/config`, with when it was read. */
export const CONFIG_KEY = 'anyreplay.cfg';

/** rrweb's `EventType.Meta`: the first event of every snapshot. */
const EVENT_META = 4;
const EVENT_FULL_SNAPSHOT = 2;

interface Segment {
  events: RecordedEvent[];
  /** Serialised size, in characters. */
  bytes: number;
}

/**
 * The ring. `push` every event rrweb emits; `take` what a clip would send.
 *
 * Trimming is by segment, never inside one: dropping events from the middle
 * of a segment would leave DOM changes that describe nodes the replay never
 * saw. The newest segment always stays, however large — it holds the moment
 * of the crash. When it alone outgrows the cap, `onOversize` asks for an
 * early snapshot so the older part can go.
 */
export class ClipBuffer {
  private segments: Segment[] = [];
  private bytes = 0;
  private oversizeAsked = false;

  constructor(
    private readonly limits: { windowMs: number; maxBytes: number } = { windowMs: CLIP_WINDOW_MS, maxBytes: CLIP_MAX_BYTES },
    private readonly onOversize?: () => void,
  ) {}

  /** Events held, oldest first. */
  get size(): number {
    return this.segments.reduce((n, s) => n + s.events.length, 0);
  }

  get byteSize(): number {
    return this.bytes;
  }

  push(event: RecordedEvent, now: number = event.timestamp): void {
    if (event.type === EVENT_META) {
      this.segments.push({ events: [], bytes: 0 });
      this.oversizeAsked = false;
    }
    const current = this.segments[this.segments.length - 1];
    // Nothing a replay could start from yet: an event before the first snapshot.
    if (!current) return;
    let size = 0;
    try {
      size = JSON.stringify(event).length;
    } catch {
      return;
    }
    current.events.push(event);
    current.bytes += size;
    this.bytes += size;
    this.trim(now);
  }

  /**
   * Drops the segments a newer one already covers: everything before the
   * newest segment that starts at or before `now − window`. Then, while over
   * the byte cap, the oldest — never the newest.
   */
  trim(now: number): void {
    const edge = now - this.limits.windowMs;
    let keepFrom = 0;
    for (let i = this.segments.length - 1; i >= 0; i -= 1) {
      const first = this.segments[i]!.events[0];
      if (first && first.timestamp <= edge) { keepFrom = i; break; }
    }
    if (keepFrom > 0) this.drop(keepFrom);
    while (this.bytes > this.limits.maxBytes && this.segments.length > 1) this.drop(1);
    if (this.bytes > this.limits.maxBytes && !this.oversizeAsked) {
      this.oversizeAsked = true;
      try { this.onOversize?.(); } catch { /* never into the page */ }
    }
  }

  /**
   * Everything kept, oldest first, starting on a full snapshot — or nothing,
   * when no snapshot has been kept yet. Empties the ring.
   */
  take(): RecordedEvent[] {
    const events = this.events();
    this.clear();
    return events;
  }

  /** What `take` would return, leaving the ring as it is. */
  events(): RecordedEvent[] {
    const events = this.segments.flatMap((s) => s.events);
    return events.some((e) => e.type === EVENT_FULL_SNAPSHOT) ? events : [];
  }

  clear(): void {
    this.segments = [];
    this.bytes = 0;
  }

  private drop(count: number): void {
    for (const segment of this.segments.splice(0, count)) this.bytes -= segment.bytes;
  }
}

interface KeyValue {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** True when this visitor had a clip cut less than five minutes ago. */
export function clipInCooldown(local: KeyValue, now: number = Date.now()): boolean {
  const at = Number(local.get(CLIP_SENT_KEY));
  return Number.isFinite(at) && at > 0 && now - at < CLIP_COOLDOWN_MS && at <= now;
}

export function noteClipSent(local: KeyValue, now: number = Date.now()): void {
  local.set(CLIP_SENT_KEY, String(now));
}

/** What the project says, from `GET /v1/ingest/config` (contract §6.2, §8.6). */
export interface ProjectConfig {
  crashClip: boolean;
  maskAllInputs: boolean;
}

interface CachedConfig extends ProjectConfig {
  /** Which project (and app) it is the answer for. */
  k: string;
  /** When it was read (epoch ms). */
  t: number;
}

/**
 * The project's crash clip switch and masking choice: from `localStorage`
 * when read less than ten minutes ago, otherwise from ingest. Undefined when
 * neither has an answer — then there is no clip, and typed text stays masked.
 * Never throws, never rejects.
 */
export async function loadProjectConfig(
  options: { ingestUrl: string; projectKey: string; appId?: string },
  local: KeyValue,
  now: number = Date.now(),
): Promise<ProjectConfig | undefined> {
  const key = `${options.projectKey}|${options.appId ?? ''}`;
  try {
    const cached = JSON.parse(local.get(CONFIG_KEY) ?? 'null') as CachedConfig | null;
    if (cached && cached.k === key && now - cached.t >= 0 && now - cached.t < CLIP_CONFIG_TTL_MS
      && typeof cached.crashClip === 'boolean' && typeof cached.maskAllInputs === 'boolean') {
      return { crashClip: cached.crashClip, maskAllInputs: cached.maskAllInputs };
    }
  } catch { /* unreadable: ask again */ }

  try {
    const query = `projectKey=${encodeURIComponent(options.projectKey)}${options.appId ? `&appId=${encodeURIComponent(options.appId)}` : ''}`;
    const response = await fetch(`${options.ingestUrl}/v1/ingest/config?${query}`, { credentials: 'omit' });
    if (!response.ok) {
      // A verdict (a refused origin or app, a bad key, a rate limit) holds as
      // long as an answer would: kept as "no clips, masked", so every page of
      // a refused site does not ask again. A server error or no network is
      // not kept.
      if (response.status >= 400 && response.status < 500) {
        local.set(CONFIG_KEY, JSON.stringify({ crashClip: false, maskAllInputs: true, k: key, t: now } satisfies CachedConfig));
      }
      return undefined;
    }
    const body = await response.json() as Partial<ProjectConfig> | null;
    if (typeof body?.crashClip !== 'boolean') return undefined;
    // An answer without the masking field is read as masked: fail closed.
    const config: ProjectConfig = { crashClip: body.crashClip, maskAllInputs: body.maskAllInputs !== false };
    local.set(CONFIG_KEY, JSON.stringify({ ...config, k: key, t: now } satisfies CachedConfig));
    return config;
  } catch {
    return undefined;
  }
}
