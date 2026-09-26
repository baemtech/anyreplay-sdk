import { createRecorder, type RecorderHandle } from './recorder.js';
import type { AnyReplayOptions } from './config.js';

/**
 * The CDN entry point.
 *
 * The snippet defines a stub that queues calls, then loads this bundle
 * asynchronously. Everything the page called before the bundle arrived is
 * replayed here in order, so `init` never races with the script tag.
 */
type QueuedCall = [command: string, ...args: unknown[]];

interface AnyReplayGlobal {
  (command: string, ...args: unknown[]): void;
  q?: QueuedCall[];
}

let handle: RecorderHandle | null = null;

function execute(command: string, ...args: unknown[]): void {
  try {
    switch (command) {
      case 'init':
        if (!handle) handle = createRecorder(args[0] as AnyReplayOptions);
        break;
      case 'consent':
        handle?.consent(args[0] !== false);
        break;
      case 'identify':
        handle?.identify((args[0] ?? {}) as { userId?: string; email?: string });
        break;
      case 'track':
        // `anyreplay('track', 'checkout_started', { cart: 3 })` — the snippet's
        // queue means this works before the bundle has even loaded.
        handle?.track(args[0] as string, args[1] as Record<string, unknown> | undefined);
        break;
      case 'stop':
        handle?.stop();
        break;
      case 'flush':
        void handle?.flush();
        break;
      default:
        // Unknown commands are ignored: a newer snippet must never break an
        // older bundle that a browser has cached.
        break;
    }
  } catch (error) {
    // Nothing this library does may surface as an error in the host page.
    if (typeof console !== 'undefined') console.warn('[anyreplay]', error);
  }
}

function install(): void {
  const globalObject = globalThis as unknown as { anyreplay?: AnyReplayGlobal };
  const queued = globalObject.anyreplay?.q ?? [];

  const api = ((command: string, ...args: unknown[]) => execute(command, ...args)) as AnyReplayGlobal;
  api.q = [];
  globalObject.anyreplay = api;

  for (const call of queued) {
    const [command, ...args] = call;
    execute(command, ...args);
  }
}

install();

export { execute as __execute };
