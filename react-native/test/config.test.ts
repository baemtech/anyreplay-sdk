import { describe, expect, it } from 'vitest';
import { DEFAULTS, resolveOptions } from '../src/config.js';

const KEY = 'ar_pk_live_0123456789abcdef01234567';

describe('resolveOptions', () => {
  it('masks every TextInput unless the app opts out with maskAllInputs: false', () => {
    expect(DEFAULTS.maskAllInputs).toBe(true);
    expect(DEFAULTS.maskAllTyping).toBe(false);
    expect(resolveOptions({ projectKey: KEY }).maskAllInputs).toBe(true);
    expect(resolveOptions({ projectKey: KEY, maskAllInputs: undefined }).maskAllInputs).toBe(true);
    expect(resolveOptions({ projectKey: KEY, maskAllInputs: true }).maskAllInputs).toBe(true);
    expect(resolveOptions({ projectKey: KEY, maskAllInputs: false }).maskAllInputs).toBe(false);
  });

  it('keeps fields masked when the opt-out is not a real false', () => {
    // What a configuration file or a remote flag actually hands over.
    for (const value of ['false', 0, null, {}]) {
      expect(resolveOptions({ projectKey: KEY, maskAllInputs: value as unknown as boolean }).maskAllInputs, String(value))
        .toBe(true);
    }
  });
});
