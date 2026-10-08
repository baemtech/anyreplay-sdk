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
  /**
   * @deprecated Ignored since 0.2. Failed deliveries no longer stop the
   * recording: an outage, a 5xx or a 429 is retried with a growing wait (2 s
   * up to a minute, and at least what `Retry-After` asks), the buffer is
   * bounded by `maxBufferedEvents`, and only a refusal — a 4xx such as 402 or
   * 403 — stops it. Stopping after five failures in a row ended a phone's
   * recording after about 25 seconds in a tunnel, which is the case the
   * buffer exists for. Still accepted, so an app that sets it keeps compiling.
   */
  maxConsecutiveFailures?: number;
  maxBufferedEvents?: number;
  /** Where the visitor and session ids live. Defaults to memory. */
  storage?: KeyValueStore;
  /**
   * Record uncaught errors, with their stacks, through
   * `ErrorUtils.setGlobalHandler`.
   *
   * On by default, as in the browser SDK. React Native tells its global
   * handler whether the error is fatal, so a crash and a handled mistake are
   * recorded as different things. The app's own handler — the red screen, a
   * crash reporter — is always called afterwards and is never replaced.
   *
   * A rejection nobody handled is not recorded automatically: React Native
   * has no `unhandledrejection` event and its Promise polyfill exposes no
   * hook. An app with its own rejection tracker can report one with
   * `trackError(reason)`.
   */
  recordErrors?: boolean;
  /**
   * Record `console.error` and `console.warn` calls.
   *
   * On by default. A console line is whatever the app chose to print, so
   * addresses, long tokens and card-shaped numbers are taken out of every one
   * — but an app that logs data about the person using it should turn this
   * off. `log`, `info` and `debug` are never recorded at any setting.
   */
  recordConsole?: boolean;
  /**
   * The app's bundle id (iOS) or package name (Android), e.g.
   * `com.example.shop`.
   *
   * An app has no web origin, so once the project lists allowed domains
   * ingest refuses it unless this id is on the project's allowed apps. Use
   * the same value on both platforms if they share one, or list both. Sent
   * in the body of every request, and stored on the session.
   *
   * A filter, not a secret: anyone holding the public key can send any id.
   * It keeps a key copied into the wrong app out of the project; quotas and
   * rate limits are what protect it from anyone determined.
   */
  appId?: string;
  /**
   * The app's own version as people see it (`CFBundleShortVersionString` /
   * `versionName`, e.g. from `expo-application`), shown with each session.
   * React Native cannot read it without a native module, so it is passed in.
   */
  appVersion?: string;
  debug?: boolean;
}

export interface ResolvedOptions extends Required<Omit<AnyReplayNativeOptions, 'storage' | 'appId' | 'appVersion'>> {
  storage?: KeyValueStore;
  appId?: string;
  appVersion?: string;
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
  // On, because "why did it break" is the question a replay is opened to
  // answer; what each stream can and cannot contain is in events.ts.
  recordErrors: true,
  recordConsole: true,
  debug: false,
};

export class ConfigError extends Error {}

const KEY_PATTERN = /^ar_pk_(live|test)_[0-9a-f]{24}$/;
/** What ingest reads as an app id (`APP_ID_PATTERN` in the server's shared package). */
const APP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,254}$/;

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

  const appId = input.appId?.trim();
  if (input.appId !== undefined && !(appId && APP_ID_PATTERN.test(appId))) {
    throw new ConfigError('anyreplay: appId should be the bundle id or package name, such as com.example.app');
  }
  const appVersion = input.appVersion?.trim();
  if (input.appVersion !== undefined && !(appVersion && appVersion.length <= 40)) {
    throw new ConfigError('anyreplay: appVersion should be the app’s version, at most 40 characters');
  }

  return {
    ...DEFAULTS,
    ...input,
    ...(appId ? { appId } : {}),
    ...(appVersion ? { appVersion } : {}),
    projectKey: input.projectKey,
    sampleRate,
    snapshotIntervalMs,
    ingestUrl: (input.ingestUrl ?? DEFAULTS.ingestUrl).replace(/\/+$/, ''),
    // Off by default, so only an explicit `true` turns either on: a string from
    // a configuration file is ignored rather than guessed at, and ignoring it
    // means recording — which is the default the documentation describes.
    maskAllInputs: input.maskAllInputs === true,
    maskAllTyping: input.maskAllTyping === true,
    // The other way round: these default to recording, so only an explicit
    // `false` switches one off. A string switches nothing off, which is the
    // same rule — a value that is not a boolean leaves the documented default.
    recordErrors: input.recordErrors !== false,
    recordConsole: input.recordConsole !== false,
  };
}
