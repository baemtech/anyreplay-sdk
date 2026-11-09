import type { AnyReplayOptions, RecorderHandle } from '@anyreplay/browser';
import { BRIDGE_KEY, type AnyReplayBridge, type AppInfo, type MainErrorMessage } from './bridge.js';
import { PLATFORM, SDK_NAME, SDK_VERSION } from './version.js';
import { APP_ID_PATTERN, clipVersion, deferredRecorder, type DeferredHandle, type RecorderSetup } from './web-family.js';

export { BRIDGE_KEY, CHANNELS, type AnyReplayBridge, type AppInfo, type MainErrorMessage } from './bridge.js';
export { SDK_NAME, SDK_VERSION } from './version.js';
export type { RecorderSetup } from './web-family.js';

export interface AnyReplayElectronOptions extends AnyReplayOptions {
  /**
   * The app id. Normally left out: the main process supplies it
   * (`setupAnyReplay({ appId })`). Set here, it wins.
   */
  appId?: string;
  /** The app version. Normally left out: the main process supplies `app.getVersion()`. */
  appVersion?: string;
  /**
   * Send what has been recorded whenever the window loses focus. On by
   * default: a desktop app is rarely closed the way a tab is, and the main
   * process can be killed without `before-quit`.
   */
  flushOnBlur?: boolean;
}

export type AnyReplayElectron = DeferredHandle;

let current: AnyReplayElectron | null = null;

/**
 * Starts recording this window. Call it once in the renderer, as early as you
 * can:
 *
 * ```ts
 * import { init } from '@anyreplay/electron';
 * const replay = init({ projectKey: 'ar_pk_live_…' });
 * replay.track('document_opened');
 * ```
 *
 * The app id and version come from the main process through the preload
 * bridge (`exposeAnyReplay()` and `setupAnyReplay()`), so recording starts a
 * moment after this returns; calls made in between are queued. A second call
 * returns the first handle.
 *
 * Each window is its own session: the session id lives in the window's
 * `sessionStorage`, the visitor id in `localStorage`, which Electron keeps
 * across launches and shares between windows of the same session partition.
 */
export function init(options: AnyReplayElectronOptions): AnyReplayElectron {
  if (current) return current;
  const bridge = findBridge();
  const { flushOnBlur = true, ...rest } = options;

  const handle = deferredRecorder(
    async () => {
      const info: AppInfo = bridge ? await bridge.appInfo() : {};
      return electronSetup(rest, info);
    },
    (recorder) => wire(recorder, bridge, flushOnBlur),
  );
  current = handle;
  return handle;
}

/**
 * The browser SDK's options for this window — the installer's, with the app
 * id filled in — and the shell it runs in, which only the wrapper knows.
 */
export function electronSetup(options: AnyReplayElectronOptions, info: AppInfo): RecorderSetup {
  const appId = options.appId?.trim() || info.appId;
  if (!appId && typeof console !== 'undefined') {
    console.warn('[anyreplay] no appId: call setupAnyReplay({ appId }) in the main process and exposeAnyReplay() in the preload. A project that lists allowed apps refuses sessions without one.');
  }
  if (appId && !APP_ID_PATTERN.test(appId)) {
    // Thrown by the browser SDK too; said here in the shell's own terms.
    throw new Error(`anyreplay: appId ${JSON.stringify(appId)} should be an app identifier such as com.example.app`);
  }
  const { appVersion: ownVersion, ...browserOptions } = options;
  const appVersion = clipVersion(ownVersion ?? info.appVersion);
  return {
    options: {
      // Inline unless the app says otherwise: a window loaded from the app's
      // own files has addresses no reviewer can load (contract §9.1).
      assets: 'inline',
      ...browserOptions,
      ...(appId ? { appId } : {}),
    },
    shell: {
      platform: PLATFORM,
      sdk: { name: SDK_NAME, version: SDK_VERSION },
      ...(appVersion ? { appVersion } : {}),
    },
  };
}

function wire(recorder: RecorderHandle, bridge: AnyReplayBridge | null, flushOnBlur: boolean): void {
  bridge?.onFlushRequest(() => recorder.flush());
  // An error like the window's own: the same `anyreplay.error` event, the same
  // redaction and ceiling, and the session's `hasError` set (contract §8.3).
  bridge?.onMainError((error) => recorder.trackError(mainError(error)));
  if (flushOnBlur && typeof window !== 'undefined') {
    window.addEventListener('blur', () => { void recorder.flush(); });
  }
}

/**
 * A main-process error as an `Error` again — it crossed IPC as plain fields —
 * for the browser SDK to redact and clip like any other.
 */
export function mainError(error: MainErrorMessage | undefined): Error {
  const value = new Error(typeof error?.message === 'string' ? error.message : 'error');
  value.name = typeof error?.name === 'string' && error.name ? error.name : 'Error';
  value.stack = typeof error?.stack === 'string' ? error.stack : '';
  return value;
}

function findBridge(): AnyReplayBridge | null {
  const candidate = (globalThis as Record<string, unknown>)[BRIDGE_KEY] as AnyReplayBridge | undefined;
  return candidate && typeof candidate.appInfo === 'function' ? candidate : null;
}

/** For tests: forget the handle `init` returned. */
export function __resetForTests(): void {
  current?.stop();
  current = null;
}
