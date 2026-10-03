import {
  CONSOLE_TAG, ERROR_TAG, LIMITS, NETWORK_TAG, REDACTED,
  consolePayload, errorPayload, redactText, redactUrl, startDiagnostics,
  type NetworkPayload,
} from '../src/diagnostics';

/**
 * Dispatches an uncaught error the way the browser would.
 *
 * jsdom reports an un-cancelled `error` event as an uncaught exception, which
 * would fail the run around a test that is deliberately throwing. The recorder
 * must not cancel it — a page's own `onerror` has to keep working — so the
 * cancelling is done here, after the recorder's capturing listener has seen it.
 */
function throwUncaught(init: ErrorEventInit): void {
  const swallow = (event: Event): void => { event.preventDefault(); };
  window.addEventListener('error', swallow);
  try {
    window.dispatchEvent(new ErrorEvent('error', { ...init, cancelable: true }));
  } finally {
    window.removeEventListener('error', swallow);
  }
}

/** A collector shaped like the recorder's `emitCustom`. */
function collector() {
  const sent: { tag: string; payload: Record<string, unknown> }[] = [];
  let errors = 0;
  return {
    sent,
    flagged: () => errors,
    of: (tag: string) => sent.filter((e) => e.tag === tag).map((e) => e.payload),
    options: {
      emit: (tag: string, payload: unknown) => { sent.push({ tag, payload: payload as Record<string, unknown> }); },
      onError: () => { errors += 1; },
      ingestUrl: 'https://in.anyreplay.com',
    },
  };
}

describe('redaction', () => {
  it('takes addresses, card numbers and long tokens out of free text', () => {
    expect(redactText('mail me at a.b+c@example.co.uk now')).toBe(`mail me at ${REDACTED} now`);
    // 4242… passes the card check; the other digit run does not.
    expect(redactText('card 4242 4242 4242 4242 end')).toBe(`card ${REDACTED} end`);
    expect(redactText('order 1234 5678 9012 3456 end')).toContain('1234 5678 9012 3456');
    expect(redactText('bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9')).toBe(`bearer ${REDACTED}`);
  });

  it('leaves ordinary words, slugs and short ids alone', () => {
    for (const text of [
      'TypeError: cannot read property name of undefined',
      'checkout-step-two failed',
      'status 500 after 1200ms',
    ]) {
      expect(redactText(text), text).toBe(text);
    }
  });

  it('redacts a query value by its key, whatever the value looks like', () => {
    expect(redactUrl('https://x.test/a?token=ab&page=2')).toBe(`https://x.test/a?token=${encodeURIComponent(REDACTED)}&page=2`);
    expect(redactUrl('https://x.test/a?api_key=1&SESSION=2&q=shoes'))
      .toBe(`https://x.test/a?api_key=${encodeURIComponent(REDACTED)}&SESSION=${encodeURIComponent(REDACTED)}&q=shoes`);
  });

  it('keeps the host and path, drops the hash and any credentials in the authority', () => {
    expect(redactUrl('https://api.test/v1/orders?page=2#/secret/42')).toBe('https://api.test/v1/orders?page=2');
    expect(redactUrl('https://user:hunter2@api.test/v1')).toBe('https://api.test/v1');
  });

  it('redacts an address or a token sitting in the path, not only in the query', () => {
    expect(redactUrl('https://x.test/users/a@b.com')).toBe(`https://x.test/users/${REDACTED}`);
    expect(redactUrl('https://x.test/s/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9')).toBe(`https://x.test/s/${REDACTED}`);
  });

  it('resolves a relative URL against the page, as fetch does', () => {
    expect(redactUrl('/v1/orders?page=2')).toBe(`${location.origin}/v1/orders?page=2`);
  });

  it('clips a URL far too long to be addressing anything', () => {
    expect(redactUrl(`https://x.test/${'a'.repeat(900)}`).length).toBeLessThan(560);
  });
});

