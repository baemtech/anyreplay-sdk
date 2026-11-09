import {
  createRecorder, type AnyReplayOptions, type RecorderHandle, type RecorderStatus, type ShellInfo,
} from '@anyreplay/browser';

/**
 * What a desktop shell hands the browser SDK: its options, and who is
 * recording (docs/SDK-CONTRACT.md §1, §4) — the platform and SDK the session
 * reports and the app's version. `createRecorder(options, shell)` is how a
 * wrapper names itself without a public option a website could set.
 */
export interface RecorderSetup {
  options: AnyReplayOptions;
  shell: ShellInfo;
}

/**
 * A recorder handle that exists before the recorder does.
 *
 * A shell learns its app id and version asynchronously (an IPC round trip in
 * Electron, a Tauri command), but `init` has to hand something back at once so
 * an app can call `track` on its next line. Calls made in between are queued
 * in order and replayed on the real handle; `flush` waits for it.
 */
export interface DeferredHandle extends RecorderHandle {
  /** Resolves once the recorder has started (or failed to). Never rejects. */
  ready: Promise<void>;
}

type Queued = (handle: RecorderHandle) => void;

/** At most this many calls wait for the app info; enough for a boot sequence. */
const MAX_QUEUED = 64;

export function deferredRecorder(
  start: () => Promise<RecorderSetup | null>,
  onStarted?: (handle: RecorderHandle) => void,
): DeferredHandle {
  let real: RecorderHandle | null = null;
  let stopped = false;
  const queue: Queued[] = [];

  const run = (call: Queued): void => {
    if (real) {
      call(real);
      return;
    }
    if (stopped || queue.length >= MAX_QUEUED) return;
    queue.push(call);
  };

  const ready = start()
    .then((setup) => {
      if (!setup || stopped) return;
      real = createRecorder(setup.options, setup.shell);
      for (const call of queue.splice(0)) call(real);
      onStarted?.(real);
    })
    .catch((error: unknown) => {
      // Nothing this library does may surface as an error in the app.
      if (typeof console !== 'undefined') console.warn('[anyreplay]', error);
    });

  return {
    ready,
    status: (): RecorderStatus => (real ? real.status() : stopped ? 'stopped' : 'idle'),
    sessionId: () => real?.sessionId() ?? null,
    consent: (granted) => run((h) => h.consent(granted)),
    identify: (traits) => run((h) => h.identify(traits)),
    track: (name, properties) => run((h) => h.track(name, properties)),
    trackError: (error) => run((h) => h.trackError(error)),
    stop: () => {
      if (real) real.stop();
      else { stopped = true; queue.length = 0; }
    },
    flush: async () => {
      await ready;
      await real?.flush();
    },
  };
}

/** The browser SDK's app-id rule (`APP_ID_PATTERN`), so a bad id is caught here with a better message. */
export const APP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,254}$/;

/** `meta.appVersion` is at most 40 characters (§2.5). */
export const clipVersion = (version: string | undefined): string | undefined => {
  const trimmed = version?.trim();
  return trimmed ? trimmed.slice(0, 40) : undefined;
};
