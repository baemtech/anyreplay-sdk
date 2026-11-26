#ifndef ANYREPLAY_CRASH_H
#define ANYREPLAY_CRASH_H

#ifdef __cplusplus
extern "C" {
#endif

/// Opens the crash file at `path` (created, emptied) and installs the
/// handlers: an uncaught Objective-C exception (NSSetUncaughtExceptionHandler)
/// and the fatal signals SIGABRT, SIGSEGV, SIGBUS, SIGILL, SIGFPE, SIGTRAP.
/// Each chains to what was installed before. A second call does nothing.
/// Returns 0 when the file could not be opened (nothing is installed then).
int anyreplay_crash_install(const char *path);

/// Puts back the handlers that were there before ours, where ours are still
/// the current ones.
void anyreplay_crash_uninstall(void);

#ifdef __cplusplus
}
#endif

#endif