describe('payload shapes', () => {
  /*
   * These field names are read by packages/insights/src/timeline.ts, which
   * turns them into the js_error, error_click and network_error signals. A
   * rename here empties three signals silently, so the names are pinned.
   */
  it('names the fields the insights timeline reads', () => {
    const error = errorPayload('error', new TypeError('boom'));
    expect(error.message).toBe('TypeError: boom');
    expect(error.name).toBe('TypeError');
    expect(error.kind).toBe('error');

    const network: NetworkPayload = {
      url: 'https://x.test/a', method: 'POST', status: 500, durationMs: 12, initiator: 'fetch',
    };
    expect(Object.keys(network)).toEqual(expect.arrayContaining(['url', 'method', 'status']));
  });

  it('describes a thrown value that is not an Error', () => {
    expect(errorPayload('rejection', 'just a string').message).toBe('just a string');
    expect(errorPayload('rejection', { code: 42 }).message).toBe('{"code":42}');
    expect(errorPayload('rejection', undefined).message).toBe('undefined');
    // A getter that throws must not take the recording down with it.
    const hostile = { get boom(): never { throw new Error('no'); } };
    expect(typeof errorPayload('rejection', hostile).message).toBe('string');
  });

  it('carries a stack and the thrower location, both redacted', () => {
    const error = new Error('at a@b.com');
    error.stack = 'Error: at a@b.com\n    at https://x.test/app.js?token=abc:1:2';
    const payload = errorPayload('error', error, { source: 'https://x.test/app.js?token=abc', line: 1, column: 2 });
    expect(payload.message).toBe(`Error: at ${REDACTED}`);
    expect(payload.stack).toContain(REDACTED);
    expect(payload.stack).not.toContain('a@b.com');
    expect(payload.source).toBe(`https://x.test/app.js?token=${encodeURIComponent(REDACTED)}`);
    expect(payload).toMatchObject({ line: 1, column: 2 });
  });

  it('joins console arguments and clips a very long line', () => {
    expect(consolePayload('warn', ['a', 1, { b: 2 }, null])).toEqual({ level: 'warn', message: 'a 1 {"b":2} null' });
    expect(consolePayload('error', ['x'.repeat(5000)]).message.length).toBeLessThan(1100);
  });
});

