import { describe, expect, it, vi } from 'vitest';
import {
  CONSOLE_TAG, ERROR_TAG, EVENT_NAME_PATTERN, LIMITS, MAX_PROPERTIES_BYTES, REDACTED, TRACK_TAG,
  consolePayload, errorPayload, redactText, startDiagnostics, validateTrack,
  type ErrorUtilsLike,
} from '../src/events.js';
import { createRecorder, type Host } from '../src/recorder.js';
import { MemoryStore } from '../src/session.js';
import type { CapturedElement } from '../src/tree.js';
import { EVENT } from '../src/wire.js';

const KEY = 'ar_pk_live_0123456789abcdef01234567';

function fakeHost(overrides: Partial<Host> = {}) {
  let clock = 1_700_000_000_000;
  const timers: (() => void)[] = [];
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  let elements = new Map<number, CapturedElement>();

  const host: Host = {
    now: () => clock,
    screen: () => ({ width: 390, height: 844 }),
    platform: () => ({ os: 'ios', version: '17.4', model: 'iPhone15,2' }),
    locale: () => 'tr-TR',
    snapshot: () => (elements.size > 0 ? { elements, rootId: 2 } : null),
    setInterval: (fn) => { timers.push(fn); return timers.length - 1; },
    clearInterval: () => {},
    fetch: (async (url: string, init: { body: string }) => {
      posts.push({ url: String(url), body: JSON.parse(init.body) });
      return { ok: true, status: 202 } as Response;
    }) as unknown as typeof fetch,
    ...overrides,
  };

  return {
    host,
    posts,
    setScreen: (...items: CapturedElement[]) => { elements = new Map(items.map((i) => [i.id, i])); },
    tickFlush: () => timers[1]?.(),
    custom: () => posts
      .flatMap((p) => (p.body.events as { type: number; data?: { tag?: string; payload?: unknown } }[]) ?? [])
      .filter((e) => e.type === EVENT.custom)
      .map((e) => e.data!),
    flags: () => posts.map((p) => p.body.flags as Record<string, unknown> | undefined),
  };
}

const el = (over: Partial<CapturedElement> & { id: number }): CapturedElement => ({
  tag: 'View', rect: { x: 0, y: 0, width: 200, height: 40 }, children: [], ...over,
});

/** A stand-in for React Native's single global error hook. */
function fakeErrorUtils(): ErrorUtilsLike & { fire: (error: unknown, isFatal?: boolean) => void; installed: () => number } {
  let handler: ((error: unknown, isFatal?: boolean) => void) | undefined;
  let installs = 0;
  return {
    getGlobalHandler: () => handler,
    setGlobalHandler: (next) => { handler = next; installs += 1; },
    fire: (error, isFatal) => handler?.(error, isFatal),
    installed: () => installs,
  };
}

describe('the track contract', () => {
  /*
   * These constants are duplicated in packages/recorder/src/events.ts, in
   * apps/ingest/src/custom-events.ts and in packages/insights/src/rrweb.ts,
   * because none of those four may depend on another. The duplication is only
   * safe while it is identical, so the values are pinned here literally.
   */
  it('matches the browser recorder and ingest, literally', () => {
    expect(TRACK_TAG).toBe('anyreplay.track');
    expect(ERROR_TAG).toBe('anyreplay.error');
    expect(CONSOLE_TAG).toBe('anyreplay.console');
    expect(EVENT_NAME_PATTERN.source).toBe('^[A-Za-z0-9_.:-]{1,64}$');
    expect(MAX_PROPERTIES_BYTES).toBe(4096);
    // rrweb's own number for a Custom event; ingest filters on it.
    expect(EVENT.custom).toBe(5);
  });

  it('accepts what the browser SDK accepts and refuses what ingest would', () => {
    for (const name of ['x', 'checkout_started', 'cart.item:added', 'a'.repeat(64)]) {
      expect(validateTrack(name, undefined), name).toEqual({ name, properties: {} });
    }
    for (const name of ['', 'has space', 'a'.repeat(65), '$navigate', 42, null]) {
      expect(typeof validateTrack(name, undefined), String(name)).toBe('string');
    }
  });

  it('copies the properties, so a later mutation cannot change what was tracked', () => {
    const properties: Record<string, unknown> = { a: 1, fn: () => 1 };
    const result = validateTrack('x', properties);
    expect(result).toEqual({ name: 'x', properties: { a: 1 } });
    properties.a = 2;
    expect((result as unknown as { properties: { a: number } }).properties.a).toBe(1);
  });
});

