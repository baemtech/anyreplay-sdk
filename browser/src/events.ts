/**
 * Custom events: the moments a page tags with `track()`.
 *
 * They travel inside the rrweb stream as rrweb's own Custom event type, so
 * they carry the recording's clock and replay in order with everything else.
 * Ingest recognises them by these tags; the names are a contract with
 * apps/ingest/src/custom-events.ts.
 */
export const TRACK_TAG = 'anyreplay.track';
export const NAVIGATE_TAG = 'anyreplay.navigate';

/** Short and URL-safe: an event name is a label, not a message. Ingest applies the same rule. */
export const EVENT_NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
/** Properties are stored with the event and indexed by nobody; a bag bigger than this is a payload, not context. */
export const MAX_PROPERTIES_BYTES = 4 * 1024;

export interface TrackPayload {
  name: string;
  properties: Record<string, unknown>;
}

/**
 * Checks what the page passed to `track()`, returning the payload to send or
 * the reason it was refused. Never throws: the page's own code is calling
 * this on a click handler, and a recorder that throws there breaks the click.
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
  // The parsed copy, not the original: a getter or a class instance on the
  // caller's object must not reach the wire, and a later mutation must not
  // change what was tracked.
  return { name, properties: JSON.parse(serialised) as Record<string, unknown> };
}

function byteLength(text: string): number {
  return typeof TextEncoder === 'function' ? new TextEncoder().encode(text).length : text.length * 3;
}
