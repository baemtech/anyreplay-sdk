import { contextBridge, ipcRenderer } from 'electron';
import { BRIDGE_KEY, CHANNELS, type AnyReplayBridge, type AppInfo, type MainErrorMessage } from './bridge.js';

/**
 * Exposes `window.anyreplayElectron` to the page. Call it once from your
 * preload script:
 *
 * ```ts
 * // preload.ts
 * import { exposeAnyReplay } from '@anyreplay/electron/preload';
 * exposeAnyReplay();
 * ```
 *
 * Works with `contextIsolation: true` and `sandbox: true` (Electron's
 * defaults) and needs no `nodeIntegration`: it uses only `contextBridge` and
 * `ipcRenderer`, the two modules a sandboxed preload has. A sandboxed preload
 * cannot `import` from `node_modules` at run time, so bundle it (Electron
 * Forge, electron-vite and electron-builder setups all do).
 *
 * With `contextIsolation: false` there is no bridge to cross; the API is put
 * on `window` directly.
 */
export function exposeAnyReplay(): void {
  let flushHandler: (() => Promise<void> | void) | null = null;
  let errorListener: ((error: MainErrorMessage) => void) | null = null;

  ipcRenderer.on(CHANNELS.flush, (_event, id: unknown) => {
    void (async () => {
      try {
        await flushHandler?.();
      } catch {
        /* a failed flush still has to be answered, or quitting waits for the timeout */
      }
      ipcRenderer.send(CHANNELS.flushed, id);
    })();
  });

  ipcRenderer.on(CHANNELS.mainError, (_event, error: MainErrorMessage) => {
    try {
      errorListener?.(error);
    } catch {
      /* never let the recorder break the window */
    }
  });

  const bridge: AnyReplayBridge = {
    version: 1,
    appInfo: async (): Promise<AppInfo> => {
      try {
        return ((await ipcRenderer.invoke(CHANNELS.appInfo)) ?? {}) as AppInfo;
      } catch {
        // No handler: `setupAnyReplay()` was not called in the main process.
        // The renderer falls back to the options it was given.
        return {};
      }
    },
    onFlushRequest: (flush) => { flushHandler = flush; },
    onMainError: (listener) => { errorListener = listener; },
  };

  if (process.contextIsolated) {
    contextBridge.exposeInMainWorld(BRIDGE_KEY, bridge);
  } else {
    (globalThis as unknown as Record<string, unknown>)[BRIDGE_KEY] = bridge;
  }
}