describe('redaction and payloads', () => {
  it('takes addresses, card numbers and long tokens out of a message', () => {
    expect(redactText('login failed for a@b.com')).toBe(`login failed for ${REDACTED}`);
    expect(redactText('card 4242 4242 4242 4242')).toBe(`card ${REDACTED}`);
    expect(redactText('TypeError: undefined is not an object')).toBe('TypeError: undefined is not an object');
  });

  it('names the fields the insights timeline reads, and keeps fatal apart from handled', () => {
    const fatal = errorPayload('fatal', new TypeError('boom'));
    expect(fatal).toMatchObject({ message: 'TypeError: boom', name: 'TypeError', kind: 'fatal' });
    expect(errorPayload('error', 'a string').kind).toBe('error');
    expect(errorPayload('rejection', { code: 1 }).message).toBe('{"code":1}');
  });

  it('joins console arguments', () => {
    expect(consolePayload('warn', ['a', 1, null])).toEqual({ level: 'warn', message: 'a 1 null' });
  });
});

describe('startDiagnostics on a phone', () => {
  it('records an uncaught error and always calls the handler it replaced', () => {
    const sent: { tag: string; payload: unknown }[] = [];
    const errorUtils = fakeErrorUtils();
    const theirs: unknown[] = [];
    errorUtils.setGlobalHandler!((error) => { theirs.push(error); });

    const handle = startDiagnostics({
      errors: true,
      console: false,
      emit: (tag, payload) => { sent.push({ tag, payload }); },
      onError: () => {},
      errorUtils,
    });

    const boom = new Error('boom');
    errorUtils.fire(boom, true);

    expect(sent).toEqual([{ tag: ERROR_TAG, payload: expect.objectContaining({ kind: 'fatal' }) }]);
    // The app's red screen still happens.
    expect(theirs).toEqual([boom]);
    handle.stop();
  });

  it('flags the session once and stops recording at the per-session cap', () => {
    const sent: unknown[] = [];
    let flags = 0;
    const errorUtils = fakeErrorUtils();
    const handle = startDiagnostics({
      errors: true, console: false, errorUtils,
      emit: (_tag, payload) => { sent.push(payload); },
      onError: () => { flags += 1; },
    });
    for (let i = 0; i < LIMITS.error + 5; i += 1) errorUtils.fire(new Error(`e${i}`));
    expect(sent).toHaveLength(LIMITS.error);
    expect(flags).toBe(1);
    handle.stop();
  });

  it('records a rejection only when asked, since React Native fires no event for one', () => {
    const sent: { tag: string; payload: unknown }[] = [];
    const handle = startDiagnostics({
      errors: true, console: false, errorUtils: fakeErrorUtils(),
      emit: (tag, payload) => { sent.push({ tag, payload }); },
      onError: () => {},
    });
    handle.rejection(new Error('nobody caught me'));
    expect(sent).toEqual([{ tag: ERROR_TAG, payload: expect.objectContaining({ kind: 'rejection' }) }]);
    handle.stop();
    // After stopping it is inert, so a late rejection cannot reopen a recording.
    handle.rejection(new Error('too late'));
    expect(sent).toHaveLength(1);
  });

  it('patches console, passes the call through, and puts back what it found', () => {
    const sent: { tag: string; payload: unknown }[] = [];
    const printed: unknown[][] = [];
    const theirs = (...args: unknown[]): void => { printed.push(args); };
    const consoleLike = { error: theirs, warn: theirs };

    const handle = startDiagnostics({
      errors: false, console: true, consoleLike,
      emit: (tag, payload) => { sent.push({ tag, payload }); },
      onError: () => {},
    });
    consoleLike.error('broke', 2);
    consoleLike.warn('[anyreplay] not this one');

    expect(sent).toEqual([{ tag: CONSOLE_TAG, payload: { level: 'error', message: 'broke 2' } }]);
    expect(printed).toEqual([['broke', 2], ['[anyreplay] not this one']]);

    handle.stop();
    expect(consoleLike.error).toBe(theirs);
  });

  it('does not take the global handler slot when errors are off', () => {
    const errorUtils = fakeErrorUtils();
    const handle = startDiagnostics({
      errors: false, console: false, errorUtils, emit: () => {}, onError: () => {},
    });
    expect(errorUtils.installed()).toBe(0);
    handle.stop();
  });
});

