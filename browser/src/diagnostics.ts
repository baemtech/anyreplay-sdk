/**
 * What a developer opens a replay to find out: what broke.
 *
 * Three streams, each a reserved custom-event tag inside the rrweb stream so
 * they carry the recording's own clock and replay in order with the clicks
 * that caused them:
 *
 * - `anyreplay.error`   — uncaught exceptions and unhandled rejections.
 * - `anyreplay.console` — `console.error` and `console.warn` calls.
 * - `anyreplay.network` — one entry per fetch/XHR, metadata only.
 *
 * `anyreplay.error` and `anyreplay.network` are a contract that already has a
 * reader: `packages/insights/src/rrweb.ts` has been looking for those tags,
 * and the `js_error`, `error_click` and `network_error` detectors have been
 * waiting for them. The payload field names here are the ones that file reads
 * (`message`; `url`, `status`, `method`) — renaming one silently empties three
 * signals, so they are pinned by a test in both packages.
 *
 * ## What never leaves the page
 *
 * No request or response bodies, no request headers, no cookies. A URL is
 * recorded, so a URL is redacted first: a query value whose key names a
 * secret, anything shaped like an email address, a long opaque token and
 * anything that passes the card-number check are replaced before the entry is
 * built. The same redaction runs over console messages, which are arbitrary
 * strings a page chose to print and so the least predictable thing here.
 *
 * ## Why the caps are low
 *
 * A page in a render loop can print thousands of warnings a second, and a
 * dashboard polling four endpoints makes a request a second for an hour. The
 * value of all of it is in the first few of each kind near the moment
 * something went wrong, so each stream has a per-session ceiling and drops
 * quietly once it is reached. Nothing here grows without bound, and nothing
 * here throws: every entry point is wrapped, because this code runs inside
 * the page's own `fetch` and its own `console`.
 */

import { looksLikeCardNumber } from './masking.js';

/** Contract with `packages/insights/src/rrweb.ts` and `apps/ingest/src/custom-events.ts`. */
export const ERROR_TAG = 'anyreplay.error';
export const CONSOLE_TAG = 'anyreplay.console';
export const NETWORK_TAG = 'anyreplay.network';

/**
 * Per-session ceilings.
 *
 * Errors are the point of the feature and the rarest, so they get the most
 * room relative to how often they happen; network is the chattiest and so is
 * capped hardest per unit of value.
 */
export const LIMITS = { error: 100, console: 200, network: 500 } as const;

/** An error message or console line longer than this is a stack trace in disguise. */
const MAX_MESSAGE = 1000;
/** Stacks are what makes an error actionable, but only the top of one is. */
const MAX_STACK = 4000;
/** A URL this long is carrying data, not addressing a resource. */
const MAX_URL = 500;

/** Query keys whose value is a secret whatever it looks like. */
const SECRET_KEY = /^(?:.*[_-])?(?:token|secret|password|passwd|pwd|key|apikey|api_key|auth|authorization|session|sid|jwt|code|otp|signature|sig|credential|access|refresh)(?:[_-].*)?$/i;
/** An email address anywhere in a string. */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/**
 * A long opaque run of token-ish characters: a JWT, a signed id, a bearer
 * token pasted into a path. Needs both length and a digit so that ordinary
 * words, slugs and hashes of English text are left alone.
 */
