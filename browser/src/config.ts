export interface AnyReplayOptions {
  /** Public project key from the dashboard. */
  projectKey: string;
  /** Ingest endpoint. Override only for self-hosted deployments. */
  ingestUrl?: string;
  /** Fraction of visitors recorded, 0–1. Decided once per visitor, not per page. */
  sampleRate?: number;
  /**
   * Mask the value of every form control.
   *
   * Off by default: a recording shows what a visitor typed into inputs,
   * textareas and rich-text editors, because a replay of a form nobody could
   * finish is worth watching only if you can see what they were trying to put
   * in it. Turn this on for a site whose forms carry anything you would not
   * want a teammate to read, and mark individual fields with the `maskClass`
   * when it is only some of them.
   *
   * Some fields are masked whatever this says, in every mode: passwords,
   * one-time codes, payment fields (card number, CVV, expiry, IBAN, routing
   * number, sort code), anything inside an element with the mask class, and any
   * value that looks like a card number. Email and telephone fields are not on
   * that list — they are ordinary fields, recorded by default and masked by this
   * option. See `isSensitiveField` in `masking.ts` for the exact list.
   */
  maskAllInputs?: boolean;
  /**
   * Mask everything a person types, wherever they type it.
   *
   * `maskAllInputs` covers form controls. This covers those *and* the other
   * place a person can type — an element with `contenteditable`, which is what
   * a rich-text editor, a comment box or a chat composer is made of. Their text
   * is not an input value but ordinary page text, so input masking does not
   * reach it. With this on, the text of every editable region is replaced with
   * asterisks in the first snapshot and in every change after it.
   *
   * The stricter of the two options, and a superset of it: `maskAllTyping: true`
   * masks form fields too, whatever `maskAllInputs` says. It is separate
   * because masking an editable region masks *all* of its text, including
   * whatever the page put there before anyone typed — a loaded document, a
   * quoted message — which is a bigger thing to ask for than hiding field
   * values.
   */
  maskAllTyping?: boolean;
  /** Elements with this class have their text masked. */
  maskClass?: string;
  /** Elements with this class are not recorded at all. */
  blockClass?: string;
  /** Wait for `anyreplay('consent', true)` before recording anything. */
  requireConsent?: boolean;
  /** Flush when the buffer reaches this many events. */
  maxEventsPerChunk?: number;
  /** Flush at least this often, in milliseconds. */
  flushIntervalMs?: number;
  /** Recording stops after this many consecutive transport failures. */
  maxConsecutiveFailures?: number;
  /**
   * The most sessions this project may record per calendar month (UTC).
   *
   * Sent with the first chunk of every new session; ingest refuses a session
   * that would exceed it with 402 `session_cap_reached` and the recorder stops
   * for that visit. A cap set in the dashboard also applies, and the lower one
   * wins. Positive integer, at most 1,000,000.
   */
  maxSessionsPerMonth?: number;
  debug?: boolean;
}

export interface ResolvedOptions extends Required<Omit<AnyReplayOptions, 'ingestUrl' | 'maxSessionsPerMonth'>> {
  ingestUrl: string;
  maxSessionsPerMonth?: number;
}

export const DEFAULTS: Omit<ResolvedOptions, 'projectKey'> = {
  ingestUrl: 'https://in.anyreplay.com',
  sampleRate: 1,
  // Both masking switches are opt-in: a recording shows what people typed,
  // which is the point of watching one. What that never includes is the floor
  // in masking.ts — passwords, payment fields and the rest — which no option
  // can switch off.
  maskAllInputs: false,
  maskAllTyping: false,
  maskClass: 'ar-mask',
  blockClass: 'ar-block',
  requireConsent: false,
  maxEventsPerChunk: 200,
  flushIntervalMs: 5000,
  maxConsecutiveFailures: 5,
  debug: false,
};

export class ConfigError extends Error {}

const KEY_PATTERN = /^ar_pk_(live|test)_[0-9a-f]{24}$/;
/** Matches what ingest's schema accepts, so a value that passes here is never a 422 later. */
const MAX_SESSION_CAP = 1_000_000;

export function resolveOptions(input: AnyReplayOptions): ResolvedOptions {
  if (!input || typeof input !== 'object') throw new ConfigError('anyreplay: options object required');
  if (!KEY_PATTERN.test(input.projectKey ?? '')) {
    throw new ConfigError('anyreplay: projectKey looks wrong — copy it from the dashboard');
  }

  const sampleRate = input.sampleRate ?? DEFAULTS.sampleRate;
  if (!(sampleRate >= 0 && sampleRate <= 1)) {
    throw new ConfigError('anyreplay: sampleRate must be between 0 and 1');
  }

  const cap = input.maxSessionsPerMonth;
  if (cap !== undefined && !(Number.isInteger(cap) && cap >= 1 && cap <= MAX_SESSION_CAP)) {
    throw new ConfigError(`anyreplay: maxSessionsPerMonth must be a whole number between 1 and ${MAX_SESSION_CAP}`);
  }

  return {
    ...DEFAULTS,
    ...input,
    projectKey: input.projectKey,
    sampleRate,
    ingestUrl: (input.ingestUrl ?? DEFAULTS.ingestUrl).replace(/\/+$/, ''),
    maskAllInputs: readSwitch(input, 'maskAllInputs'),
    maskAllTyping: readSwitch(input, 'maskAllTyping'),
  };
}

/**
 * Reads one masking switch, and says so out loud when it cannot.
 *
 * Only a real `true` turns masking on: a string, a number or a typo is ignored
 * rather than guessed at. Ignoring it now means recording, which is the one
 * place in this file where being quiet would be the wrong thing — a tag
 * manager that hands over the string `"true"` would leave a customer believing
 * their forms were masked. So the warning is not behind `debug`: whoever wrote
 * the line needs to see it, and they are not the person who set `debug`.
 */
function readSwitch(input: AnyReplayOptions, name: 'maskAllInputs' | 'maskAllTyping'): boolean {
  const value = input[name];
  if (typeof value === 'boolean') return value;
  if (value !== undefined && typeof console !== 'undefined') {
    console.warn(`[anyreplay] ${name} ignored: expected true or false, got ${typeof value}. Nothing is masked by this option.`);
  }
  return DEFAULTS[name];
}
