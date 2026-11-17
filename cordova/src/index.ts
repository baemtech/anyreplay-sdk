import type { AnyReplayOptions, RecorderStatus } from '@anyreplay/browser';
import { createAppRecorder, type AppInfo, type IdentifyTraits, type NativeBridge } from '@anyreplay/capacitor/shell';
import { SDK_NAME, SDK_VERSION } from './version.js';

/**
 * AnyReplay for Cordova apps, as the global `AnyReplay`.
 *
 * ```js
 * document.addEventListener('deviceready', () => {
 *   AnyReplay.init({ projectKey: 'ar_pk_live_…' });
 * });
 * ```
 *
 * The same JavaScript core as `@anyreplay/capacitor` (its `shell` module) on
 * top of `@anyreplay/browser`, bundled into one file Cordova loads as a
 * plugin module (plugin.xml). Only the bridge differs: `cordova.exec` to the
 * small native classes in `native/`, and Cordova's own `pause` and `resume`
 * document events. See docs/SDK-CONTRACT.md §9.2.
 */

interface CordovaGlobal {
  exec(success: (value: unknown) => void, fail: (error: unknown) => void, service: string, action: string, args: unknown[]): void;
}

/** The `<feature name>` in plugin.xml. */
const SERVICE = 'AnyReplay';

const cordovaGlobal = (): CordovaGlobal | undefined => {
  const value = (globalThis as { cordova?: CordovaGlobal }).cordova;
  return value && typeof value.exec === 'function' ? value : undefined;
};

function call<T>(cordova: CordovaGlobal, action: string, args: unknown[] = []): Promise<T> {
  return new Promise<T>((resolve, reject) => cordova.exec((value) => resolve(value as T), reject, SERVICE, action, args));
}

/** The native classes as the shell uses them; undefined outside a Cordova app. */
export function cordovaBridge(): NativeBridge | undefined {
  const cordova = cordovaGlobal();
  if (!cordova) return undefined;
  return {
    info: () => call<AppInfo>(cordova, 'getInfo'),
    readState: async () => (await call<string | null | undefined>(cordova, 'readState')) ?? null,
    writeState: async (value) => { await call(cordova, 'writeState', [value]); },
    // Cordova's own lifecycle events, fired on the document by both platforms.
    onPause: (listener) => document.addEventListener('pause', listener, false),
    onResume: (listener) => document.addEventListener('resume', listener, false),
  };
}

/**
 * Cordova's bridge is usable once `deviceready` has fired. The event is
 * sticky — a listener added afterwards runs at once — so waiting is free when
 * `init` is called late, and outside Cordova there is nothing to wait for.
 */
function deviceReady(): Promise<void> {
  if (!cordovaGlobal() || typeof document === 'undefined') return Promise.resolve();
  return new Promise((resolve) => document.addEventListener('deviceready', () => resolve(), { once: true }));
}

const recorder = createAppRecorder({
  platform: 'cordova',
  sdk: { name: SDK_NAME, version: SDK_VERSION },
  native: cordovaBridge,
});

let initializing: Promise<void> | undefined;

/** Starts recording. Waits for `deviceready`; a second call is ignored. */
export function init(options: AnyReplayOptions): Promise<void> {
  initializing ??= deviceReady().then(() => recorder.init(options));
  return initializing;
}

/** `consent(true)` starts a recorder created with `requireConsent`; `consent(false)` stops it and forgets the visitor. */
export function consent(granted: boolean): void { recorder.consent(granted); }
export function identify(traits: IdentifyTraits): void { recorder.identify(traits); }
export function track(name: string, properties?: Record<string, unknown>): void { recorder.track(name, properties); }
export function trackError(error: unknown): void { recorder.trackError(error); }
export function stop(): void { recorder.stop(); }
export async function flush(): Promise<void> {
  await initializing;
  await recorder.flush();
}
export function sessionId(): string | null { return recorder.sessionId(); }
export function status(): RecorderStatus { return recorder.status(); }

export { SDK_NAME, SDK_VERSION };
export type { AnyReplayOptions, IdentifyTraits, RecorderStatus };
