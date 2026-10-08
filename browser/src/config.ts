import { defaultAssetMode, type AssetMode } from './assets.js';

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
  /**
   * Stop recording after this many failed deliveries in a row (offline, a
   * timeout, `429`, `5xx`). `0`, the default, never stops: failed chunks are
   * kept (up to ten chunks' worth of events, oldest dropped first) and
   * retried with a backoff of 2 s doubling to a minute, and at once when the
   * browser comes back online or the tab becomes visible.
   */
  maxConsecutiveFailures?: number;
  /**
   * Record uncaught exceptions and unhandled rejections, with their stacks.
   *
   * On by default: a replay of a page that broke is worth far more with the
   * error beside it, and an exception is the page's own diagnostic rather than
   * anything a visitor typed. The message, the error name and the stack are
   * recorded; secrets, addresses and card-shaped numbers are taken out of all
   * three first (see `diagnostics.ts`).
   */
  recordErrors?: boolean;
  /**
   * Record `console.error` and `console.warn` calls.
   *
   * On by default, and the one stream here with no predictable contents: a
   * console line is whatever the page chose to print, which on some sites
   * includes data about the person using it. The same redaction runs over
   * every line, but a page that prints something it would not want a
   * teammate to read should turn this off. `log`, `info` and `debug` are
   * never recorded at any setting.
   */
  recordConsole?: boolean;
  /**
   * Record one entry per `fetch`/`XMLHttpRequest`: method, URL, status code
   * and duration.
   *
   * On by default. **No request or response body is ever recorded**, and no
   * headers — not a sampled copy, not a truncated one. The URL is redacted
   * before it is kept. Requests to the ingest endpoint are skipped.
   */
  recordNetwork?: boolean;
  /**
   * The most sessions this project may record per calendar month (UTC).
   *
   * Sent with the first chunk of every new session; ingest refuses a session
   * that would exceed it with 402 `session_cap_reached` and the recorder stops
   * for that visit. A cap set in the dashboard also applies, and the lower one
   * wins. Positive integer, at most 1,000,000.
   */
  maxSessionsPerMonth?: number;
  /**
   * The app this page runs inside, when it runs inside one: the bundle id or
   * package name of a Capacitor, Cordova or Electron app
   * (`com.example.shop`).
   *
   * Leave it out on a website. An app's web view has no real web origin —
   * `capacitor://localhost`, `https://localhost`, `file://` — so a project
   * that lists allowed domains refuses it; listing the same id under the
   * project's allowed apps, and passing it here, lets it record. Sent in
   * every request body, never as a header: a header would cost a CORS
   * preflight per request, and `sendBeacon` cannot send one.
   *
   * A filter, not a secret. Ingest ignores it on a request from a real
   * website, so it cannot open a web project's allow-list, and anyone holding
   * the public key can send any id from outside a browser.
   */
  appId?: string;
  /**
   * Whether the recording refers to the page's images and fonts by URL, or
   * carries them.
   *
   * `'reference'` records URLs, and the replay loads each file from where the
   * page did: right for a website, whose files anyone can load later.
   * `'inline'` is for a page whose files nobody else can load — an app's web
   * view (`capacitor://localhost`, `https://localhost`, `file://`) or a
   * desktop shell. Images the app ships are uploaded once per project by
   * content hash (PNG, JPEG, GIF, WebP, up to 3 MB each), and its fonts and
   * SVGs travel inside the recording (up to 160 KB per font, 48 KB per SVG and
   * 1 MB per page), so the replay looks like the app instead of bare HTML.
   * Stylesheets are copied into the recording in both modes.
   *
   * Leave it out and it is `'inline'` when the page is served from anything
   * other than `http:`/`https:`, or from `localhost`, `127.0.0.1`, `[::1]` or a
   * `*.localhost` host; `'reference'` everywhere else. Only files under the
   * page's own origin (for `file:`, its own folder) are ever read, and never
   * the device-file bridges Capacitor and Cordova serve user files through.
   * See `assets.ts`.
   */
  assets?: AssetMode;
  debug?: boolean;
}

export interface ResolvedOptions extends Required<Omit<AnyReplayOptions, 'ingestUrl' | 'maxSessionsPerMonth' | 'appId' | 'assets'>> {
  /** Always decided: the page's choice, or what `defaultAssetMode` reads from its address. */
  assets: AssetMode;
  ingestUrl: string;
  maxSessionsPerMonth?: number;
  appId?: string;
}

export const DEFAULTS: Omit<ResolvedOptions, 'projectKey' | 'assets'> = {
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
  // Never: an outage is what the buffer is for. Set a number to give up instead.
  maxConsecutiveFailures: 0,
  // The three diagnostic streams. On, because "why did it break" is the
  // question a replay is opened to answer; each is a documented switch, and
  // what they can and cannot contain is in diagnostics.ts.
  recordErrors: true,
  recordConsole: true,
  recordNetwork: true,
  debug: false,
};

export class ConfigError extends Error {}

const KEY_PATTERN = /^ar_pk_(live|test)_[0-9a-f]{24}$/;
/** Matches what ingest's schema accepts, so a value that passes here is never a 422 later. */
const MAX_SESSION_CAP = 1_000_000;
/** What ingest reads as an app id (`APP_ID_PATTERN` in the server's shared package). */
const APP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,254}$/;

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

  const appId = input.appId?.trim();
  if (input.appId !== undefined && !(appId && APP_ID_PATTERN.test(appId))) {
    throw new ConfigError('anyreplay: appId should be an app identifier such as com.example.app');
  }

  let assets = input.assets;
  if (assets !== undefined && assets !== 'reference' && assets !== 'inline') {
    if (typeof console !== 'undefined') {
      console.warn(`[anyreplay] assets ignored: expected 'reference' or 'inline', got ${JSON.stringify(assets)}.`);
    }
    assets = undefined;
  }

  return {
    ...DEFAULTS,
    ...input,
    ...(appId ? { appId } : {}),
    assets: assets ?? defaultAssetMode(),
    projectKey: input.projectKey,
    sampleRate,
    ingestUrl: (input.ingestUrl ?? DEFAULTS.ingestUrl).replace(/\/+$/, ''),
    maskAllInputs: readSwitch(input, 'maskAllInputs'),
    maskAllTyping: readSwitch(input, 'maskAllTyping'),
    recordErrors: readSwitch(input, 'recordErrors'),
    recordConsole: readSwitch(input, 'recordConsole'),
    recordNetwork: readSwitch(input, 'recordNetwork'),
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
type Switch = 'maskAllInputs' | 'maskAllTyping' | 'recordErrors' | 'recordConsole' | 'recordNetwork';

function readSwitch(input: AnyReplayOptions, name: Switch): boolean {
  const value = input[name];
  if (typeof value === 'boolean') return value;
  if (value !== undefined && typeof console !== 'undefined') {
    // The masking switches default to recording and the diagnostic ones to
    // capturing, so in both directions a value that was meant to restrict
    // something and did not has to be said out loud.
    const consequence = name.startsWith('mask')
      ? 'Nothing is masked by this option.'
      : `${name.slice('record'.length)} are recorded, as by default.`;
    console.warn(`[anyreplay] ${name} ignored: expected true or false, got ${typeof value}. ${consequence}`);
  }
  return DEFAULTS[name];
}
