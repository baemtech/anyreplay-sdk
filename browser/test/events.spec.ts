import { EVENT_NAME_PATTERN, MAX_PROPERTIES_BYTES, validateTrack } from '../src/events';

describe('validateTrack', () => {
  it('accepts a name of the documented shape', () => {
    for (const name of ['x', 'checkout_started', 'cart.item:added', 'A-B', 'a'.repeat(64)]) {
      expect(validateTrack(name, undefined), name).toEqual({ name, properties: {} });
    }
  });

  it('refuses names ingest would refuse, so nothing is sent only to be dropped', () => {
    for (const name of ['', 'has space', 'a'.repeat(65), 'emoji🙂', '$navigate', 42, null, undefined]) {
      expect(typeof validateTrack(name, undefined), String(name)).toBe('string');
    }
    // The pattern is the same one ingest applies.
    expect(EVENT_NAME_PATTERN.source).toBe('^[A-Za-z0-9_.:-]{1,64}$');
  });

  it('copies the properties so later mutation and non-JSON values do not reach the wire', () => {
    const properties: Record<string, unknown> = { a: 1, when: new Date(0), fn: () => 1, nested: { ok: true } };
    const result = validateTrack('x', properties);
    expect(result).toEqual({ name: 'x', properties: { a: 1, when: '1970-01-01T00:00:00.000Z', nested: { ok: true } } });
    properties.a = 2;
    expect((result as unknown as { properties: { a: number } }).properties.a).toBe(1);
  });

  it('refuses arrays, primitives, circular objects, and anything over the size limit', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(typeof validateTrack('x', ['a'])).toBe('string');
    expect(typeof validateTrack('x', 'text')).toBe('string');
    expect(typeof validateTrack('x', circular)).toBe('string');
    expect(typeof validateTrack('x', { blob: 'x'.repeat(MAX_PROPERTIES_BYTES) })).toBe('string');
    // Measured in bytes: a multi-byte character counts for what it costs on the wire.
    expect(typeof validateTrack('x', { blob: '𝄞'.repeat(1100) })).toBe('string');
    expect(typeof validateTrack('x', { blob: 'x'.repeat(MAX_PROPERTIES_BYTES - 20) })).toBe('object');
  });
});