const OPAQUE = /\b(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{24,}\b/g;
/** Digit runs that pass the card check, wherever they appear. */
const DIGITS = /\b[0-9][0-9 -]{11,22}[0-9]\b/g;

export const REDACTED = '[redacted]';

/**
 * Removes from free text the three things that turn up in it by accident:
 * an address, a token, a card number.
 *
 * Deliberately blunt. This is applied to strings a page printed or a URL it
 * requested, where there is no structure to reason about and the cost of a
 * false positive — a redacted order id — is far below the cost of a miss.
 */
export function redactText(text: string): string {
  return text
    .replace(EMAIL, REDACTED)
    .replace(DIGITS, (match) => (looksLikeCardNumber(match.trim()) ? REDACTED : match))
    .replace(OPAQUE, REDACTED);
}

/**
 * A URL with its secrets taken out, kept absolute so the host is still visible.
 *
 * Query values are replaced by key first — `?token=abc` is a secret even when
 * `abc` is three letters — and then the whole thing goes through the free-text
 * redaction, which catches an address or a token sitting in the path. The hash
 * is dropped: it never reaches a server, and on a hash-routed app it is the
 * one part most likely to hold an id.
 */
export function redactUrl(raw: string): string {
  const text = raw.length > MAX_URL ? raw.slice(0, MAX_URL) : raw;
  let parsed: URL;
  try {
    parsed = new URL(text, typeof location !== 'undefined' ? location.href : 'http://localhost');
  } catch {
    return redactText(text);
  }
  for (const key of [...parsed.searchParams.keys()]) {
    if (SECRET_KEY.test(key)) parsed.searchParams.set(key, REDACTED);
  }
  parsed.hash = '';
  // `origin + path + search` rather than `href`, so a password in the
  // authority (`https://user:pw@host`) is dropped rather than redacted.
  return redactText(`${parsed.origin}${parsed.pathname}${parsed.search}`);
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);

export interface ErrorPayload {
  /** Read by the insights timeline. Redacted and clipped. */
  message: string;
  /** `Error`, `TypeError`, … when the thrown value was an Error. */
  name?: string;
  /** Redacted and clipped; absent when the thrown value carried none. */
  stack?: string;
  /** How it reached us, which is how severe it is: a rejection nobody handled is not a thrown error. */
  kind: 'error' | 'rejection';
  /** Where it was thrown, when the browser said. Already a redacted URL. */
  source?: string;
  line?: number;
  column?: number;
}

export interface ConsolePayload {
  level: 'error' | 'warn';
  /** The arguments, joined and redacted. */
  message: string;
}

export interface NetworkPayload {
  /** Read by the insights timeline. A redacted absolute URL. */
  url: string;
  /** Read by the insights timeline. Upper case. */
  method: string;
  /** Read by the insights timeline. 0 when the request never got a response. */
  status: number;
  /** Wall-clock milliseconds from call to settled, rounded. */
  durationMs: number;
  /** Which API the page used, which is all the panel needs to group them. */
  initiator: 'fetch' | 'xhr';
  /** Present and true when the request failed outright (network error, CORS, abort). */
  failed?: boolean;
}

/** What the page prints, flattened. Objects are described, never serialised deeply. */
function describe(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    const json = JSON.stringify(value);
    // `undefined`, a function, a symbol: JSON has nothing to say about them.
    return json === undefined ? Object.prototype.toString.call(value) : json;
  } catch {
    // Circular, or a getter that throws. The shape is still worth knowing.
    return Object.prototype.toString.call(value);
  }
}

/** The thrown value, described however it arrived — pages throw strings. */
export function errorPayload(
  kind: ErrorPayload['kind'],
  value: unknown,
  where?: { source?: unknown; line?: unknown; column?: unknown },
): ErrorPayload {
  const error = value instanceof Error ? value : null;
  const message = error ? `${error.name}: ${error.message}` : describe(value);
  const payload: ErrorPayload = { message: clip(redactText(message) || 'error', MAX_MESSAGE), kind };
  if (error) {
    payload.name = error.name;
    if (typeof error.stack === 'string' && error.stack.length > 0) {
      payload.stack = clip(redactText(error.stack), MAX_STACK);
    }
  }
  if (typeof where?.source === 'string' && where.source.length > 0) payload.source = redactUrl(where.source);
  if (typeof where?.line === 'number' && Number.isFinite(where.line)) payload.line = where.line;
  if (typeof where?.column === 'number' && Number.isFinite(where.column)) payload.column = where.column;
  return payload;
}

