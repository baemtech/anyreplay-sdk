#import "AnyReplayCrashKeeper.h"

#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

// See AnyReplayCrashKeeper.h. The file layout, in Application Support/anyreplay:
//
//   anyreplay-native-crash.json       this launch's record, opened (empty) at
//                                     install so a signal handler only has to
//                                     write() into it
//   anyreplay-native-crash.prev.json  the previous launch's record, moved
//                                     aside at install; what Take returns
//   anyreplay-clip-ring.json          an app shell's crash clip ring

static NSString *const AnyReplayCrashFile = @"anyreplay-native-crash.json";
static NSString *const AnyReplayPreviousFile = @"anyreplay-native-crash.prev.json";
static NSString *const AnyReplayRingFile = @"anyreplay-clip-ring.json";

#define ANYREPLAY_SIGNAL_COUNT 6
static const int AnyReplaySignals[ANYREPLAY_SIGNAL_COUNT] = { SIGABRT, SIGSEGV, SIGBUS, SIGILL, SIGFPE, SIGTRAP };
static struct sigaction AnyReplayPreviousActions[ANYREPLAY_SIGNAL_COUNT];
static BOOL AnyReplaySignalInstalled[ANYREPLAY_SIGNAL_COUNT];

/** The record's file descriptor, open from install on. */
static int AnyReplayCrashFd = -1;
/** Set while crashes are written down. */
static volatile sig_atomic_t AnyReplayEnabled = 0;
/** Set once something has been written this launch: an NSException is followed by SIGABRT, which must not overwrite it. */
static volatile sig_atomic_t AnyReplayWritten = 0;
static BOOL AnyReplayExceptionInstalled = NO;
static NSUncaughtExceptionHandler *AnyReplayPreviousExceptionHandler = NULL;
static NSString *AnyReplayDirectory = nil;
static NSObject *AnyReplayLock = nil;

static void AnyReplayHandleSignal(int signo, siginfo_t *info, void *context);
static void AnyReplayHandleException(NSException *exception);

/* ------------------------------------------------------------ files -- */

static NSString *AnyReplayDirectoryPath(void) {
    NSURL *base = [[NSFileManager defaultManager] URLsForDirectory:NSApplicationSupportDirectory
                                                         inDomains:NSUserDomainMask].firstObject;
    if (!base) return nil;
    NSURL *dir = [base URLByAppendingPathComponent:@"anyreplay" isDirectory:YES];
    [[NSFileManager defaultManager] createDirectoryAtURL:dir withIntermediateDirectories:YES attributes:nil error:NULL];
    // Device-local state: nothing here belongs in an iCloud backup.
    [dir setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:NULL];
    return dir.path;
}

/**
 * Once per process: moves the previous launch's record aside and opens an
 * empty file for this launch's, so a signal handler finds a descriptor ready.
 */
static void AnyReplayPrepareFiles(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        AnyReplayLock = [NSObject new];
        NSString *dir = AnyReplayDirectoryPath();
        if (!dir) return;
        AnyReplayDirectory = dir;
        NSString *current = [dir stringByAppendingPathComponent:AnyReplayCrashFile];
        NSString *previous = [dir stringByAppendingPathComponent:AnyReplayPreviousFile];
        NSDictionary *attributes = [[NSFileManager defaultManager] attributesOfItemAtPath:current error:NULL];
        if (attributes && attributes.fileSize > 0) {
            // A crash last time (or before it, never read yet): kept for Take.
            rename(current.fileSystemRepresentation, previous.fileSystemRepresentation);
        }
        AnyReplayCrashFd = open(current.fileSystemRepresentation, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
    });
}

static NSString *AnyReplayReadAndDelete(NSString *name) {
    if (!AnyReplayDirectory) return nil;
    NSString *path = [AnyReplayDirectory stringByAppendingPathComponent:name];
    NSData *data = [NSData dataWithContentsOfFile:path];
    [[NSFileManager defaultManager] removeItemAtPath:path error:NULL];
    if (data.length == 0) return nil;
    return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
}

/* ------------------------------------------------------- the record -- */

