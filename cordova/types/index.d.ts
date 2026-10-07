/**
 * The global `AnyReplay` that @anyreplay/cordova installs (plugin.xml
 * `<clobbers target="AnyReplay">`). Available after `deviceready`.
 *
 * Options are those of @anyreplay/browser; see
 * https://anyreplay.com/docs/reference/browser-sdk.
 */

export interface AnyReplayCordovaOptions {
  projectKey: string;
  ingestUrl?: string;
  sampleRate?: number;
  maskAllInputs?: boolean;
  maskAllTyping?: boolean;
  maskClass?: string;
  blockClass?: string;
  requireConsent?: boolean;
  maxEventsPerChunk?: number;
  flushIntervalMs?: number;
  maxConsecutiveFailures?: number;
  recordErrors?: boolean;
  recordConsole?: boolean;
  recordNetwork?: boolean;
  maxSessionsPerMonth?: number;
  /** Defaults to the app's bundle id / package name, read natively. */
  appId?: string;
  /** Defaults to 'inline' in an app. */
  assets?: 'reference' | 'inline';
  debug?: boolean;
}

export type AnyReplayStatus = 'idle' | 'awaiting-consent' | 'recording' | 'sampled-out' | 'stopped';

export interface AnyReplayCordova {
  /** Starts recording. Waits for `deviceready`; a second call is ignored. */
  init(options: AnyReplayCordovaOptions): Promise<void>;
  consent(granted: boolean): void;
  identify(traits: { userId?: string; email?: string }): void;
  track(name: string, properties?: Record<string, unknown>): void;
  /** Records an error the app caught itself. */
  trackError(error: unknown): void;
  stop(): void;
  flush(): Promise<void>;
  sessionId(): string | null;
  status(): AnyReplayStatus;
  readonly SDK_NAME: string;
  readonly SDK_VERSION: string;
}

declare global {
  // eslint-disable-next-line no-var
  var AnyReplay: AnyReplayCordova;
  interface Window {
    AnyReplay: AnyReplayCordova;
  }
}
