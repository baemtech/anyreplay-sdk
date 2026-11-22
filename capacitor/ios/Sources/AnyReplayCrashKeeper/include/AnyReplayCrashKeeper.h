#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/**
 * Writes down a crash in the app's own native code, for the next launch to
 * report (docs/SDK-CONTRACT.md §8.3, "Native crashes").
 *
 * Installed when the binary loads (`+load`), so it sees crashes from the
 * first line of `main` on: an uncaught NSException (name, reason, call stack,
 * as JSON) and the fatal signals SIGABRT, SIGSEGV, SIGBUS, SIGILL, SIGFPE and
 * SIGTRAP — a Swift `fatalError` or a force-unwrapped nil is a SIGTRAP. A
 * signal is written as one line, `SIG\t<signo>\t<epoch seconds>\n`, because
 * nothing but `write()` of a buffer prepared in advance is safe inside a
 * signal handler. Both go to `Application Support/anyreplay/
 * anyreplay-native-crash.json`. Every handler chains to the one installed
 * before it, so the app's crash reporter still sees the crash, and a signal
 * then ends the process with its default action.
 *
 * The same file is in @anyreplay/react-native, @anyreplay/capacitor and
 * @anyreplay/cordova.
 */

/** Installs the handlers, or switches them back on; safe to call any number of times. */
FOUNDATION_EXPORT void AnyReplayCrashKeeperInstall(void);

/** Stops writing crashes down; puts the previous handlers back where none has been installed over these since. */
FOUNDATION_EXPORT void AnyReplayCrashKeeperUninstall(void);

/** What the previous launch wrote down (JSON, or the signal line), or nil. Deleted once read. */
FOUNDATION_EXPORT NSString *_Nullable AnyReplayCrashKeeperTake(void);

/** The crash clip ring an app shell keeps for the next launch (contract §8.6), or nil. Deleted once read. */
FOUNDATION_EXPORT NSString *_Nullable AnyReplayCrashKeeperTakeRing(void);

/** Replaces the kept ring; nil removes it. */
FOUNDATION_EXPORT void AnyReplayCrashKeeperWriteRing(NSString *_Nullable value);

NS_ASSUME_NONNULL_END
