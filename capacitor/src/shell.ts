import {
  createRecorder, type AnyReplayOptions, type RecorderHandle, type RecorderStatus, type ShellInfo,
} from '@anyreplay/browser';

/**
 * The part of an app-shell SDK that is the same in every shell.
 *
 * `@anyreplay/capacitor` and `@anyreplay/cordova` differ only in how they
 * reach the native side; what they do with it is this file. The recording
 * itself is `@anyreplay/browser`'s, untouched (docs/SDK-CONTRACT.md §1, §4):
 * this adds what a page cannot know or cannot keep on its own —
 *
 * - **who the app is**: its bundle id or package name as the `appId`, its
 *   version and the device model, read natively;
 * - **storage that survives**: WKWebView may purge a web view's
 *   `localStorage` under storage pressure, and a relaunch starts with an
 *   empty `sessionStorage`. Every `anyreplay.*` key of both is mirrored into
 *   native storage and restored before the recorder starts, so the visitor
 *   id outlives a purge and a relaunch within 30 minutes resumes the session
 *   (contract §3.2, §9.2);
 * - **the app's lifecycle**: a web view is suspended with the app, and
 *   `pagehide` never fires, so the app's own pause flushes (contract §10.7);
 * - **assets inline** by default, because an app's files live at addresses
 *   no reviewer can load (contract §9.1).
 */

/** What the native side knows about the app. Every field may be missing. */
export interface AppInfo {
  appId?: string;
  appVersion?: string;
  deviceModel?: string;
}

/** How a shell reaches its native side. Every method may reject; none is required to exist. */
export interface NativeBridge {
  info(): Promise<AppInfo>;
  /** The mirrored keys, as written by `writeState`, or null. */
  readState(): Promise<string | null>;
  writeState(value: string | null): Promise<void>;
  onPause(listener: () => void): void;
  onResume(listener: () => void): void;
  /** The pause flush is done; iOS ends the background task that kept the app awake for it. */
  pauseHandled?(): void;
}

export interface ShellConfig {
  platform: 'capacitor' | 'cordova';
  sdk: { name: string; version: string };
  /** Undefined where there is no native side (the app running in a desktop browser during development). */
  native: () => NativeBridge | undefined;
  /** How often changed keys are copied to native storage. */
  syncIntervalMs?: number;
}

export interface IdentifyTraits {
  userId?: string;
  email?: string;
}

/**
 * The recorder an app talks to.
 *
 * `init` is asynchronous (it asks the native side first). Everything else may
 * be called before it has finished — `consent(true)` on the next line, a
 * `track` during boot — and is applied, in order, the moment the recorder
 * exists. A second `init` is ignored, so a hot reload does not start a second
 * recorder.
 */
export interface AppRecorder {
  init(options: AnyReplayOptions): Promise<void>;
  consent(granted: boolean): void;
  identify(traits: IdentifyTraits): void;
  track(name: string, properties?: Record<string, unknown>): void;
  /** Records an error the app caught itself, as the browser SDK's `trackError` does. */
  trackError(error: unknown): void;
  stop(): void;
  flush(): Promise<void>;
  sessionId(): string | null;
  status(): RecorderStatus;
}

const KEY_PREFIX = 'anyreplay.';
/**
 * The session's last-activity time, which every event touches. Copied with
 * the rest, but a change to it alone is not a reason to write: that would be
 * a native write every few seconds for as long as anyone uses the app. It is
 * written on every pause, which is when it matters.
 */
const VOLATILE_KEY = 'anyreplay.sts';
const STATE_VERSION = 1;

interface MirroredState {
  v: number;
  local: Record<string, string>;
  session: Record<string, string>;
}

function keysOf(storage: () => Storage | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const store = storage();
    if (!store) return out;
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (key && key.startsWith(KEY_PREFIX)) {
        const value = store.getItem(key);
        if (value !== null) out[key] = value;
      }
    }
  } catch {
    /* storage that throws is storage with nothing in it */
  }
  return out;
}

const local = (): Storage | undefined => globalThis.localStorage;
const session = (): Storage | undefined => globalThis.sessionStorage;

/**
 * Puts mirrored keys back into a web storage that has none of ours.
 *
 * All or nothing per storage: a storage that still holds any `anyreplay.*`
 * key is the live one, and mixing an older copy into it would pair a visitor
 * with a session or a chunk number that are not theirs.
 */
