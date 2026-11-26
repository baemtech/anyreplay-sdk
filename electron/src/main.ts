import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
   *
   * Recorded as fatal (`kind: 'fatal'`, contract §8.3): it marks the session
   * as crashed and, for a window that is not being recorded, cuts a crash clip
   * when the project has them on. With no window to tell, the error is written
   * to `anyreplay-crashes.json` in the app's `userData` folder, synchronously,
   * and handed to the first window that starts recording afterwards — on this
   * launch or the next.
   */
  forwardMainErrors?: boolean;
  /**
   * Report a renderer process that died (`render-process-gone`: crashed,
   * killed, out of memory — anything but a clean exit) as a fatal error, in
   * the session of the next window that starts recording. On by default.
   */
  reportRendererCrashes?: boolean;
}

export interface AnyReplayMainHandle {
  /** Removes every listener and handler this installed. */
  dispose: () => void;
}

const DEFAULT_QUIT_FLUSH_TIMEOUT_MS = 1500;
/** Where crashes wait for a window, in `app.getPath('userData')`. */
export const CRASH_FILE = 'anyreplay-crashes.json';
/** At most this many crashes wait; a crash loop must not grow a file forever. */
const MAX_KEPT_CRASHES = 5;
/** A stack longer than this is clipped before it is written; the window clips it further. */
const MAX_KEPT_STACK = 8000;
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
  const crashes = crashStore();

  // The crashes go to the first window that asks, once.
  ipcMain.handle(CHANNELS.appInfo, (): AppInfo => {
    const waiting = crashes.take();
    return waiting.length > 0 ? { ...info, crashes: waiting } : info;
  });
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
        const message = describeError(error);
        const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
        if (target && !target.isDestroyed() && !target.webContents.isDestroyed()) {
          target.webContents.send(CHANNELS.mainError, message);
          return;
        }
        // No window to tell, and the process may be about to go: on disk, now.
        crashes.keep(message);
      } catch {
        /* the app is already failing; this must not add to it */
      }
    };
    process.on('uncaughtExceptionMonitor', onError);
    cleanup.push(() => process.removeListener('uncaughtExceptionMonitor', onError));
  }

  if (options.reportRendererCrashes !== false) {
    const onGone = (_event: unknown, _contents: unknown, details: { reason?: string; exitCode?: number }): void => {
      try {
        if (!details || details.reason === 'clean-exit') return;
        crashes.keep(rendererGone(details));
      } catch { /* as above */ }
    };
    app.on('render-process-gone', onGone as never);
    cleanup.push(() => app.removeListener('render-process-gone', onGone as never));
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

/** A renderer process that died, as the error its next window records. */
export function rendererGone(details: { reason?: string; exitCode?: number }): MainErrorMessage {
  const reason = typeof details.reason === 'string' ? details.reason : 'unknown';
  const code = typeof details.exitCode === 'number' ? ` (exit code ${details.exitCode})` : '';
  return { name: 'RenderProcessGone', message: `The window's renderer process is gone: ${reason}${code}` };
}

/**
 * Crashes waiting for a window: in memory, and in a small file in `userData`
 * written synchronously, so one that the process does not survive is still
 * there on the next launch. Every failure here is silent — the app is
 * already crashing.
 */
export function crashStore(dir: () => string = () => app.getPath('userData')): {
  keep: (crash: MainErrorMessage) => void;
  take: () => MainErrorMessage[];
} {
  const path = (): string => join(dir(), CRASH_FILE);
  let waiting: MainErrorMessage[] = [];
  try {
    const stored = JSON.parse(readFileSync(path(), 'utf8')) as unknown;
    if (Array.isArray(stored)) {
      waiting = stored.filter((c): c is MainErrorMessage => typeof c?.message === 'string').slice(-MAX_KEPT_CRASHES);
    }
  } catch { /* none, or unreadable */ }

  return {
    keep: (crash) => {
      const clipped = crash.stack && crash.stack.length > MAX_KEPT_STACK
        ? { ...crash, stack: crash.stack.slice(0, MAX_KEPT_STACK) }
        : crash;
      waiting = [...waiting, clipped].slice(-MAX_KEPT_CRASHES);
      try { writeFileSync(path(), JSON.stringify(waiting)); } catch { /* memory still has it */ }
    },
    take: () => {
      const taken = waiting;
      waiting = [];
      if (taken.length > 0) {
        try { unlinkSync(path()); } catch { /* already gone */ }
      }
      return taken;
    },
  };
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
