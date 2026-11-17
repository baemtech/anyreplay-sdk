#import "CDVAnyReplay.h"
#import <UIKit/UIKit.h>
#import <sys/utsname.h>

/** The NSUserDefaults key the mirror lives under (the same as the Capacitor plugin's). */
static NSString *const AnyReplayStateKey = @"anyreplay.state";

@implementation CDVAnyReplay

- (void)getInfo:(CDVInvokedUrlCommand *)command {
    NSBundle *bundle = [NSBundle mainBundle];
    NSMutableDictionary *info = [NSMutableDictionary dictionary];
    if (bundle.bundleIdentifier) info[@"appId"] = bundle.bundleIdentifier;
    id version = [bundle objectForInfoDictionaryKey:@"CFBundleShortVersionString"];
    if ([version isKindOfClass:[NSString class]]) info[@"appVersion"] = version;
    id build = [bundle objectForInfoDictionaryKey:@"CFBundleVersion"];
    if ([build isKindOfClass:[NSString class]]) info[@"build"] = build;
    info[@"deviceModel"] = [CDVAnyReplay hardwareModel];

    CDVPluginResult *result = [CDVPluginResult resultWithStatus:CDVCommandStatus_OK messageAsDictionary:info];
    [self.commandDelegate sendPluginResult:result callbackId:command.callbackId];
}

- (void)readState:(CDVInvokedUrlCommand *)command {
    NSString *value = [[NSUserDefaults standardUserDefaults] stringForKey:AnyReplayStateKey];
    // No message is `undefined` on the JavaScript side, which it reads as "nothing stored".
    CDVPluginResult *result = value
        ? [CDVPluginResult resultWithStatus:CDVCommandStatus_OK messageAsString:value]
        : [CDVPluginResult resultWithStatus:CDVCommandStatus_OK];
    [self.commandDelegate sendPluginResult:result callbackId:command.callbackId];
}

- (void)writeState:(CDVInvokedUrlCommand *)command {
    id value = command.arguments.count > 0 ? command.arguments[0] : nil;
    NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
    // null removes the mirror: that is how a refusal of consent reaches it.
    if ([value isKindOfClass:[NSString class]]) {
        [defaults setObject:value forKey:AnyReplayStateKey];
    } else {
        [defaults removeObjectForKey:AnyReplayStateKey];
    }
    [self.commandDelegate sendPluginResult:[CDVPluginResult resultWithStatus:CDVCommandStatus_OK]
                                callbackId:command.callbackId];
}

/** iPhone15,2 rather than "iPhone"; a simulator reports the model it simulates. */
+ (NSString *)hardwareModel {
#if TARGET_OS_SIMULATOR
    NSString *simulated = NSProcessInfo.processInfo.environment[@"SIMULATOR_MODEL_IDENTIFIER"];
    if (simulated.length > 0) return simulated;
#endif
    struct utsname system;
    uname(&system);
    NSString *machine = [NSString stringWithCString:system.machine encoding:NSUTF8StringEncoding];
    return machine.length > 0 ? machine : [UIDevice currentDevice].model;
}

@end