/** Appends the decimal digits of `value` to `buffer` at `*at`; no allocation, no locale. */
static void AnyReplayAppendNumber(char *buffer, size_t size, size_t *at, long long value) {
    char digits[24];
    size_t n = 0;
    BOOL negative = value < 0;
    unsigned long long rest = negative ? (unsigned long long)(-(value + 1)) + 1 : (unsigned long long)value;
    do {
        digits[n++] = (char)('0' + (rest % 10));
        rest /= 10;
    } while (rest > 0 && n < sizeof(digits));
    if (negative && *at < size) buffer[(*at)++] = '-';
    while (n > 0 && *at < size) buffer[(*at)++] = digits[--n];
}

static void AnyReplayAppendText(char *buffer, size_t size, size_t *at, const char *text) {
    while (*text && *at < size) buffer[(*at)++] = *text++;
}

/**
 * A fatal signal. Async-signal-safe: no allocation, no Objective-C or Swift,
 * no locks — `clock_gettime`, `write`, `sigaction` and `raise` only, into a
 * descriptor opened at install. The line it writes is
 * `SIG\t<signo>\t<epoch seconds>\n`.
 */
static void AnyReplayHandleSignal(int signo, siginfo_t *info, void *context) {
    if (AnyReplayEnabled && !AnyReplayWritten && AnyReplayCrashFd >= 0) {
        AnyReplayWritten = 1;
        char line[64];
        size_t at = 0;
        struct timespec now;
        long long seconds = clock_gettime(CLOCK_REALTIME, &now) == 0 ? (long long)now.tv_sec : (long long)time(NULL);
        AnyReplayAppendText(line, sizeof(line), &at, "SIG\t");
        AnyReplayAppendNumber(line, sizeof(line), &at, signo);
        AnyReplayAppendText(line, sizeof(line), &at, "\t");
        AnyReplayAppendNumber(line, sizeof(line), &at, seconds);
        AnyReplayAppendText(line, sizeof(line), &at, "\n");
        ssize_t ignored = write(AnyReplayCrashFd, line, at);
        (void)ignored;
    }

    // The handler that was there before: the app's crash reporter.
    int index = -1;
    for (int i = 0; i < ANYREPLAY_SIGNAL_COUNT; i++) {
        if (AnyReplaySignals[i] == signo) { index = i; break; }
    }
    if (index >= 0) {
        struct sigaction *previous = &AnyReplayPreviousActions[index];
        if (previous->sa_flags & SA_SIGINFO) {
            if ((void *)previous->sa_sigaction != (void *)SIG_DFL && (void *)previous->sa_sigaction != (void *)SIG_IGN
                && previous->sa_sigaction != AnyReplayHandleSignal) {
                previous->sa_sigaction(signo, info, context);
            }
        } else if (previous->sa_handler != SIG_DFL && previous->sa_handler != SIG_IGN) {
            previous->sa_handler(signo);
        }
    }

    // Then the default action: the process ends as it would have without us.
    // Raised now, delivered when this handler returns (the signal is blocked
    // while it runs); a fault re-raises itself on return in any case.
    struct sigaction fallback;
    memset(&fallback, 0, sizeof(fallback));
    fallback.sa_handler = SIG_DFL;
    sigemptyset(&fallback.sa_mask);
    sigaction(signo, &fallback, NULL);
    raise(signo);
}

static void AnyReplayHandleException(NSException *exception) {
    if (AnyReplayEnabled && !AnyReplayWritten && AnyReplayCrashFd >= 0) {
        // Set first: the abort() that follows an uncaught exception raises
        // SIGABRT, and the signal handler must leave this record alone.
        AnyReplayWritten = 1;
        @try {
            NSString *stack = [exception.callStackSymbols componentsJoinedByString:@"\n"];
            NSDictionary *record = @{
                @"v": @1,
                @"ts": @((long long)([[NSDate date] timeIntervalSince1970] * 1000.0)),
                @"platform": @"ios",
                @"name": exception.name.length > 0 ? exception.name : @"NSException",
                @"message": exception.reason ?: @"",
                @"stack": stack ?: @"",
            };
            NSData *json = [NSJSONSerialization dataWithJSONObject:record options:0 error:NULL];
            if (json.length > 0) {
                ssize_t ignored = pwrite(AnyReplayCrashFd, json.bytes, json.length, 0);
                (void)ignored;
                fsync(AnyReplayCrashFd);
            }
        } @catch (__unused NSException *ignored) {
            // The crash still reaches the app's own handler.
        }
    }
    if (AnyReplayPreviousExceptionHandler) AnyReplayPreviousExceptionHandler(exception);
}

/* -------------------------------------------------------- the API -- */

