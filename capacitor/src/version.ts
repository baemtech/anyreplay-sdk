/**
 * This package's own name and version, as every session it records reports
 * them (`meta.sdk`, docs/SDK-CONTRACT.md §2.4). The version is written in at
 * build time from package.json (tsup.config.ts, vitest.config.ts); source
 * used without that step reports `0.0.0-dev`.
 */
declare const __ANYREPLAY_SDK_VERSION__: string | undefined;

export const SDK_NAME = '@anyreplay/capacitor';

export const SDK_VERSION: string =
  typeof __ANYREPLAY_SDK_VERSION__ === 'string' ? __ANYREPLAY_SDK_VERSION__ : '0.0.0-dev';
