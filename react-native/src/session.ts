/**
 * Who is being recorded, and for how long.
 *
 * Identical rules to the web recorder — a visitor id that outlives the session,
 * a session that ends after half an hour of quiet — so a person who uses both
 * the site and the app produces two recordings a reviewer can reason about the
 * same way.
 *
 * Storage is injected rather than imported. React Native has no
 * `localStorage`, the community has settled on at least three async
 * replacements, and a recorder that hard-codes one of them is a recorder that
 * cannot be installed in half the apps that want it.
 */

/** A new session starts after this much inactivity. */
export const SESSION_IDLE_MS = 30 * 60 * 1000;

const VISITOR_KEY = 'anyreplay.vid';
const SESSION_KEY = 'anyreplay.sid';
const SESSION_TS_KEY = 'anyreplay.sts';
/** The next chunk number the current session may use. */
const SEQ_KEY = 'anyreplay.seq';

export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  /** Optional, because the first release only asked for get and set. AsyncStorage has it. */
  removeItem?(key: string): Promise<void>;
}

/**
 * The fallback when the host app has no storage to lend.
 *
 * Everything is forgotten when the process dies, which means a returning user
 * looks like a new one. That is a worse recording, not a broken one, and it is
 * strictly better than refusing to record at all.
 */
export class MemoryStore implements KeyValueStore {
  private readonly values = new Map<string, string>();
  async getItem(key: string): Promise<string | null> { return this.values.get(key) ?? null; }
  async setItem(key: string, value: string): Promise<void> { this.values.set(key, value); }
  async removeItem(key: string): Promise<void> { this.values.delete(key); }
}

function randomHex(bytes: number): string {
  let out = '';
  for (let i = 0; i < bytes; i += 1) {
    out += Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * A v4 UUID, which is what ingest requires for a session id.
 *
 * `Math.random` rather than a crypto source on purpose: Hermes has no
 * `crypto.getRandomValues` without a polyfill, and this value is an opaque
 * identifier, not a secret. Nothing is authorised by knowing it — the project
 * key and the origin allow-list do that work.
 */
export function uuidv4(): string {
  const hex = randomHex(16).split('');
  hex[12] = '4';
  hex[16] = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const s = hex.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

export interface Identity {
  visitorId: string;
  sessionId: string;
  /** True when this call started a new session rather than resuming one. */
  fresh: boolean;
  /** The chunk number to continue from: 0 for a new session, later for a resumed one. */
  nextSeq: number;
}

export async function resolveIdentity(
  store: KeyValueStore,
  now: number = Date.now(),
): Promise<Identity> {
  let visitorId = await store.getItem(VISITOR_KEY);
  if (!visitorId || !/^v[0-9a-f]{24}$/.test(visitorId)) {
    visitorId = `v${randomHex(12)}`;
    await store.setItem(VISITOR_KEY, visitorId);
  }

  const sessionId = await store.getItem(SESSION_KEY);
  const lastSeen = Number(await store.getItem(SESSION_TS_KEY) ?? 0);
  const stillOpen = sessionId && lastSeen > 0 && now - lastSeen < SESSION_IDLE_MS;

  if (stillOpen) {
    await store.setItem(SESSION_TS_KEY, String(now));
    // A relaunch inside the idle window resumes the session, and must resume
    // its chunk numbering too: ingest treats a repeated (session, seq) as a
    // retry and discards it, so starting again at 0 silently loses everything
    // recorded after the relaunch.
    const storedSeq = Number(await store.getItem(SEQ_KEY));
    const nextSeq = Number.isInteger(storedSeq) && storedSeq > 0 ? storedSeq : 0;
    return { visitorId, sessionId, fresh: false, nextSeq };
  }

  const next = uuidv4();
  await store.setItem(SESSION_KEY, next);
  await store.setItem(SESSION_TS_KEY, String(now));
  await store.setItem(SEQ_KEY, '0');
  return { visitorId, sessionId: next, fresh: true, nextSeq: 0 };
}

/** Records that chunk numbers below `next` are taken, before the request that uses one leaves. */
export async function reserveSeq(store: KeyValueStore, next: number): Promise<void> {
  await store.setItem(SEQ_KEY, String(next));
}

export async function touchSession(store: KeyValueStore, now: number = Date.now()): Promise<void> {
  await store.setItem(SESSION_TS_KEY, String(now));
}

/**
 * Removes everything the recorder has stored on this device.
 *
 * Called when consent is refused. A refusal undoes an earlier acceptance, not
 * merely this launch: the visitor id written last month is exactly what the
 * person is now saying no to. A store without `removeItem` has each key
 * emptied instead — and only a key that exists, so that a refusal made before
 * anything was stored still stores nothing.
 */
export async function forgetVisitor(store: KeyValueStore): Promise<void> {
  for (const key of [VISITOR_KEY, SESSION_KEY, SESSION_TS_KEY, SEQ_KEY]) {
    if (store.removeItem) await store.removeItem(key);
    else if ((await store.getItem(key)) !== null) await store.setItem(key, '');
  }
}

/**
 * Whether this visitor is in the sample.
 *
 * Decided from the visitor id rather than a coin flip, so the answer is stable:
 * a visitor who is recorded stays recorded across screens and launches, which
 * is what makes a sampled recording worth watching at all.
 */
export function isSampledIn(visitorId: string, rate: number): boolean {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  let hash = 0;
  for (let i = 0; i < visitorId.length; i += 1) {
    hash = (hash * 31 + visitorId.charCodeAt(i)) >>> 0;
  }
  return (hash % 10_000) / 10_000 < rate;
}
