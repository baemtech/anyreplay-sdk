import { Capacitor, registerPlugin } from '@capacitor/core';
import type { AnyReplayNativePlugin } from './definitions.js';
import { createAppRecorder, type AppRecorder, type NativeBridge } from './shell.js';
import { SDK_NAME, SDK_VERSION } from './version.js';

/**
 * AnyReplay for Capacitor (and Ionic) apps.
 *
 * ```ts
 * import { AnyReplay } from '@anyreplay/capacitor';
 *
 * AnyReplay.init({ projectKey: 'ar_pk_live_…' });
 * ```
 *
 * The app's UI is a web page, so it is recorded as one, by
 * `@anyreplay/browser` — every option of that SDK works here. This package
 * adds what only the native side knows: the app id (bundle id / package
 * name, sent as `appId` unless you pass one), the app version and device
 * model, storage that survives WKWebView purging it, a flush when the app
 * goes to the background, and `assets: 'inline'` so the replay has the app's
 * styles, fonts and images (docs/SDK-CONTRACT.md §9.1–§9.2).
 */
export const AnyReplayNative = registerPlugin<AnyReplayNativePlugin>('AnyReplay');

/** The native plugin as the shell uses it; undefined in a desktop browser (`ionic serve`). */
export function capacitorBridge(plugin: AnyReplayNativePlugin = AnyReplayNative): NativeBridge | undefined {
  if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable('AnyReplay')) return undefined;
  return {
    info: () => plugin.getInfo(),
    readState: async () => (await plugin.readState()).value ?? null,
    writeState: (value) => plugin.writeState({ value }),
    onPause: (listener) => { void plugin.addListener('pause', listener); },
    onResume: (listener) => { void plugin.addListener('resume', listener); },
    pauseHandled: () => { void plugin.pauseHandled().catch(() => undefined); },
  };
}

export const AnyReplay: AppRecorder = createAppRecorder({
  platform: 'capacitor',
  sdk: { name: SDK_NAME, version: SDK_VERSION },
  native: () => capacitorBridge(),
});

export { SDK_NAME, SDK_VERSION };
export type { AnyReplayNativePlugin } from './definitions.js';
export type { AppRecorder, IdentifyTraits } from './shell.js';
export type { AnyReplayOptions, RecorderStatus } from '@anyreplay/browser';
