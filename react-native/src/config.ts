import type { KeyValueStore } from './session.js';

export interface AnyReplayNativeOptions {
  /** Public project key from the dashboard. */
  projectKey: string;
  /** Ingest endpoint. Override only for a self-hosted deployment. */
  ingestUrl?: string;
  /** Fraction of visitors recorded, 0–1. Decided once per visitor. */
  sampleRate?: number;
  /**
   * How often the screen is re-read, in milliseconds.
   *
   * The single biggest lever on what a session costs. Every tick diffs the
   * current tree against the last and sends what changed, so a slower tick is
   * a cheaper, coarser recording. Two per second is enough to follow a person
   * through an app; ten would mostly record the same screen ten times.
   */
  snapshotIntervalMs?: number;
  /**
   * Mask the value of every `TextInput`.
   *
   * Off by default, exactly as in the browser SDK: a recording shows what a
   * person typed, because a replay of a checkout nobody could finish is worth
   * watching only if you can see what they were trying to put in it. Turn it on
   * for an app whose screens carry anything you would not want a teammate to
   * read, and mark individual views with `maskTestID` when it is only some of
   * them.
   *
   * Some fields are masked whatever this says, in every mode: `secureTextEntry`
   * ones, and any field whose `textContentType`, `autoComplete`, `keyboardType`,
   * accessibility label, placeholder or `testID` names a password, a one-time
   * code or a payment instrument — plus any value shaped like a card number.
   * See `masking.ts` for the exact list, and the README for the one thing a
   * phone cannot tell us that a browser can.
   */
  maskAllInputs?: boolean;
  /**
   * Mask everything a person types, wherever they type it.
   *
   * The same option as in the browser SDK, and it covers less here because
   * there is less to cover: a React Native screen has no `contenteditable`, so
   * every place a person can type is a `TextInput`. What it adds on mobile is
   * that it cannot be weakened — with this on, `maskAllInputs: false` no longer
   * records field values, which is what makes it safe to set once for an app
   * whose screens are configured in more than one place.
   */
  maskAllTyping?: boolean;
  /** Elements whose `testID` contains this have their text masked. */
  maskTestID?: string;
  /**
   * Record no image URLs at all; images replay as masked boxes.
   *
   * Off by default, as on the web, where a recording keeps the `src` of every
   * image. Turn it on when the pictures themselves are personal — photos
   * people upload — or mark individual views with `maskTestID` instead.
   */
  maskImages?: boolean;
  /** Wait for `consent(true)` before recording anything. */
  requireConsent?: boolean;
  maxEventsPerChunk?: number;
  flushIntervalMs?: number;
  maxConsecutiveFailures?: number;
  maxBufferedEvents?: number;
  /** Where the visitor and session ids live. Defaults to memory. */
  storage?: KeyValueStore;
  debug?: boolean;
}

export interface ResolvedOptions extends Required<Omit<AnyReplayNativeOptions, 'storage'>> {
  storage?: KeyValueStore;
}

export const DEFAULTS: Omit<ResolvedOptions, 'projectKey' | 'storage'> = {
  ingestUrl: 'https://in.anyreplay.com',
  sampleRate: 1,
  snapshotIntervalMs: 500,
  // Both masking switches are opt-in, exactly as on the web: a recording shows
  // what people typed, which is the point of watching one. What it never
  // includes is the floor in masking.ts — secure fields, credentials, one-time
  // codes, payment details — which no option can switch off.
  maskAllInputs: false,
  maskAllTyping: false,
  maskTestID: 'ar-mask',
  maskImages: false,
  requireConsent: false,
  maxEventsPerChunk: 200,
  flushIntervalMs: 5000,
  maxConsecutiveFailures: 5,
  // Roughly a minute of a busy screen. Enough to ride out a tunnel, small
  // enough that an app in a dead zone does not grow until it is killed.
  maxBufferedEvents: 2000,
  debug: false,
};

export class ConfigError extends Error {}

const KEY_PATTERN = /^ar_pk_(live|test)_[0-9a-f]{24}$/;

export function resolveOptions(input: AnyReplayNativeOptions): ResolvedOptions {
  if (!input || typeof input !== 'object') throw new ConfigError('anyreplay: options object required');
  if (!KEY_PATTERN.test(input.projectKey ?? '')) {
    throw new ConfigError('anyreplay: projectKey looks wrong — copy it from the dashboard');
  }

  const sampleRate = input.sampleRate ?? DEFAULTS.sampleRate;
  if (!(sampleRate >= 0 && sampleRate <= 1)) {
    throw new ConfigError('anyreplay: sampleRate must be between 0 and 1');
  }

  const snapshotIntervalMs = input.snapshotIntervalMs ?? DEFAULTS.snapshotIntervalMs;
  // Below about ten a second the recorder is competing with the app for the
  // JavaScript thread, which is the one thing a recorder must never do.
  if (snapshotIntervalMs < 100) {
    throw new ConfigError('anyreplay: snapshotIntervalMs below 100 would compete with the app');
  }

  return {
    ...DEFAULTS,
    ...input,
    projectKey: input.projectKey,
    sampleRate,
    snapshotIntervalMs,
    ingestUrl: (input.ingestUrl ?? DEFAULTS.ingestUrl).replace(/\/+$/, ''),
    // Off by default, so only an explicit `true` turns either on: a string from
    // a configuration file is ignored rather than guessed at, and ignoring it
    // means recording — which is the default the documentation describes.
    maskAllInputs: input.maskAllInputs === true,
    maskAllTyping: input.maskAllTyping === true,
  };
}
