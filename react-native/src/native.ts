import { createRecorder, type Host, type IdentifyTraits, type RecorderHandle } from './recorder.js';
import type { AnyReplayNativeOptions } from './config.js';
import { AssetUploader } from './assets.js';
import { resolveOptions } from './config.js';
import { captureTree, currentRootOf, FiberIds, type Fiber, type Measure } from './fiber.js';
import { touchCaptureProps } from './gestures.js';
import { watchAppState, type AppStateLike } from './lifecycle.js';
import { watchNavigation, type RouteReporter } from './navigation.js';
import type { Rect } from './tree.js';

/**
 * The React Native binding.
 *
 * Everything platform-specific lives here, reached through `require` at call
 * time rather than `import` at module time. That is deliberate: the rest of the
 * package must load in a plain Node process so it can be tested without a
 * simulator, and a top-level `import 'react-native'` would make that
 * impossible. Every `require` names its module literally, because Metro only
 * bundles what it can see statically.
 *
 * How the screen is read
 * ----------------------
 * `<AnyReplay>` hands its view to `registerRoot`. From that view's public
 * instance the binding reaches the fiber React committed for it, climbs to the
 * root, and walks the whole committed tree on each tick (see `fiber.ts`).
 * Geometry comes from Fabric's `measureInWindow`, which the New Architecture
 * answers synchronously from the shadow tree — no bridge round trip, no layout
 * callbacks injected into the app's components.
 */

let recorder: RecorderHandle | null = null;
/**
 * A consent decision made before `init` finished.
 *
 * `init` is asynchronous — it waits for the app's storage — and the natural
 * place to call `consent` is the line after it. Dropping a decision that
 * arrives in that gap would mean a person who accepted is not recorded, or
 * worse, one who refused is. Only the latest decision matters, so this is a
 * value rather than a queue.
 */
let pendingConsent: boolean | null = null;
/** Traits given to `identify` before `init` finished, handed over with the consent decision. */
let pendingTraits: IdentifyTraits | null = null;
let rootInstance: unknown = null;
let warnedUnsupported = false;
let warnedUnmounted = false;
/** Ticks in a row without a mounted `<AnyReplay>`. The first few are normal: init runs before React mounts. */
let ticksWithoutRoot = 0;
const UNMOUNTED_WARN_AFTER_TICKS = 10;

/** Called by `<AnyReplay>` with its view, and with null when it unmounts. */
export function registerRoot(instance: unknown): void {
  rootInstance = instance;
}

interface FabricUIManager {
  measureInWindow(node: unknown, callback: (x: number, y: number, width: number, height: number) => void): void;
}

function fabricMeasure(): Measure | null {
  const ui = (globalThis as { nativeFabricUIManager?: FabricUIManager }).nativeFabricUIManager;
  if (!ui || typeof ui.measureInWindow !== 'function') return null;
  return (fiber: Fiber) => {
    const node = (fiber.stateNode as { node?: unknown } | null)?.node;
    if (!node) return null;
    let rect = null as Rect | null;
    // Synchronous: the host function calls back before it returns.
    ui.measureInWindow(node, (x, y, width, height) => { rect = { x, y, width, height }; });
    return rect;
  };
}

interface Xhr {
  open(method: string, url: string): void;
  send(): void;
  responseType: string;
  readonly status: number;
  readonly response: unknown;
  onload: (() => void) | null;
  onerror: (() => void) | null;
}

/** An asset's bytes. XHR rather than fetch: its arraybuffer response works on every React Native version. */
function readBytes(uri: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const Request = (globalThis as unknown as { XMLHttpRequest: new () => Xhr }).XMLHttpRequest;
    const xhr = new Request();
    xhr.open('GET', uri);
    xhr.responseType = 'arraybuffer';
    // Local files report status 0 on some platforms.
    xhr.onload = () => ((xhr.status === 200 || xhr.status === 0) && xhr.response
      ? resolve(new Uint8Array(xhr.response as ArrayBuffer))
      : reject(new Error(`status ${xhr.status}`)));
    xhr.onerror = () => reject(new Error('read failed'));
    xhr.send();
  });
}

