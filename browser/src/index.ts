export { createRecorder, type RecorderHandle, type RecorderStatus } from './recorder.js';
export { resolveOptions, ConfigError, DEFAULTS, type AnyReplayOptions, type ResolvedOptions } from './config.js';
export { isSampledIn, hashToUnitInterval } from './sampling.js';
export { Transport, type RecordedEvent, type SessionMeta } from './transport.js';
export { resolveIdentity, forgetVisitor, safeStorage, uuidv4 } from './visitor.js';
export { TRACK_TAG, NAVIGATE_TAG, EVENT_NAME_PATTERN, MAX_PROPERTIES_BYTES, validateTrack, type TrackPayload } from './events.js';
export {
  ERROR_TAG, CONSOLE_TAG, NETWORK_TAG, LIMITS, REDACTED, redactText, redactUrl,
  errorPayload, consolePayload, startDiagnostics,
  type ErrorPayload, type ConsolePayload, type NetworkPayload, type DiagnosticsHandle,
} from './diagnostics.js';