export function consolePayload(level: ConsolePayload['level'], args: readonly unknown[]): ConsolePayload {
  const joined = args.map(describe).join(' ');
  return { level, message: clip(redactText(joined), MAX_MESSAGE) };
}

/** The method, as a short upper-case word; anything stranger is not a method. */
function methodOf(value: unknown): string {
  const text = typeof value === 'string' ? value.toUpperCase() : 'GET';
  return /^[A-Z]{3,10}$/.test(text) ? text : 'GET';
}

export interface DiagnosticsOptions {
  /** Emit uncaught errors and unhandled rejections. */
  errors: boolean;
  /** Emit `console.error` and `console.warn`. */
  console: boolean;
  /** Emit one entry per fetch/XHR. */
  network: boolean;
  /** Where entries go. Called with a reserved tag and a payload. */
  emit: (tag: string, payload: unknown) => void;
  /** Called the first time an error or a failed request is seen, so the session is flagged. */
  onError: () => void;
  /** Ingest's own endpoint, so the recorder never records itself. */
  ingestUrl: string;
}

export interface DiagnosticsHandle {
  /** Puts back every patched global, in reverse order. Safe to call twice. */
  stop: () => void;
}

/**
 * Patches `console`, `window` and the two request APIs, and gives back the
 * single function that undoes all of it.
 *
 * Patching is the only way to see any of this from a library, so the rules
 * are strict: the original is captured once and always called, its return
 * value is always passed through untouched, and everything this adds sits in
 * a `try` so that a bug here cannot break a page's error handling or its
 * network layer. Requests to the ingest endpoint are skipped — recording the
 * recorder is noise that also grows with itself.
 */
