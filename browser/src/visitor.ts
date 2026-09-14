const VISITOR_KEY = 'anyreplay.vid';
const SESSION_KEY = 'anyreplay.sid';
const SESSION_TS_KEY = 'anyreplay.sts';
/** The next chunk number the current session may use. */
const SEQ_KEY = 'anyreplay.seq';
/** Page views so far in the current session, so a reload continues the count. */
const PAGE_KEY = 'anyreplay.pc';
/** Until when (epoch ms) this tab should not try to record, after ingest refused a new session. */
const COOLDOWN_KEY = 'anyreplay.cd';

/**
 * How long a tab waits after a 402 before trying to record again.
 *
 * A quota or cap is a monthly fact; retrying on every page load would put one
 * refused request per navigation on ingest, from every visitor, for the rest
 * of the month. Two minutes is long enough to make that negligible and short
 * enough that an upgrade takes effect while the customer is still watching.
 */
const QUOTA_COOLDOWN_MS = 2 * 60 * 1000;

/** A new session starts after this much inactivity, matching common analytics. */
const SESSION_IDLE_MS = 30 * 60 * 1000;

function randomId(bytes = 16): string {
  const array = new Uint8Array(bytes);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(array);
  } else {
    for (let i = 0; i < bytes; i += 1) array[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(array, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** RFC 4122 v4, formatted. Ingest requires a UUID for the session id. */
export function uuidv4(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const hex = randomId(16).split('');
  hex[12] = '4';
  hex[16] = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const s = hex.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

interface Storage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/**
 * Storage that degrades instead of throwing.
 *
 * `localStorage` throws on access in some privacy modes, and a recorder that
 * throws inside the customer's page is far worse than one that stops recording.
 */
export function safeStorage(source: () => globalThis.Storage | undefined): Storage {
  const read = (): globalThis.Storage | undefined => {
    try { return source(); } catch { return undefined; }
  };
  return {
    get: (key) => { try { return read()?.getItem(key) ?? null; } catch { return null; } },
    set: (key, value) => { try { read()?.setItem(key, value); } catch { /* ignore */ } },
    remove: (key) => { try { read()?.removeItem(key); } catch { /* ignore */ } },
  };
}

export interface Identity {
  visitorId: string;
  sessionId: string;
  isNewSession: boolean;
  /** The chunk number to continue from: 0 for a new session, later for a resumed one. */
  nextSeq: number;
  /** Which page view of the session this is: 1 for a new session, previous + 1 for a resumed one. */
  pageCount: number;
}

/**
 * Resolves who this is and which session they are in.
 *
 * The visitor id persists across visits (it is what sampling is decided on, so
 * a sampled-out visitor stays sampled out rather than flickering). The session
 * id resets after a period of inactivity.
 */
export function resolveIdentity(
  local: Storage,
  session: Storage,
  now: number = Date.now(),
): Identity {
  let visitorId = local.get(VISITOR_KEY);
  if (!visitorId || !/^[A-Za-z0-9_-]{8,64}$/.test(visitorId)) {
    visitorId = `v${randomId(12)}`;
    local.set(VISITOR_KEY, visitorId);
  }

  const previousId = session.get(SESSION_KEY);
  const previousTs = Number(session.get(SESSION_TS_KEY) ?? 0);
  const expired = !previousId || !previousTs || now - previousTs > SESSION_IDLE_MS;

  const sessionId = expired ? uuidv4() : previousId;
  session.set(SESSION_KEY, sessionId);
  session.set(SESSION_TS_KEY, String(now));

  // A resumed session continues its chunk numbering. Starting again at 0 on
  // every page load collides with chunks the server already holds for this
  // session, and ingest drops a repeated (session, seq) as a retry — silently
  // losing everything recorded after the first page.
  const storedSeq = Number(session.get(SEQ_KEY));
  const nextSeq = !expired && Number.isInteger(storedSeq) && storedSeq > 0 ? storedSeq : 0;
  session.set(SEQ_KEY, String(nextSeq));

  // A full navigation is a page view of the same session. Starting the count
  // at 1 on every page would report a ten-page visit as one page.
  const storedPages = Number(session.get(PAGE_KEY));
  const pageCount = !expired && Number.isInteger(storedPages) && storedPages > 0 ? storedPages + 1 : 1;
  session.set(PAGE_KEY, String(pageCount));

  return { visitorId, sessionId, isNewSession: expired, nextSeq, pageCount };
}

/** Records the page count so the next page of the session continues from it. */
export function notePageCount(session: { set(key: string, value: string): void }, count: number): void {
  session.set(PAGE_KEY, String(count));
}

/** True while this tab is still inside the cool-down that followed a 402. */
export function inCooldown(session: Storage, now: number = Date.now()): boolean {
  const until = Number(session.get(COOLDOWN_KEY));
  return Number.isFinite(until) && until > now;
}

export function startCooldown(session: Storage, now: number = Date.now()): void {
  session.set(COOLDOWN_KEY, String(now + QUOTA_COOLDOWN_MS));
}

/** Records that chunk numbers below `next` are taken, before the request that uses one leaves. */
export function reserveSeq(session: { set(key: string, value: string): void }, next: number): void {
  session.set(SEQ_KEY, String(next));
}

export function touchSession(session: Storage, now: number = Date.now()): void {
  session.set(SESSION_TS_KEY, String(now));
}

export { VISITOR_KEY, SESSION_KEY, SESSION_TS_KEY, SEQ_KEY, PAGE_KEY, COOLDOWN_KEY, SESSION_IDLE_MS, QUOTA_COOLDOWN_MS };
