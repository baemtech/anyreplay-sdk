import type { AnyReplayOptions, RecorderHandle } from '@anyreplay/browser';
import { getIdentifier, getName, getVersion } from '@tauri-apps/api/app';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { PLATFORM, SDK_NAME, SDK_VERSION } from './version.js';
import { APP_ID_PATTERN, clipVersion, deferredRecorder, type DeferredHandle, type RecorderSetup } from './web-family.js';

export { SDK_NAME, SDK_VERSION } from './version.js';
export type { RecorderSetup } from './web-family.js';

export interface AnyReplayTauriOptions extends AnyReplayOptions {
  /**
   * The app id. Normally left out: it is read from `identifier` in
   * `tauri.conf.json` (`getIdentifier()`, Tauri 2.4 and later). Set here, it
   * wins.
   */
  appId?: string;
  /** The app version. Normally left out: it is read with `getVersion()`. */
  appVersion?: string;
  /**
   * Send what has been recorded whenever the window loses focus. On by
   * default. Uses the window's focus event, which `core:default` allows.
   */
  flushOnBlur?: boolean;
  /**
   * Send what has been recorded before the window closes. Off by default:
   * listening for the close request makes the window close itself from
   * JavaScript afterwards, which needs `core:window:allow-destroy` in the
   * window's capability — without it, the window would not close at all.
   */
  flushOnClose?: boolean;
}

export type AnyReplayTauri = DeferredHandle;

/** What the app says about itself, read through Tauri's app API. */
export interface TauriAppInfo {
  appId?: string;
  appVersion?: string;
}

let current: AnyReplayTauri | null = null;

/**
 * Starts recording the window. Call it once, as early as you can in your
 * frontend:
 *
 * ```ts
 * import { init } from '@anyreplay/tauri';
 * const replay = init({ projectKey: 'ar_pk_live_…' });
 * replay.track('document_opened');
 * ```
 *
 * The app id and version are read through `@tauri-apps/api/app`, so
 * recording starts a moment after this returns; calls made in between are
 * queued. A second call returns the first handle. Each window is its own
 * session; the visitor id is kept in `localStorage`, which Tauri persists
 * across launches.
 */
export function init(options: AnyReplayTauriOptions): AnyReplayTauri {
  if (current) return current;
  const { flushOnBlur = true, flushOnClose = false, ...rest } = options;

  const handle = deferredRecorder(
    async () => tauriSetup(rest, await readAppInfo()),
    (recorder) => { void wire(recorder, flushOnBlur, flushOnClose); },
  );
  current = handle;
  return handle;
}

/**
 * The identifier and version, or as much of them as the app allows.
 *
 * Each call is separate because each can fail on its own: `getIdentifier`
 * needs Tauri 2.4, and a capability can leave out any of them. Outside Tauri
 * (the frontend opened in a browser during development) there is nothing to
 * ask.
 */
export async function readAppInfo(): Promise<TauriAppInfo> {
  if (!safe(() => isTauri(), false)) return {};
  const [identifier, name, version] = await Promise.all([
    getIdentifier().catch(() => undefined),
    getName().catch(() => undefined),
    getVersion().catch(() => undefined),
  ]);
  const appId = [identifier, name].map((value) => value?.trim()).find((value) => value && APP_ID_PATTERN.test(value));
  return { ...(appId ? { appId } : {}), ...(version ? { appVersion: version } : {}) };
}

/**
 * The browser SDK's options for this window — the installer's, with the app
 * id filled in — and the shell it runs in, which only the wrapper knows.
 */
export function tauriSetup(options: AnyReplayTauriOptions, info: TauriAppInfo): RecorderSetup {
  const appId = options.appId?.trim() || info.appId;
  if (!appId && typeof console !== 'undefined') {
    console.warn('[anyreplay] no appId: set `identifier` in tauri.conf.json (Tauri 2.4+) or pass appId. A project that lists allowed apps refuses sessions without one.');
  }
  if (appId && !APP_ID_PATTERN.test(appId)) {
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

async function wire(recorder: RecorderHandle, flushOnBlur: boolean, flushOnClose: boolean): Promise<void> {
  const window = safe(() => (isTauri() ? getCurrentWindow() : null), null);

  if (flushOnBlur) {
    const listened = window
      ? await window.onFocusChanged(({ payload: focused }) => { if (!focused) void recorder.flush(); }).then(() => true, () => false)
      : false;
    // Outside Tauri, or without permission to listen: the page's own blur.
    if (!listened && typeof globalThis.addEventListener === 'function') {
      globalThis.addEventListener('blur', () => { void recorder.flush(); });
    }
  }

  if (flushOnClose && window) {
    await window.onCloseRequested(async () => {
      // Bounded: closing must never hang on the network.
      await Promise.race([recorder.flush(), new Promise((resolve) => setTimeout(resolve, 1500))]);
    }).catch(() => undefined);
  }
}

function safe<T>(run: () => T, fallback: T): T {
  try {
    return run();
  } catch {
    return fallback;
  }
}

/** For tests: forget the handle `init` returned. */
export function __resetForTests(): void {
  current?.stop();
  current = null;
}