function buildHost(options: AnyReplayNativeOptions): Host {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const RN = require('react-native') as {
    Dimensions: { get(dim: string): { width: number; height: number } };
    Platform: { OS: string; Version: string | number; constants?: { Model?: string } };
    NativeModules?: Record<string, { localeIdentifier?: string } | undefined>;
  };

  const ids = new FiberIds();
  // Read from the resolved options rather than from the raw input a second
  // time: one place decides what each switch means, and the capture cannot
  // drift from what `resolveOptions` documented.
  const resolved = resolveOptions(options);
  const { maskAllInputs, maskAllTyping, maskTestID, maskImages } = resolved;
  const uploader = maskImages ? null : new AssetUploader({
    ingestUrl: resolved.ingestUrl,
    projectKey: resolved.projectKey,
    fetch: (...args) => fetch(...args),
    readBytes,
    store: options.storage,
    debug: options.debug,
  });

  return {
    now: () => Date.now(),
    screen: () => RN.Dimensions.get('window'),
    platform: () => ({
      os: RN.Platform.OS,
      version: String(RN.Platform.Version),
      model: RN.Platform.constants?.Model,
    }),
    locale: () => {
      try {
        const locale = Intl.DateTimeFormat().resolvedOptions().locale;
        if (locale) return locale;
      } catch { /* an engine without Intl */ }
      const settings = RN.NativeModules?.SettingsManager as { settings?: { AppleLocale?: string } } | undefined;
      const ios = settings?.settings?.AppleLocale;
      const android = RN.NativeModules?.I18nManager?.localeIdentifier;
      return (ios ?? android)?.replace('_', '-');
    },
    snapshot: () => {
      const measure = fabricMeasure();
      if (!measure) {
        if (!warnedUnsupported) {
          warnedUnsupported = true;
          console.warn('[anyreplay] recording needs the New Architecture (Fabric); nothing will be captured');
        }
        return null;
      }
      const fiber = (rootInstance as { __internalInstanceHandle?: Fiber } | null)?.__internalInstanceHandle;
      const root = currentRootOf(fiber);
      if (!root) {
        ticksWithoutRoot += 1;
        if (options.debug && !warnedUnmounted && ticksWithoutRoot >= UNMOUNTED_WARN_AFTER_TICKS) {
          warnedUnmounted = true;
          console.warn('[anyreplay] <AnyReplay> is not mounted; wrap the app in it to record the screen');
        }
        return null;
      }
      ticksWithoutRoot = 0;
      try {
        return captureTree(root, ids, {
          measure, screen: RN.Dimensions.get('window'), maskAllInputs, maskAllTyping, maskTestID, maskImages,
          assetFor: uploader ? (uri) => uploader.hashFor(uri) : undefined,
        });
      } catch (error) {
        if (options.debug) console.warn('[anyreplay] could not read the screen', error);
        return null;
      }
    },
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    fetch: (...args) => fetch(...args),
  };
}

/**
 * Starts recording.
 *
 * Safe to call more than once; the second call is ignored rather than starting
 * a second recorder, because a hot reload during development would otherwise
 * quietly double every session.
 */
export async function init(
  options: AnyReplayNativeOptions,
  /** A platform other than React Native — tests, and the next platform. */
  host?: Host,
): Promise<RecorderHandle | null> {
  if (recorder) return recorder;
  try {
    // A refusal that arrived before the recorder exists must keep it from ever
    // starting — so it is created waiting, and then told no. A decision that
    // changes while storage is being read is read again once it has been.
    const gated = pendingConsent === false ? { ...options, requireConsent: true } : options;
    const created = await createRecorder(gated, host ?? buildHost(options));
    recorder = created;
    if (pendingConsent !== null) {
      created.consent(pendingConsent);
      pendingConsent = null;
    }
    if (pendingTraits) {
      created.identify(pendingTraits);
      pendingTraits = null;
    }

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const RN = (host ? {} : require('react-native')) as { AppState?: AppStateLike };
    if (RN.AppState) {
      detachAppState = watchAppState(RN.AppState, {
        // The only chance to send the tail. After this the thread may be
        // frozen, and on iOS often is within a second or two.
        onLeaving: () => { void recorder?.flush(); },
      });
    }

    return recorder;
  } catch (error) {
    // Nothing this library does may surface as a crash in the host app. An app
    // that will not start is infinitely worse than a session that is not
    // recorded.
    if (typeof console !== 'undefined') console.warn('[anyreplay]', error);
    return null;
  }
}

let detachAppState: (() => void) | null = null;
let detachNavigation: (() => void) | null = null;

export function stop(): void {
  detachAppState?.(); detachAppState = null;
  detachNavigation?.(); detachNavigation = null;
  recorder?.stop();
  recorder = null;
  pendingConsent = null;
  pendingTraits = null;
}

/**
 * Follows a react-navigation container, so screens are recorded without the
 * app calling `screen()` by hand.
 *
 * ```tsx
 * <NavigationContainer ref={(ref) => { if (ref) trackNavigation(ref); }}>
 * ```
 */
export function trackNavigation(container: RouteReporter): () => void {
  detachNavigation?.();
  detachNavigation = watchNavigation(container, (name) => recorder?.screen(name));
  return () => { detachNavigation?.(); detachNavigation = null; };
}

/**
 * The props that make a view report every touch that passes through it.
 *
 * Spread onto a view wrapping the app. Every handler declines the responder
 * role, so the touch continues to whatever the person meant to press.
 */
export function touchProps(): Record<string, unknown> {
  return touchCaptureProps((x, y) => recorder?.touch(x, y));
}
/** Grants or withdraws consent. Safe to call before `init` has finished: the decision is applied the moment it does. */
export function consent(granted: boolean): void {
  if (recorder) recorder.consent(granted);
  else pendingConsent = granted;
}
/** Attaches an identity to the session. Safe to call before `init` has finished, or before consent: the traits wait until there is a session. */
export function identify(traits: IdentifyTraits): void {
  if (recorder) recorder.identify(traits);
  else pendingTraits = traits;
}
export function screen(name: string): void { recorder?.screen(name); }
export async function flush(): Promise<void> { await recorder?.flush(); }
export function getSessionId(): string | null { return recorder?.sessionId() ?? null; }
