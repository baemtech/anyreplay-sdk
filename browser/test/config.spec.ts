import { ConfigError, DEFAULTS, resolveOptions } from '../src/config';

const KEY = 'ar_pk_live_0123456789abcdef01234567';

describe('resolveOptions', () => {
  it('fills in the documented defaults', () => {
    const options = resolveOptions({ projectKey: KEY });
    expect(options.sampleRate).toBe(1);
    expect(options.flushIntervalMs).toBe(DEFAULTS.flushIntervalMs);
    expect(options.maskClass).toBe('ar-mask');
    expect(options.blockClass).toBe('ar-block');
  });

  it('leaves both masking switches off unless explicitly enabled', () => {
    expect(DEFAULTS.maskAllInputs).toBe(false);
    expect(DEFAULTS.maskAllTyping).toBe(false);
    expect(resolveOptions({ projectKey: KEY }).maskAllInputs).toBe(false);
    expect(resolveOptions({ projectKey: KEY }).maskAllTyping).toBe(false);
    expect(resolveOptions({ projectKey: KEY, maskAllInputs: undefined }).maskAllInputs).toBe(false);
    expect(resolveOptions({ projectKey: KEY, maskAllInputs: true }).maskAllInputs).toBe(true);
    expect(resolveOptions({ projectKey: KEY, maskAllInputs: false }).maskAllInputs).toBe(false);
    expect(resolveOptions({ projectKey: KEY, maskAllTyping: true }).maskAllTyping).toBe(true);
    expect(resolveOptions({ projectKey: KEY, maskAllTyping: false }).maskAllTyping).toBe(false);
  });

  it('ignores a non-boolean switch, and says so where whoever wrote it will see it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // What a hand-written snippet or a tag manager variable actually sends.
    for (const value of ['true', 1, {}, null]) {
      expect(resolveOptions({ projectKey: KEY, maskAllInputs: value as unknown as boolean }).maskAllInputs, String(value))
        .toBe(false);
    }
    expect(warn).toHaveBeenCalledTimes(4);
    expect(warn.mock.calls[0]![0]).toMatch(/maskAllInputs ignored: expected true or false/);
    // Silence is only for the option nobody set.
    warn.mockClear();
    resolveOptions({ projectKey: KEY });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('rejects a malformed project key with a message that says what to do', () => {
    for (const key of ['', 'nope', 'ar_pk_live_short', 'pk_live_0123456789abcdef01234567']) {
      expect(() => resolveOptions({ projectKey: key }), key).toThrow(ConfigError);
    }
    expect(() => resolveOptions({ projectKey: 'nope' })).toThrow(/copy it from the dashboard/);
  });

  it('accepts both live and test keys', () => {
    expect(() => resolveOptions({ projectKey: KEY })).not.toThrow();
    expect(() => resolveOptions({ projectKey: 'ar_pk_test_0123456789abcdef01234567' })).not.toThrow();
  });

  it('rejects a sample rate outside 0..1', () => {
    for (const rate of [-0.1, 1.5, Number.NaN]) {
      expect(() => resolveOptions({ projectKey: KEY, sampleRate: rate })).toThrow(ConfigError);
    }
  });

  it('normalises a trailing slash on the ingest URL', () => {
    expect(resolveOptions({ projectKey: KEY, ingestUrl: 'https://in.test/' }).ingestUrl).toBe('https://in.test');
    expect(resolveOptions({ projectKey: KEY, ingestUrl: 'https://in.test///' }).ingestUrl).toBe('https://in.test');
  });

  describe('maxSessionsPerMonth', () => {
    it('is optional and passes through unchanged', () => {
      expect(resolveOptions({ projectKey: KEY }).maxSessionsPerMonth).toBeUndefined();
      expect(resolveOptions({ projectKey: KEY, maxSessionsPerMonth: 5000 }).maxSessionsPerMonth).toBe(5000);
      expect(resolveOptions({ projectKey: KEY, maxSessionsPerMonth: 1_000_000 }).maxSessionsPerMonth).toBe(1_000_000);
    });

    it('refuses anything ingest would refuse, at install time rather than as a 422 later', () => {
      for (const cap of [0, -1, 1.5, 1_000_001, Number.NaN, '100' as unknown as number]) {
        expect(() => resolveOptions({ projectKey: KEY, maxSessionsPerMonth: cap }), String(cap)).toThrow(ConfigError);
      }
    });
  });
});
