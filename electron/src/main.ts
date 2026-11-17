import { app, BrowserWindow, ipcMain, type WebContents } from 'electron';
import { CHANNELS, type AppInfo, type MainErrorMessage } from './bridge.js';

export interface AnyReplayMainOptions {
  /**
   * The app id sessions are reported under (§2.2 of the SDK contract) — the
   * id you list under the project's allowed apps. Use your bundle id, the
   * `appId` from electron-builder or Forge's `appBundleId`
   * (`com.example.notes`).
   *
   * Electron has no API for the bundle id, so without this the id is made from
   * `app.getName()`: kept as it is when it is already a valid id, otherwise
   * lower-cased with every run of other characters turned into `-`
   * (`"Acme Notes"` → `acme-notes`). Pass it explicitly in anything you ship.
   */
  appId?: string;
  /**
   * How long quitting may wait for the windows to send what they have
   * recorded, in milliseconds. Default 1500; `0` turns the flush off.
   */
  quitFlushTimeoutMs?: number;
  /**
   * Forward uncaught exceptions in the main process into the focused window's
   * recording as an error, as if the window had caught it (`trackError`): it
   * shows in the replay's errors and marks the session as having one. On by
   * default.
   *
   * Observed with `uncaughtExceptionMonitor`, so it changes nothing about how
   * your app handles (or does not handle) the error. The message and stack are
   * redacted in the window before they are recorded, by the same rules as the
   * page's own errors.
   */
  forwardMainErrors?: boolean;
}

export interface AnyReplayMainHandle {
  /** Removes every listener and handler this installed. */
  dispose: () => void;
}

const DEFAULT_QUIT_FLUSH_TIMEOUT_MS = 1500;
const APP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,254}$/;

/** The app id from an explicit option or, failing that, from the app's name. */
export function resolveAppId(explicit: string | undefined, name: string | undefined): string | undefined {
  const given = explicit?.trim();
  if (given) return APP_ID_PATTERN.test(given) ? given : undefined;
  const raw = name?.trim() ?? '';
  if (APP_ID_PATTERN.test(raw)) return raw;
  const slug = raw.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+|-+$/g, '');
  return APP_ID_PATTERN.test(slug) ? slug : undefined;
}

/**
 * Wires the main process to the recorder in your windows. Call it once, early
 * in your main process, before the first window loads:
 *
 * ```ts
 * // main.ts
 * import { setupAnyReplay } from '@anyreplay/electron/main';
 * setupAnyReplay({ appId: 'com.example.notes' });
 * ```
 *
 * It answers the windows' request for the app id and version, holds quitting
 * back (briefly) until every window has sent what it recorded, and forwards
 * uncaught main-process exceptions into the focused window's session.
 */
export function setupAnyReplay(options: AnyReplayMainOptions = {}): AnyReplayMainHandle {
  const appId = resolveAppId(options.appId, app.getName());
  if (options.appId !== undefined && !appId) {
    console.warn(`[anyreplay] appId ${JSON.stringify(options.appId)} is not an app identifier such as com.example.app; sessions are sent without one`);
  }
  const info: AppInfo = {
    ...(appId ? { appId } : {}),
    appVersion: app.getVersion(),
  };
  const cleanup: (() => void)[] = [];

  ipcMain.handle(CHANNELS.appInfo, () => info);
  cleanup.push(() => ipcMain.removeHandler(CHANNELS.appInfo));

  const timeout = options.quitFlushTimeoutMs ?? DEFAULT_QUIT_FLUSH_TIMEOUT_MS;
  if (timeout > 0) {
    let flushed = false;
    let flushing = false;
    const onBeforeQuit = (event: Electron.Event): void => {
      if (flushed) return;
      event.preventDefault();
      if (flushing) return;
      flushing = true;
      void flushAll(BrowserWindow.getAllWindows().map((window) => window.webContents), timeout).finally(() => {
        flushed = true;
        app.quit();
      });
    };
    app.on('before-quit', onBeforeQuit);
    cleanup.push(() => app.removeListener('before-quit', onBeforeQuit));
  }

  if (options.forwardMainErrors !== false) {
    const onError = (error: Error): void => {
      try {
        const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
        if (!target || target.isDestroyed()) return;
        target.webContents.send(CHANNELS.mainError, describeError(error));
      } catch {
        /* the app is already failing; this must not add to it */
      }
    };
    process.on('uncaughtExceptionMonitor', onError);
    cleanup.push(() => process.removeListener('uncaughtExceptionMonitor', onError));
  }

  return { dispose: () => { for (const undo of cleanup.splice(0).reverse()) undo(); } };
}

/** What crosses to the window: plain strings, since an Error does not survive structured cloning whole. */
export function describeError(error: unknown): MainErrorMessage {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, ...(error.stack ? { stack: error.stack } : {}) };
  }
  return { message: String(error) };
}

/**
 * Asks every page to flush and waits for all of them, or for the timeout.
 *
 * A page with no recorder (or no preload) never answers; the timeout is what
 * keeps that from holding quitting up for longer than it was allowed to.
 */
export function flushAll(targets: readonly WebContents[], timeoutMs: number): Promise<void> {
  const live = targets.filter((contents) => !contents.isDestroyed());
  if (live.length === 0) return Promise.resolve();

  return new Promise<void>((resolve) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const waiting = new Set(live.map((contents) => contents.id));
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ipcMain.removeListener(CHANNELS.flushed, onFlushed);
      resolve();
    };
    const onFlushed = (event: Electron.IpcMainEvent, answered: unknown): void => {
      if (answered !== id) return;
      waiting.delete(event.sender.id);
      if (waiting.size === 0) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    ipcMain.on(CHANNELS.flushed, onFlushed);
    for (const contents of live) {
      try {
        contents.send(CHANNELS.flush, id);
      } catch {
        waiting.delete(contents.id);
      }
    }
    if (waiting.size === 0) finish();
  });
}
