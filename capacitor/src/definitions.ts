import type { PluginListenerHandle } from '@capacitor/core';

/**
 * The native half of the plugin: `ios/Sources/AnyReplayPlugin` and
 * `android/src/main/java/com/anyreplay/capacitor`. Deliberately small — the
 * recording happens in the web view; the native side only answers what the
 * web view cannot know or keep.
 */
export interface AnyReplayNativePlugin {
  /** `appId`: bundle id / package name. `appVersion`: the user-visible version. `deviceModel`: `iPhone15,2`, `Google Pixel 8`. */
  getInfo(): Promise<{ appId?: string; appVersion?: string; build?: string; deviceModel?: string }>;
  /** The mirrored `anyreplay.*` keys (UserDefaults / SharedPreferences), or null. */
  readState(): Promise<{ value: string | null }>;
  /** Replaces the mirror; `null` removes it. */
  writeState(options: { value: string | null }): Promise<void>;
  /** The JS side finished its pause flush; iOS ends the background task it began. */
  pauseHandled(): Promise<void>;
  /** The app went to the background (`didEnterBackground` / `onPause`). */
  addListener(eventName: 'pause', listener: () => void): Promise<PluginListenerHandle>;
  /** The app came back (`willEnterForeground` / `onResume`). */
  addListener(eventName: 'resume', listener: () => void): Promise<PluginListenerHandle>;
}
