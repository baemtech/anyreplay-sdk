/**
 * Custom events on a phone: the moments an app tags, and the errors it throws.
 *
 * Both travel as rrweb Custom events inside the mobile stream, which is why
 * `EVENT.custom` exists in `wire.ts` with rrweb's own number: ingest, the
 * player's timeline and the insights detectors all read these tags already,
 * from web recordings. An app's `track('checkout_started')` and a page's are
 * the same row in the same table by the time anyone looks at them.
 *
 * The tags and the validation rules are duplicated rather than imported,
 * because this package ships to an app bundle with no dependencies — the same
 * reason `apps/ingest/src/custom-events.ts` and
 * `packages/insights/src/rrweb.ts` each carry their own copy. A test in this
 * package pins them against the web recorder's, so a change in one that is not
 * made in the other fails rather than silently dropping events.
 */

/** Contract with `packages/recorder/src/events.ts` and `diagnostics.ts`. */
export const TRACK_TAG = 'anyreplay.track';
export const NAVIGATE_TAG = 'anyreplay.navigate';
export const ERROR_TAG = 'anyreplay.error';
export const CONSOLE_TAG = 'anyreplay.console';

export const EVENT_NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
export const MAX_PROPERTIES_BYTES = 4 * 1024;

/** Per-session ceilings, as in the browser: a render loop must not fill a recording. */
export const LIMITS = { error: 100, console: 200 } as const;

const MAX_MESSAGE = 1000;
const MAX_STACK = 4000;

export interface TrackPayload {
  name: string;
  properties: Record<string, unknown>;
}

/**
 * Checks what the app passed to `track()`, returning the payload to send or
 * the reason it was refused. Never throws: this runs inside the app's own
 * press handler, and a recorder that throws there breaks the button.
 */
export function validateTrack(name: unknown, properties: unknown): TrackPayload | string {
  if (typeof name !== 'string' || !EVENT_NAME_PATTERN.test(name)) {
    return `event name must be 1-64 characters of [A-Za-z0-9_.:-], got ${JSON.stringify(name)}`;
  }
  if (properties === undefined || properties === null) return { name, properties: {} };
  if (typeof properties !== 'object' || Array.isArray(properties)) {
    return `properties for "${name}" must be a plain object`;
  }
  let serialised: string;
  try {
    serialised = JSON.stringify(properties);
  } catch {
    return `properties for "${name}" are not JSON-serialisable`;
  }
  if (serialised === undefined || byteLength(serialised) > MAX_PROPERTIES_BYTES) {
    return `properties for "${name}" exceed ${MAX_PROPERTIES_BYTES} bytes once serialised`;
  }
  // The parsed copy, so a getter or a class instance never reaches the wire
  // and a later mutation cannot change what was tracked.
  return { name, properties: JSON.parse(serialised) as Record<string, unknown> };
}

function byteLength(text: string): number {
  return typeof TextEncoder === 'function' ? new TextEncoder().encode(text).length : text.length * 3;
}

