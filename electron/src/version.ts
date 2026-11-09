/**
 * Which SDK recorded a session (docs/SDK-CONTRACT.md §2.4).
 *
 * The version is written in at build time by tsup (and by Vitest for the
 * tests) from package.json, as in the browser SDK; source used without that
 * step reports `0.0.0-dev`.
 */
declare const __ANYREPLAY_SDK_VERSION__: string | undefined;

export const SDK_NAME = '@anyreplay/electron';

export const SDK_VERSION: string =
  typeof __ANYREPLAY_SDK_VERSION__ === 'string' ? __ANYREPLAY_SDK_VERSION__ : '0.0.0-dev';

export const PLATFORM = 'electron';