describe('the recorder', () => {
  it('sends a tracked moment as a Custom event in the stream', async () => {
    const f = fakeHost();
    f.setScreen(el({ id: 2, tag: 'Text', text: 'Merhaba' }));
    const recorder = await createRecorder({ projectKey: KEY, storage: new MemoryStore() }, f.host);

    recorder.track('checkout_started', { step: 2 });
    f.tickFlush();

    expect(f.custom()).toEqual([
      { tag: TRACK_TAG, payload: { name: 'checkout_started', properties: { step: 2 } } },
    ]);
  });

  it('drops a malformed name rather than sending something ingest would refuse', async () => {
    const f = fakeHost();
    f.setScreen(el({ id: 2, tag: 'Text', text: 'Merhaba' }));
    const recorder = await createRecorder({ projectKey: KEY, storage: new MemoryStore() }, f.host);

    recorder.track('not a name');
    recorder.track('$navigate');
    f.tickFlush();

    expect(f.custom()).toEqual([]);
  });

  it('holds what was tracked before consent and sends it once consent is given', async () => {
    const f = fakeHost();
    f.setScreen(el({ id: 2, tag: 'Text', text: 'Merhaba' }));
    const recorder = await createRecorder(
      { projectKey: KEY, storage: new MemoryStore(), requireConsent: true }, f.host,
    );

    recorder.track('boot');
    f.tickFlush();
    // Nothing has been sent at all: no consent, no request.
    expect(f.posts).toHaveLength(0);

    recorder.consent(true);
    // Consent reads the store before it records, so the switch is asynchronous.
    await vi.waitFor(() => expect(recorder.status()).toBe('recording'));
    f.tickFlush();

    expect(f.custom()).toEqual([{ tag: TRACK_TAG, payload: { name: 'boot', properties: {} } }]);
  });

  it('records an error the app caught, and flags the session', async () => {
    const f = fakeHost();
    f.setScreen(el({ id: 2, tag: 'Text', text: 'Merhaba' }));
    const recorder = await createRecorder({ projectKey: KEY, storage: new MemoryStore() }, f.host);

    recorder.trackError(new RangeError('out of range'));
    f.tickFlush();

    expect(f.custom()).toEqual([
      { tag: ERROR_TAG, payload: expect.objectContaining({ message: 'RangeError: out of range' }) },
    ]);
    expect(f.flags().some((flags) => flags?.hasError === true)).toBe(true);
  });

  it('records nothing from trackError when recordErrors is off', async () => {
    const f = fakeHost();
    f.setScreen(el({ id: 2, tag: 'Text', text: 'Merhaba' }));
    const recorder = await createRecorder(
      { projectKey: KEY, storage: new MemoryStore(), recordErrors: false }, f.host,
    );

    recorder.trackError(new Error('ignored'));
    f.tickFlush();

    expect(f.custom()).toEqual([]);
  });
});