/* --------------------------------------------------------- redaction -- */

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const OPAQUE = /\b(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{24,}\b/g;
const DIGITS = /\b[0-9][0-9 -]{11,22}[0-9]\b/g;

export const REDACTED = '[redacted]';

/** Luhn, as in `masking.ts` — kept here so redaction does not import the field logic. */
function cardShaped(text: string): boolean {
  const digits = text.replace(/[ -]/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = digits.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Takes out of free text the three things that turn up in it by accident: an
 * address, a token, a card number. The browser SDK's `redactText`, to the
 * letter — an error message is the same kind of string on either platform.
 */
export function redactText(text: string): string {
  return text
    .replace(EMAIL, REDACTED)
    .replace(DIGITS, (match) => (cardShaped(match.trim()) ? REDACTED : match))
    .replace(OPAQUE, REDACTED);
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);

export interface ErrorPayload {
  /** Read by the insights timeline. Redacted and clipped. */
  message: string;
  name?: string;
  stack?: string;
  /**
   * How it reached us.
   *
   * `fatal` is React Native's own word: its global handler is told whether the
   * JavaScript engine is about to tear the app down, which is the difference
   * between a crash and a handled mistake, and the only place that fact exists.
   */
  kind: 'error' | 'fatal' | 'rejection';
}

export interface ConsolePayload {
  level: 'error' | 'warn';
  message: string;
}

function describe(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? Object.prototype.toString.call(value) : json;
  } catch {
    return Object.prototype.toString.call(value);
  }
}

export function errorPayload(kind: ErrorPayload['kind'], value: unknown): ErrorPayload {
  const error = value instanceof Error ? value : null;
  const message = error ? `${error.name}: ${error.message}` : describe(value);
  const payload: ErrorPayload = { message: clip(redactText(message) || 'error', MAX_MESSAGE), kind };
  if (error) {
    payload.name = error.name;
    if (typeof error.stack === 'string' && error.stack.length > 0) {
      payload.stack = clip(redactText(error.stack), MAX_STACK);
    }
  }
  return payload;
}

export function consolePayload(level: ConsolePayload['level'], args: readonly unknown[]): ConsolePayload {
  return { level, message: clip(redactText(args.map(describe).join(' ')), MAX_MESSAGE) };
}

/* ------------------------------------------------------ global hooks -- */

/** React Native's global error hook, as much of it as this needs. */
export interface ErrorUtilsLike {
  getGlobalHandler?: () => ((error: unknown, isFatal?: boolean) => void) | undefined;
  setGlobalHandler?: (handler: (error: unknown, isFatal?: boolean) => void) => void;
}

export interface DiagnosticsOptions {
  errors: boolean;
  console: boolean;
  emit: (tag: string, payload: unknown) => void;
  onError: () => void;
  /** `global.ErrorUtils` in an app; a fake in a test. */
  errorUtils?: ErrorUtilsLike;
  /** `global.console` by default. */
  consoleLike?: Partial<Record<'error' | 'warn', (...args: unknown[]) => void>>;
}

export interface DiagnosticsHandle {
  /**
   * Reports a rejection nobody handled.
   *
   * React Native has no `unhandledrejection` event, and the tracking its
   * Promise polyfill does is not exposed as a hook — so an app that wants
   * these recorded calls this from its own rejection tracker. The browser
   * SDK needs no equivalent because the browser fires the event itself.
   */
  rejection: (reason: unknown) => void;
  stop: () => void;
}

/**
 * Installs the global error handler and the console patches, and gives back
 * the one function that undoes both.
 *
 * `ErrorUtils.setGlobalHandler` is how React Native lets anything see an
 * uncaught error, and it holds exactly one handler — so the previous one is
 * captured and always called, including when this code throws, because that
 * handler is what shows the app's red screen or reports its crash. Losing it
 * would be a worse bug than recording nothing.
 */
export function startDiagnostics(options: DiagnosticsOptions): DiagnosticsHandle {
  const undo: (() => void)[] = [];
  const counts = { error: 0, console: 0 };
  let flagged = false;

  const budget = (stream: keyof typeof counts): boolean => {
    if (counts[stream] >= LIMITS[stream]) return false;
    counts[stream] += 1;
    return true;
  };
  const flag = (): void => {
    if (flagged) return;
    flagged = true;
    try {
      options.onError();
    } catch { /* never the app's problem */ }
  };
  const send = (tag: string, payload: unknown): void => {
    try {
      options.emit(tag, payload);
    } catch { /* as above */ }
  };

  const errorUtils = options.errorUtils
    ?? (globalThis as { ErrorUtils?: ErrorUtilsLike }).ErrorUtils;

  if (options.errors && errorUtils?.setGlobalHandler) {
    const previous = errorUtils.getGlobalHandler?.();
    errorUtils.setGlobalHandler((error, isFatal) => {
      try {
        flag();
        if (budget('error')) send(ERROR_TAG, errorPayload(isFatal ? 'fatal' : 'error', error));
      } catch { /* fall through to the app's own handler regardless */ }
      previous?.(error, isFatal);
    });
    undo.push(() => {
      // Only if nothing else has taken the handler since: putting ours back
      // over a newer one would silence whoever installed it.
      if (errorUtils.getGlobalHandler?.() !== undefined && previous) errorUtils.setGlobalHandler?.(previous);
    });
  }

  const target = options.consoleLike ?? (typeof console !== 'undefined' ? console : undefined);
  if (options.console && target) {
    for (const level of ['error', 'warn'] as const) {
      const original = target[level];
      if (typeof original !== 'function') continue;
      target[level] = function patched(this: unknown, ...args: unknown[]): void {
        try {
          const first = args[0];
          const own = typeof first === 'string' && first.startsWith('[anyreplay]');
          if (!own && budget('console')) send(CONSOLE_TAG, consolePayload(level, args));
        } catch { /* fall through to the real console */ }
        original.apply(this, args);
      };
      undo.push(() => { target[level] = original; });
    }
  }

  let stopped = false;
  return {
    rejection: (reason) => {
      if (stopped || !options.errors) return;
      flag();
      if (budget('error')) send(ERROR_TAG, errorPayload('rejection', reason));
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      for (let i = undo.length - 1; i >= 0; i -= 1) {
        try {
          undo[i]!();
        } catch { /* put back as much as can be put back */ }
      }
    },
  };
}