describe('startDiagnostics', () => {
  it('records an uncaught error once and flags the session', () => {
    const c = collector();
    const handle = startDiagnostics({ errors: true, console: false, network: false, ...c.options });

    throwUncaught({ error: new TypeError('boom'), filename: 'https://x.test/a.js', lineno: 3 });

    expect(c.of(ERROR_TAG)).toEqual([expect.objectContaining({ message: 'TypeError: boom', kind: 'error' })]);
    expect(c.flagged()).toBe(1);
    handle.stop();
  });

  it('stops listening once stopped, and stopping twice is safe', () => {
    const c = collector();
    const handle = startDiagnostics({ errors: true, console: false, network: false, ...c.options });
    handle.stop();
    handle.stop();
    throwUncaught({ error: new Error('after') });
    expect(c.of(ERROR_TAG)).toEqual([]);
  });

  it('flags the session on every error but records at most the per-session cap', () => {
    const c = collector();
    const handle = startDiagnostics({ errors: true, console: false, network: false, ...c.options });
    for (let i = 0; i < LIMITS.error + 20; i += 1) {
      throwUncaught({ error: new Error(`e${i}`) });
    }
    expect(c.of(ERROR_TAG)).toHaveLength(LIMITS.error);
    // The flag is set once, not once per error.
    expect(c.flagged()).toBe(1);
    handle.stop();
  });

  it('records console.error and console.warn, passes the call through, and restores the originals', () => {
    const c = collector();
    const seen: unknown[][] = [];
    const pristine = console.error;
    // Installed before the recorder sees it: stopping must give back *this*,
    // not the pristine console, or the recorder would silently undo another
    // library's patch.
    const theirs = (...args: unknown[]): void => { seen.push(args); };
    console.error = theirs as typeof console.error;

    const handle = startDiagnostics({ errors: false, console: true, network: false, ...c.options });
    console.error('broke', 7);
    console.warn('careful');

    expect(c.of(CONSOLE_TAG)).toEqual([
      { level: 'error', message: 'broke 7' },
      { level: 'warn', message: 'careful' },
    ]);
    // The page's own console still ran, with its own arguments.
    expect(seen).toEqual([['broke', 7]]);

    handle.stop();
    expect(console.error).toBe(theirs);
    console.error = pristine;
  });

  it('never records its own warnings', () => {
    const c = collector();
    const handle = startDiagnostics({ errors: false, console: true, network: false, ...c.options });
    console.warn('[anyreplay] track() ignored: something');
    expect(c.of(CONSOLE_TAG)).toEqual([]);
    handle.stop();
  });

  it('records a fetch as metadata only, and returns the page its own response', async () => {
    const c = collector();
    const response = new Response('body', { status: 201 });
    const pristine = window.fetch;
    const theirs = (() => Promise.resolve(response)) as typeof window.fetch;
    window.fetch = theirs;

    const handle = startDiagnostics({ errors: false, console: false, network: true, ...c.options });
    await expect(fetch('https://api.test/orders?token=abc', { method: 'post' })).resolves.toBe(response);

    const [entry] = c.of(NETWORK_TAG);
    expect(entry).toMatchObject({
      url: `https://api.test/orders?token=${encodeURIComponent(REDACTED)}`,
      method: 'POST', status: 201, initiator: 'fetch',
    });
    // Nothing about the body, in any spelling.
    expect(Object.keys(entry!).sort()).toEqual(['durationMs', 'initiator', 'method', 'status', 'url']);

    handle.stop();
    expect(window.fetch).toBe(theirs);
    window.fetch = pristine;
  });

  it('records a failed fetch as status 0 and rethrows the original reason', async () => {
    const c = collector();
    const reason = new TypeError('Failed to fetch');
    const original = window.fetch;
    window.fetch = (() => Promise.reject(reason)) as typeof window.fetch;

    const handle = startDiagnostics({ errors: false, console: false, network: true, ...c.options });
    await expect(fetch('https://api.test/x')).rejects.toBe(reason);
    expect(c.of(NETWORK_TAG)).toEqual([expect.objectContaining({ status: 0, failed: true })]);
    expect(c.flagged()).toBe(1);

    handle.stop();
    window.fetch = original;
  });

  it('flags the session on a 4xx or 5xx but not on a 2xx', async () => {
    const c = collector();
    const original = window.fetch;
    let status = 200;
    window.fetch = (() => Promise.resolve(new Response('', { status }))) as typeof window.fetch;
    const handle = startDiagnostics({ errors: false, console: false, network: true, ...c.options });

    await fetch('https://api.test/ok');
    expect(c.flagged()).toBe(0);
    status = 503;
    await fetch('https://api.test/down');
    expect(c.flagged()).toBe(1);

    handle.stop();
    window.fetch = original;
  });

  it('does not record its own chunk uploads', async () => {
    const c = collector();
    const original = window.fetch;
    window.fetch = (() => Promise.resolve(new Response('', { status: 202 }))) as typeof window.fetch;
    const handle = startDiagnostics({ errors: false, console: false, network: true, ...c.options });

    await fetch('https://in.anyreplay.com/v1/chunks', { method: 'POST' });
    expect(c.of(NETWORK_TAG)).toEqual([]);

    handle.stop();
    window.fetch = original;
  });

  it('patches nothing a stream was switched off for', () => {
    const c = collector();
    const fetchBefore = window.fetch;
    const errorBefore = console.error;
    const handle = startDiagnostics({ errors: false, console: false, network: false, ...c.options });
    expect(window.fetch).toBe(fetchBefore);
    expect(console.error).toBe(errorBefore);
    handle.stop();
  });
});