export function startDiagnostics(options: DiagnosticsOptions): DiagnosticsHandle {
  const undo: (() => void)[] = [];
  const counts = { error: 0, console: 0, network: 0 };
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
    } catch { /* never the page's problem */ }
  };
  const send = (tag: string, payload: unknown): void => {
    try {
      options.emit(tag, payload);
    } catch { /* as above */ }
  };

  let ingestOrigin: string | null = null;
  try {
    ingestOrigin = new URL(options.ingestUrl).origin;
  } catch { /* a malformed endpoint cannot match anything */ }

  const ours = (url: string): boolean => ingestOrigin !== null && url.startsWith(ingestOrigin);

  if (options.errors && typeof window !== 'undefined') {
    const onError = (event: ErrorEvent): void => {
      flag();
      if (!budget('error')) return;
      send(ERROR_TAG, errorPayload('error', event.error ?? event.message, {
        source: event.filename, line: event.lineno, column: event.colno,
      }));
    };
    const onRejection = (event: PromiseRejectionEvent): void => {
      flag();
      if (!budget('error')) return;
      send(ERROR_TAG, errorPayload('rejection', event.reason));
    };
    // Capture phase, so a page that stops propagation in its own handler does
    // not also stop the recording from seeing the error.
    window.addEventListener('error', onError as EventListener, { capture: true });
    window.addEventListener('unhandledrejection', onRejection as EventListener, { capture: true });
    undo.push(() => {
      window.removeEventListener('error', onError as EventListener, { capture: true });
      window.removeEventListener('unhandledrejection', onRejection as EventListener, { capture: true });
    });
  }

  if (options.console && typeof console !== 'undefined') {
    for (const level of ['error', 'warn'] as const) {
      const original = console[level] as ((...args: unknown[]) => void) | undefined;
      if (typeof original !== 'function') continue;
      const patched = function patchedConsole(this: unknown, ...args: unknown[]): void {
        try {
          // A recorder warning is not the page's diagnostics, and recording it
          // would let one bad event print and record forever.
          const first = args[0];
          const own = typeof first === 'string' && first.startsWith('[anyreplay]');
          if (!own && budget('console')) send(CONSOLE_TAG, consolePayload(level, args));
        } catch { /* fall through to the real console */ }
        original.apply(this, args);
      };
      console[level] = patched as typeof console.error;
      undo.push(() => { console[level] = original as typeof console.error; });
    }
  }

  if (options.network && typeof window !== 'undefined') {
    const originalFetch = window.fetch;
    if (typeof originalFetch === 'function') {
      const patchedFetch = function patchedFetch(
        this: unknown, input: RequestInfo | URL, init?: RequestInit,
      ): Promise<Response> {
        let url = '';
        let method = 'GET';
        try {
          url = typeof input === 'string' ? input
            : input instanceof URL ? input.href
              : (input as Request).url ?? '';
          method = methodOf(init?.method ?? (input as Request | undefined)?.method);
        } catch { /* an exotic input still gets its request made */ }
        const started = Date.now();
        const result = originalFetch.call(window, input as RequestInfo, init);
        if (!url || ours(url)) return result;
        return result.then(
          (response) => {
            try {
              if (budget('network')) {
                if (response.status >= 400) flag();
                send(NETWORK_TAG, {
                  url: redactUrl(url), method, status: response.status,
                  durationMs: Date.now() - started, initiator: 'fetch',
                } satisfies NetworkPayload);
              }
            } catch { /* never change what the page receives */ }
            return response;
          },
          (reason: unknown) => {
            try {
              flag();
              if (budget('network')) {
                send(NETWORK_TAG, {
                  url: redactUrl(url), method, status: 0,
                  durationMs: Date.now() - started, initiator: 'fetch', failed: true,
                } satisfies NetworkPayload);
              }
            } catch { /* as above */ }
            // Rethrow the original reason: the page's catch must see what it
            // would have seen, including the identity of the error object.
            throw reason;
          },
        );
      };
      window.fetch = patchedFetch as typeof window.fetch;
      undo.push(() => { window.fetch = originalFetch; });
    }

    const Xhr = window.XMLHttpRequest;
    if (typeof Xhr === 'function') {
      const open = Xhr.prototype.open;
      const sendMethod = Xhr.prototype.send;
      // The request's own facts, kept off the instance's own property names.
      const seen = new WeakMap<XMLHttpRequest, { url: string; method: string; started: number }>();
      Xhr.prototype.open = function patchedOpen(
        this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]
      ) {
        try {
          const href = typeof url === 'string' ? url : url.href;
          if (href && !ours(href)) seen.set(this, { url: href, method: methodOf(method), started: 0 });
        } catch { /* the request still opens */ }
        return (open as (...args: unknown[]) => void).call(this, method, url, ...rest);
      } as typeof Xhr.prototype.open;
      Xhr.prototype.send = function patchedSend(this: XMLHttpRequest, ...args: unknown[]) {
        try {
          const request = seen.get(this);
          if (request) {
            request.started = Date.now();
            const done = (failed: boolean): void => {
              try {
                if (failed || this.status >= 400) flag();
                if (!budget('network')) return;
                send(NETWORK_TAG, {
                  url: redactUrl(request.url), method: request.method, status: this.status || 0,
                  durationMs: Date.now() - request.started, initiator: 'xhr',
                  ...(failed ? { failed: true } : {}),
                } satisfies NetworkPayload);
              } catch { /* never the page's problem */ }
            };
            this.addEventListener('load', () => done(false));
            this.addEventListener('error', () => done(true));
            this.addEventListener('timeout', () => done(true));
            this.addEventListener('abort', () => done(true));
          }
        } catch { /* as above */ }
        return (sendMethod as (...args: unknown[]) => void).call(this, ...args);
      } as typeof Xhr.prototype.send;
      undo.push(() => {
        Xhr.prototype.open = open;
        Xhr.prototype.send = sendMethod;
      });
    }
  }

  let stopped = false;
  return {
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
