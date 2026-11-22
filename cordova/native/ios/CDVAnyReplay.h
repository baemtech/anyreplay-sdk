#import <Cordova/CDVPlugin.h>

/**
 * The native half of @anyreplay/cordova on iOS: what the web view cannot know
 * or keep. The recording itself happens in JavaScript.
 *
 * - getInfo: bundle id (sent as appId), CFBundleShortVersionString, build
 *   number, hardware model (iPhone15,2).
 * - readState / writeState: one string in NSUserDefaults, a copy of the
 *   recorder's anyreplay.* keys, because WKWebView may purge localStorage.
 * - Native crashes (docs/SDK-CONTRACT.md §8.3): AnyReplayCrashKeeper writes
 *   down an uncaught NSException or a fatal signal (installed when the app's
 *   binary loads); takeNativeCrash hands it to the next launch. With crash
 *   clips, writeClipRing / takeClipRing keep the clip's ring in a file (§8.6).
 */
@interface CDVAnyReplay : CDVPlugin

- (void)getInfo:(CDVInvokedUrlCommand *)command;
- (void)readState:(CDVInvokedUrlCommand *)command;
- (void)writeState:(CDVInvokedUrlCommand *)command;
- (void)takeNativeCrash:(CDVInvokedUrlCommand *)command;
- (void)takeClipRing:(CDVInvokedUrlCommand *)command;
- (void)writeClipRing:(CDVInvokedUrlCommand *)command;
- (void)stopCrashKeeper:(CDVInvokedUrlCommand *)command;

@end
