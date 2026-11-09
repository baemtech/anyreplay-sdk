import type { AnyReplayNativeOptions } from './config.js';

/**
 * Which app this is, read from the app itself when `init` was not told.
 *
 * Ingest admits an app by the `appId` it sends once a project lists allowed
 * domains or apps (contract §2.2). An app that left it out installed cleanly
 * and recorded nothing — the AnyReplay app itself did, on a real phone. So the
 * SDK reads the bundle id / package name and the version from a native module
 * the app already has, without depending on any of them:
 *
 * 1. `expo-application` (`ExpoApplication`: `applicationId`,
 *    `nativeApplicationVersion`) — what the OS says about the running binary.
 * 2. `react-native-device-info` (`RNDeviceInfo`: `bundleId`, `appVersion`) —
 *    the same, for bare apps.
 * 3. `expo-constants`' embedded app config (`ExponentConstants.manifest`:
 *    `ios.bundleIdentifier` / `android.package`, `version`) — the config the
 *    build was made from. Last, because a bare app's app.json can disagree
 *    with its native project.
 *
 * The native modules are looked up by name — never `require`d — so an app
 * without the package bundles exactly as before: Metro sees no import to
 * resolve, and nothing is added to the app.
 *
 * Expo Go is the exception. There every module above describes Expo Go
 * (`host.exp.exponent`) or a config that is not a build of anything, so
 * nothing is detected: the app sends no `appId` unless `init` names one, as
 * before. An id is never guessed.
 */

export interface DetectedIdentity {
  appId?: string;
  appVersion?: string;
  /** Where the id came from, for the debug log. */
  source?: string;
  /** Running inside Expo Go, where nothing is detected. */
  expoGo?: boolean;
}

/** What the detection reads: the platform, and a native module by name (or nothing). */
export interface IdentityProbe {
  os: string;
  module(name: string): unknown;
}

/** As in config.ts / the server's `APP_ID_PATTERN`. */
const APP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,254}$/;
/** Expo Go's own id on Android (`host.exp.exponent`) and iOS (`host.exp.Exponent`). */
const EXPO_GO_ID = /^host\.exp\.exponent$/i;

type Bag = Record<string, unknown>;

function bag(value: unknown): Bag | null {
  return value !== null && (typeof value === 'object' || typeof value === 'function') ? value as Bag : null;
}

/** A module's constant, as a property or through `getConstants()` (a TurboModule's way). */
function constant(module: Bag | null, key: string): unknown {
  if (!module) return undefined;
  try {
    const direct = module[key];
    if (direct !== undefined && direct !== null) return direct;
    const getConstants = module.getConstants;
    if (typeof getConstants === 'function') return bag((getConstants as () => unknown).call(module))?.[key];
  } catch { /* a module that throws on read has nothing to say */ }
  return undefined;
}

/**
 * A plausible app id: ingest's pattern, with at least one dot. A package name
 * always has one and a bundle id in practice; it also keeps a module's
 * placeholder (`unknown`) out.
 */
export function plausibleAppId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const id = value.trim();
  return APP_ID_PATTERN.test(id) && id.includes('.') && !EXPO_GO_ID.test(id) ? id : undefined;
}

function plausibleVersion(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const version = value.trim();
  return version && version.length <= 40 && version.toLowerCase() !== 'unknown' ? version : undefined;
}

function embeddedConfig(constants: Bag | null): Bag | null {
  const manifest = constant(constants, 'manifest');
  // Android hands it over as JSON text, iOS as an object.
  if (typeof manifest === 'string') {
    try { return bag(JSON.parse(manifest)); } catch { return null; }
  }
  return bag(manifest);
}

/** Reads the app's id and version through `probe`. Never throws. */
export function detectAppIdentity(probe: IdentityProbe): DetectedIdentity {
  const find = (name: string): Bag | null => {
    try { return bag(probe.module(name)); } catch { return null; }
  };
  const constants = find('ExponentConstants');
  const application = find('ExpoApplication');

  const environment = constant(constants, 'executionEnvironment');
  const ownership = constant(constants, 'appOwnership');
  const hostId = constant(application, 'applicationId');
  if (environment === 'storeClient' || ownership === 'expo' || (typeof hostId === 'string' && EXPO_GO_ID.test(hostId.trim()))) {
    return { expoGo: true };
  }

  const config = embeddedConfig(constants);
  const platformConfig = bag(config?.[probe.os === 'ios' ? 'ios' : 'android']);
  const candidates: { source: string; id: unknown; version: unknown }[] = [
    { source: 'expo-application', id: hostId, version: constant(application, 'nativeApplicationVersion') },
    (() => {
      const deviceInfo = find('RNDeviceInfo');
      return { source: 'react-native-device-info', id: constant(deviceInfo, 'bundleId'), version: constant(deviceInfo, 'appVersion') };
    })(),
    {
      source: 'expo-constants',
      id: probe.os === 'ios' || probe.os === 'android'
        ? platformConfig?.[probe.os === 'ios' ? 'bundleIdentifier' : 'package']
        : undefined,
      version: config?.version,
    },
  ];

  const result: DetectedIdentity = {};
  for (const candidate of candidates) {
    const id = plausibleAppId(candidate.id);
    if (!result.appId && id) {
      result.appId = id;
      result.source = candidate.source;
    }
    const version = plausibleVersion(candidate.version);
    if (!result.appVersion && version) result.appVersion = version;
  }
  return result;
}

/**
 * The options with `appId` and `appVersion` filled in from the app where
 * `init` left them out. What `init` was given always wins, and is validated
 * by `resolveOptions` as before. When no id can be found, the options are
 * returned as they came and — in debug — one warning says to pass `appId`.
 */
export function withAppIdentity(
  options: AnyReplayNativeOptions,
  detect: () => DetectedIdentity | undefined,
  warn: (message: string) => void = (message) => console.warn(message),
): AnyReplayNativeOptions {
  if (!options || typeof options !== 'object') return options;
  if (options.appId !== undefined && options.appVersion !== undefined) return options;
  let found: DetectedIdentity = {};
  try { found = detect() ?? {}; } catch { /* nothing detected */ }

  const merged: AnyReplayNativeOptions = { ...options };
  if (options.appId === undefined && found.appId) merged.appId = found.appId;
  if (options.appVersion === undefined && found.appVersion) merged.appVersion = found.appVersion;

  if (merged.appId === undefined && options.debug) {
    warn(found.expoGo
      ? '[anyreplay] running in Expo Go, so the app\'s own id is unknown and no appId is sent. '
        + 'If the project lists allowed domains or apps, pass appId to init (your bundle id or package name), or ingest refuses the session.'
      : '[anyreplay] could not read the app\'s bundle id / package name (install expo-application or react-native-device-info, or pass appId to init). '
        + 'If the project lists allowed domains or apps, ingest refuses sessions without it.');
  }
  return merged;
}