function restoreInto(storage: () => Storage | undefined, saved: Record<string, string> | undefined): void {
  if (!saved || Object.keys(keysOf(storage)).length > 0) return;
  try {
    const store = storage();
    for (const [key, value] of Object.entries(saved)) {
      if (key.startsWith(KEY_PREFIX) && typeof value === 'string') store?.setItem(key, value);
    }
  } catch {
    /* nothing to restore into */
  }
}

export function parseState(raw: string | null | undefined): MirroredState | undefined {
  if (!raw) return undefined;
  try {
    const state = JSON.parse(raw) as Partial<MirroredState>;
    if (state.v !== STATE_VERSION || typeof state.local !== 'object' || typeof state.session !== 'object') return undefined;
    return { v: STATE_VERSION, local: state.local ?? {}, session: state.session ?? {} };
  } catch {
    return undefined;
  }
}

export function createAppRecorder(config: ShellConfig): AppRecorder {
  let handle: RecorderHandle | undefined;
  let starting: Promise<void> | undefined;
  let native: NativeBridge | undefined;
  const waiting: ((recorder: RecorderHandle) => void)[] = [];
  /** What was last written, without the volatile key, so an unchanged state is not written again. */
  let written: string | undefined;

  const sync = async (force = false): Promise<void> => {
    if (!native) return;
    const state: MirroredState = { v: STATE_VERSION, local: keysOf(local), session: keysOf(session) };
    const { [VOLATILE_KEY]: _volatile, ...stableSession } = state.session;
    const stable = JSON.stringify([state.local, stableSession]);
    if (!force && stable === written) return;
    written = stable;
    const empty = Object.keys(state.local).length === 0 && Object.keys(state.session).length === 0;
    try {
      await native.writeState(empty ? null : JSON.stringify(state));
    } catch {
      /* best effort: the next sync tries again */
      written = undefined;
    }
  };

  /** Runs now when the recorder exists, or the moment it does. */
  const withRecorder = (fn: (recorder: RecorderHandle) => void): void => {
    if (handle) fn(handle);
    else waiting.push(fn);
  };

  const start = async (options: AnyReplayOptions): Promise<void> => {
    native = config.native();
    let info: AppInfo = {};
    if (native) {
      try { info = (await native.info()) ?? {}; } catch { /* the page's own options still apply */ }
      try {
        const saved = parseState(await native.readState());
        restoreInto(local, saved?.local);
        restoreInto(session, saved?.session);
      } catch {
        /* a first launch, or storage that cannot be read */
      }
    }

    const shell: ShellInfo = {
      platform: config.platform,
      sdk: config.sdk,
      ...(info.appVersion ? { appVersion: info.appVersion } : {}),
      ...(info.deviceModel ? { deviceModel: info.deviceModel } : {}),
    };
    try {
      handle = createRecorder({
        // Inline unless the app says otherwise: its files are at addresses only it can load.
        assets: 'inline',
        ...options,
        ...(options.appId === undefined && info.appId ? { appId: info.appId } : {}),
      }, shell);
    } catch (error) {
      // A wrong project key or option is the installer's to fix, and never a
      // reason to take the app down with it.
      console.error(error instanceof Error ? error.message : error);
      waiting.length = 0;
      return;
    }

    const recorder = handle;
    for (const fn of waiting.splice(0)) fn(recorder);

    if (!native) return;
    const bridge = native;
    void sync(true);
    const timer = setInterval(() => { void sync(); }, config.syncIntervalMs ?? 3000);
    (timer as unknown as { unref?: () => void }).unref?.();
    bridge.onPause(() => {
      void recorder.flush()
        .catch(() => undefined)
        .then(() => sync(true))
        .finally(() => bridge.pauseHandled?.());
    });
    // Back in front: anything that failed while the app was away is retried now.
    bridge.onResume(() => { void recorder.flush().catch(() => undefined); });
  };

  return {
    init: (options) => {
      starting ??= start(options);
      return starting;
    },
    consent: (granted) => withRecorder((recorder) => {
      recorder.consent(granted);
      // A refusal removes the stored ids; the native copy has to go with them.
      void sync(!granted);
    }),
    identify: (traits) => withRecorder((recorder) => recorder.identify(traits)),
    track: (name, properties) => withRecorder((recorder) => recorder.track(name, properties)),
    trackError: (error) => withRecorder((recorder) => recorder.trackError(error)),
    stop: () => withRecorder((recorder) => {
      recorder.stop();
      void sync(true);
    }),
    flush: async () => {
      await starting;
      await handle?.flush();
      await sync();
    },
    sessionId: () => handle?.sessionId() ?? null,
    status: () => handle?.status() ?? 'idle',
  };
}
