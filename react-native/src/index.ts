/**
 * AnyReplay for React Native.
 *
 * ```ts
 * import { init } from '@anyreplay/react-native';
 *
 * init({ projectKey: 'ar_pk_live_…' });
 * ```
 *
 * No native module, no rebuild, works in Expo. The recorder reads what React
 * rendered rather than what the platform drew, which costs a little fidelity —
 * a wireframe, not a screenshot — and buys the thing this product exists for:
 * the words are still words when they arrive, so a session recorded in Turkish
 * can be watched in English.
 */

export {
  init, stop, consent, identify, screen, flush, getSessionId,
  trackNavigation, touchProps, registerRoot,
} from './native.js';
export { captureTree, currentRootOf, FiberIds, type Fiber, type Measure, type CaptureOptions } from './fiber.js';
export { AnyReplay } from './provider.js';
export { touchCaptureProps, type TouchSink } from './gestures.js';
export { watchNavigation, type RouteReporter } from './navigation.js';
export { watchAppState, type AppStateLike } from './lifecycle.js';
export { createRecorder, type Host, type RecorderHandle, type RecorderStatus } from './recorder.js';
export { resolveOptions, ConfigError, DEFAULTS, type AnyReplayNativeOptions } from './config.js';
export { MemoryStore, isSampledIn, resolveIdentity, forgetVisitor, uuidv4, type KeyValueStore } from './session.js';
export { diff, serialise, tagFor, type CapturedElement, type Rect } from './tree.js';
export { fieldValue, isSensitiveField, looksLikeCardNumber } from './masking.js';
export { EVENT, NODE, SOURCE, userAgent, type MobileNode, type MobileTag } from './wire.js';
export { AssetUploader, isBundledAsset, sha256Hex, toBase64, type AssetUploaderDeps } from './assets.js';
