import { hashToUnitInterval, isSampledIn } from '../src/sampling';

describe('sampling', () => {
  it('includes everyone at 1 and nobody at 0', () => {
    for (const id of ['a', 'b', 'visitor-123']) {
      expect(isSampledIn(id, 1)).toBe(true);
      expect(isSampledIn(id, 0)).toBe(false);
    }
  });

  it('is deterministic — the same visitor always gets the same answer', () => {
    // A visitor flickering in and out would produce fragmented sessions.
    const id = 'v9f2c1a4b7e3';
    const first = isSampledIn(id, 0.5);
    for (let i = 0; i < 50; i += 1) expect(isSampledIn(id, 0.5)).toBe(first);
  });

  it('produces roughly the requested share across many visitors', () => {
    const total = 20_000;
    for (const rate of [0.1, 0.25, 0.5]) {
      let included = 0;
      for (let i = 0; i < total; i += 1) if (isSampledIn(`visitor-${i}`, rate)) included += 1;
      const observed = included / total;
      expect(Math.abs(observed - rate), `rate ${rate} observed ${observed}`).toBeLessThan(0.02);
    }
  });

  it('is monotonic: raising the rate never drops a visitor already included', () => {
    for (let i = 0; i < 500; i += 1) {
      const id = `visitor-${i}`;
      if (isSampledIn(id, 0.3)) expect(isSampledIn(id, 0.6)).toBe(true);
    }
  });

  it('hashes into the unit interval', () => {
    for (const id of ['', 'a', 'a-much-longer-visitor-identifier']) {
      const value = hashToUnitInterval(id);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});
