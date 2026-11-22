/**
 * Which SDK recorded a session, as it tells ingest on the session's first chunk.
 *
 * The version is the package's own, written in at build time by tsup (and by
 * Vitest for the tests) from package.json — see `define` in tsup.config.ts.
 * Not imported from package.json at runtime: that would ship the whole
 * manifest inside the CDN bundle, and a bundler that does not resolve JSON
 * would fail on it. Source consumed without that build step (a workspace
 * importing `src/` directly) reports `0.0.0-dev`, which is honest about what
 * it is rather than a version that was never released.
 */
declare const __ANYREPLAY_SDK_VERSION__: string | undefined;

export const SDK_NAME = '@anyreplay/browser';

export const SDK_VERSION: string =
  typeof __ANYREPLAY_SDK_VERSION__ === 'string' ? __ANYREPLAY_SDK_VERSION__ : '0.0.0-dev';

/** What a browser page records on. An app shell (Capacitor, Electron) will have its own SDK say otherwise. */
export const PLATFORM = 'web';
