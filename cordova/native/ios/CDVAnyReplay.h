#import <Cordova/CDVPlugin.h>

/**
 * The native half of @anyreplay/cordova on iOS: what the web view cannot know
 * or keep. The recording itself happens in JavaScript.
 *
 * - getInfo: bundle id (sent as appId), CFBundleShortVersionString, build
 *   number, hardware model (iPhone15,2).
 * - readState / writeState: one string in NSUserDefaults, a copy of the
 *   recorder's anyreplay.* keys, because WKWebView may purge localStorage.
 */
@interface CDVAnyReplay : CDVPlugin

- (void)getInfo:(CDVInvokedUrlCommand *)command;
- (void)readState:(CDVInvokedUrlCommand *)command;
- (void)writeState:(CDVInvokedUrlCommand *)command;

@end
