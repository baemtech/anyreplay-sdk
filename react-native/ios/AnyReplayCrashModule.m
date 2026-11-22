#import <React/RCTBridgeModule.h>

#import "AnyReplayCrashKeeper.h"

/**
 * `AnyReplayCrash`: what @anyreplay/react-native asks the native side about
 * crashes in the app's own Objective-C and Swift code (see
 * AnyReplayCrashKeeper.h, which installs itself when the app's binary loads).
 *
 * A classic module, so it works on the old architecture and, through React
 * Native's interop layer, on the new one.
 */
@interface AnyReplayCrashModule : NSObject <RCTBridgeModule>
@end

@implementation AnyReplayCrashModule

RCT_EXPORT_MODULE(AnyReplayCrash)

+ (BOOL)requiresMainQueueSetup {
    return NO;
}

/** The crash the previous launch wrote down (the file's text), or null. Deleted once read. */
RCT_EXPORT_METHOD(takeNativeCrash:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
    NSString *record = AnyReplayCrashKeeperTake();
    resolve(record ?: (id)[NSNull null]);
}

/** Switches the handlers on again after `uninstall` (the recorder was started again). */
RCT_EXPORT_METHOD(install) {
    AnyReplayCrashKeeperInstall();
}

/** The recorder was stopped: crashes are no longer written down. */
RCT_EXPORT_METHOD(uninstall) {
    AnyReplayCrashKeeperUninstall();
}

@end
