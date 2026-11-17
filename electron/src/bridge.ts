/**
 * The contract between the three halves of the Electron SDK.
 *
 * The renderer records; the preload script is the only code that can talk to
 * the main process; the main process knows the app's id and version and sees
 * the app quit. They share nothing but these names, so each entry point can be
 * imported on its own without pulling in the others (or the recorder, which
 * has no business in the main process).
 */

/** The global the preload script exposes through `contextBridge`. */
export const BRIDGE_KEY = 'anyreplayElectron';

/** IPC channels. All of them, so a reviewer can see exactly what crosses. */
export const CHANNELS = {
  /** renderer → main (invoke): `AppInfo`. */
  appInfo: 'anyreplay:app-info',
  /** main → renderer: flush now, then answer on `flushed` with the same id. */
  flush: 'anyreplay:flush',
  /** renderer → main: a flush asked for by `flush` has finished. */
  flushed: 'anyreplay:flushed',
  /** main → renderer: an uncaught exception in the main process. */
  mainError: 'anyreplay:main-error',
} as const;

/** What the main process says about the app. */
export interface AppInfo {
  /** The app id (§2.2 of the SDK contract), already checked against the id pattern. Absent when none could be found. */
  appId?: string;
  /** `app.getVersion()`. */
  appVersion?: string;
}

/** An uncaught exception in the main process, as sent to a window. Raw: the renderer redacts it. */
export interface MainErrorMessage {
  name?: string;
  message: string;
  stack?: string;
}

/**
 * What the preload script exposes on `window.anyreplayElectron`.
 *
 * Deliberately narrow: three fixed channels, no generic `send` or `invoke`, so
 * exposing it gives page script no more reach into the main process than
 * asking for the app's version and answering a flush.
 */
export interface AnyReplayBridge {
  /** The bridge's own version, so a newer renderer can tell an older preload apart. */
  readonly version: 1;
  appInfo: () => Promise<AppInfo>;
  /** The renderer's flush; called when the main process is about to quit. Replaces any earlier one. */
  onFlushRequest: (flush: () => Promise<void> | void) => void;
  /** Called with each main-process error forwarded to this window. Replaces any earlier listener. */
  onMainError: (listener: (error: MainErrorMessage) => void) => void;
}
