export interface AnyReplayOptions {
  /** Public project key from the dashboard. */
  projectKey: string;
  /** Ingest endpoint. Override only for self-hosted deployments. */
  ingestUrl?: string;
  /** Fraction of visitors recorded, 0–1. Decided once per visitor, not per page. */
  sampleRate?: number;
  /** Mask every text input. Leaving this on is the supported configuration. */
  maskAllInputs?: boolean;
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
  // Default-deny. Recording a customer's password field once is a breach; the
  // cost of the safe default is a configuration line for the rare field that
  // genuinely needs to be visible.
  maskAllInputs: true,
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
    // A caller who explicitly passes false gets what they asked for; anything
    // else (including undefined) keeps masking on.
    maskAllInputs: input.maskAllInputs === false ? false : true,
  };
}
