/**
 * FNV-1a. Small, fast, and good enough to spread visitor ids uniformly across
 * the unit interval — this is a bucketing decision, not a security one.
 */
export function hashToUnitInterval(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash / 0xffffffff;
}

/**
 * Decides sampling from the visitor id rather than a coin flip.
 *
 * The same visitor therefore gets the same answer on every page and every
 * visit: a recorded journey stays whole instead of appearing as disconnected
 * fragments, and changing the rate moves a predictable slice of the population.
 */
export function isSampledIn(visitorId: string, sampleRate: number): boolean {
  if (sampleRate >= 1) return true;
  if (sampleRate <= 0) return false;
  return hashToUnitInterval(visitorId) < sampleRate;
}