void AnyReplayCrashKeeperInstall(void) {
    AnyReplayPrepareFiles();
    if (!AnyReplayLock || AnyReplayCrashFd < 0) return;
    @synchronized (AnyReplayLock) {
        AnyReplayEnabled = 1;

        if (!AnyReplayExceptionInstalled) {
            AnyReplayPreviousExceptionHandler = NSGetUncaughtExceptionHandler();
            NSSetUncaughtExceptionHandler(&AnyReplayHandleException);
            AnyReplayExceptionInstalled = YES;
        }

        // A stack of its own for the handler on this thread (the main thread,
        // at load), so a stack overflow can still be written down.
        static dispatch_once_t stackOnce;
        dispatch_once(&stackOnce, ^{
            stack_t current;
            if (sigaltstack(NULL, &current) == 0 && (current.ss_flags & SS_DISABLE)) {
                stack_t alternate;
                alternate.ss_size = 64 * 1024;
                alternate.ss_sp = malloc(alternate.ss_size);
                alternate.ss_flags = 0;
                if (alternate.ss_sp) sigaltstack(&alternate, NULL);
            }
        });

        for (int i = 0; i < ANYREPLAY_SIGNAL_COUNT; i++) {
            if (AnyReplaySignalInstalled[i]) continue;
            struct sigaction action;
            memset(&action, 0, sizeof(action));
            action.sa_sigaction = AnyReplayHandleSignal;
            action.sa_flags = SA_SIGINFO | SA_ONSTACK;
            sigemptyset(&action.sa_mask);
            if (sigaction(AnyReplaySignals[i], &action, &AnyReplayPreviousActions[i]) == 0) {
                AnyReplaySignalInstalled[i] = YES;
            }
        }
    }
}

void AnyReplayCrashKeeperUninstall(void) {
    if (!AnyReplayLock) return;
    @synchronized (AnyReplayLock) {
        AnyReplayEnabled = 0;
        // Each one put back only while it is still ours: restoring the old
        // handler over a newer one would cut that one out of every crash.
        if (AnyReplayExceptionInstalled && NSGetUncaughtExceptionHandler() == &AnyReplayHandleException) {
            NSSetUncaughtExceptionHandler(AnyReplayPreviousExceptionHandler);
            AnyReplayPreviousExceptionHandler = NULL;
            AnyReplayExceptionInstalled = NO;
        }
        for (int i = 0; i < ANYREPLAY_SIGNAL_COUNT; i++) {
            if (!AnyReplaySignalInstalled[i]) continue;
            struct sigaction current;
            if (sigaction(AnyReplaySignals[i], NULL, &current) == 0 && (current.sa_flags & SA_SIGINFO)
                && current.sa_sigaction == AnyReplayHandleSignal) {
                sigaction(AnyReplaySignals[i], &AnyReplayPreviousActions[i], NULL);
                AnyReplaySignalInstalled[i] = NO;
            }
        }
    }
}

NSString *AnyReplayCrashKeeperTake(void) {
    AnyReplayPrepareFiles();
    if (!AnyReplayLock) return nil;
    @synchronized (AnyReplayLock) {
        return AnyReplayReadAndDelete(AnyReplayPreviousFile);
    }
}

NSString *AnyReplayCrashKeeperTakeRing(void) {
    AnyReplayPrepareFiles();
    if (!AnyReplayLock) return nil;
    @synchronized (AnyReplayLock) {
        return AnyReplayReadAndDelete(AnyReplayRingFile);
    }
}

void AnyReplayCrashKeeperWriteRing(NSString *value) {
    AnyReplayPrepareFiles();
    if (!AnyReplayLock || !AnyReplayDirectory) return;
    @synchronized (AnyReplayLock) {
        NSString *path = [AnyReplayDirectory stringByAppendingPathComponent:AnyReplayRingFile];
        if (value == nil) {
            [[NSFileManager defaultManager] removeItemAtPath:path error:NULL];
            return;
        }
        // Atomically: a crash mid-write leaves the previous ring, not half of this one.
        [[value dataUsingEncoding:NSUTF8StringEncoding] writeToFile:path atomically:YES];
    }
}

/** Installs at load, before `main`: the earliest a crash can be seen from. */
@interface AnyReplayCrashKeeperLoader : NSObject
@end

@implementation AnyReplayCrashKeeperLoader
+ (void)load {
    AnyReplayCrashKeeperInstall();
}
@end
