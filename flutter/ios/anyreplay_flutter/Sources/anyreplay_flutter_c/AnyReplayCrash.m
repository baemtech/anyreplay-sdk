// Keeps a crash in the app's native code for the next launch: an uncaught
// Objective-C exception, or one of the fatal signals (Swift's fatalError, a
// forced unwrap of nil and an index out of range end in SIGTRAP).
//
// The signal handler is async-signal-safe: the file is opened and emptied at
// install time, and at crash time the handler only formats a line into a
// buffer on its own stack and write()s it — no allocation, no Objective-C, no
// locks. The line: "SIG\t<signal number>\t<epoch seconds>\n" (decimal).
//
// The exception handler runs while the runtime still works, so it may use
// Foundation: it writes the JSON record
// {"v":1,"ts":<epoch ms>,"platform":"ios","name":…,"message":…,"stack":…}
// and marks the file written, so the SIGABRT that follows (abort() after an
// uncaught exception) does not overwrite it.
//
// Both chain to whatever was installed before (a crash reporter keeps
// working), and the signal is then raised again with the default action, so
// the process ends exactly as it would have.

#import "AnyReplayCrash.h"

#import <Foundation/Foundation.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#define ANYREPLAY_SIGNAL_COUNT 6
#define ANYREPLAY_MAX_STACK 16000
#define ANYREPLAY_MAX_MESSAGE 2000

static const int anyreplay_signals[ANYREPLAY_SIGNAL_COUNT] = {SIGABRT, SIGSEGV, SIGBUS, SIGILL, SIGFPE, SIGTRAP};
static struct sigaction anyreplay_previous[ANYREPLAY_SIGNAL_COUNT];
static volatile sig_atomic_t anyreplay_has_previous[ANYREPLAY_SIGNAL_COUNT];

static int anyreplay_fd = -1;
static volatile sig_atomic_t anyreplay_written = 0;
static int anyreplay_installed = 0;
// Off after uninstall: a handler of ours still in someone else's chain then only passes the crash on.
static volatile sig_atomic_t anyreplay_enabled = 0;
static volatile sig_atomic_t anyreplay_in_exception = 0;
static NSUncaughtExceptionHandler *anyreplay_previous_exception = NULL;

/* ------------------------------------------------------------ signals -- */

static size_t anyreplay_put_number(char *out, unsigned long long value) {
  char digits[24];
  size_t count = 0;
  do {
    digits[count++] = (char)('0' + (value % 10));
    value /= 10;
  } while (value > 0 && count < sizeof(digits));
  for (size_t i = 0; i < count; i++) out[i] = digits[count - 1 - i];
  return count;
}

static void anyreplay_write_signal(int signo) {
  if (!anyreplay_enabled || anyreplay_written || anyreplay_fd < 0) return;
  anyreplay_written = 1;
  char line[64];
  size_t n = 0;
  line[n++] = 'S';
  line[n++] = 'I';
  line[n++] = 'G';
  line[n++] = '\t';
  n += anyreplay_put_number(line + n, (unsigned long long)signo);
  line[n++] = '\t';
  struct timespec now;
  unsigned long long seconds = 0;
  if (clock_gettime(CLOCK_REALTIME, &now) == 0) seconds = (unsigned long long)now.tv_sec;
  n += anyreplay_put_number(line + n, seconds);
  line[n++] = '\n';
  lseek(anyreplay_fd, 0, SEEK_SET);
  ssize_t ignored = write(anyreplay_fd, line, n);
  (void)ignored;
}

static int anyreplay_signal_index(int signo) {
  for (int i = 0; i < ANYREPLAY_SIGNAL_COUNT; i++) {
    if (anyreplay_signals[i] == signo) return i;
  }
  return -1;
}

static void anyreplay_on_signal(int signo, siginfo_t *info, void *context) {
  int saved = errno;
  anyreplay_write_signal(signo);

  int i = anyreplay_signal_index(signo);
  if (i >= 0 && anyreplay_has_previous[i]) {
    // Put back what was there before us, then let it see the signal as it
    // would have without us.
    struct sigaction previous = anyreplay_previous[i];
    sigaction(signo, &previous, NULL);
    if (previous.sa_flags & SA_SIGINFO) {
      if (previous.sa_sigaction != NULL) previous.sa_sigaction(signo, info, context);
    } else if (previous.sa_handler != SIG_DFL && previous.sa_handler != SIG_IGN && previous.sa_handler != NULL) {
      previous.sa_handler(signo);
    }
  }

  // End the process the way the signal would have: the default action. The
  // signal is blocked while this handler runs, so it lands when it returns.
  struct sigaction fallback;
  sigemptyset(&fallback.sa_mask);
  fallback.sa_flags = 0;
  fallback.sa_handler = SIG_DFL;
  sigaction(signo, &fallback, NULL);
  raise(signo);
  errno = saved;
}

static void anyreplay_install_signals(void) {
  for (int i = 0; i < ANYREPLAY_SIGNAL_COUNT; i++) {
    // Still in place from an earlier install (someone installed on top of
    // ours, so uninstall left it): installing again would make ours its own
    // previous handler.
    if (anyreplay_has_previous[i]) continue;
    struct sigaction ours;
    sigemptyset(&ours.sa_mask);
    ours.sa_flags = SA_SIGINFO | SA_ONSTACK;
    ours.sa_sigaction = anyreplay_on_signal;
    struct sigaction previous;
    if (sigaction(anyreplay_signals[i], &ours, &previous) == 0) {
      anyreplay_previous[i] = previous;
      anyreplay_has_previous[i] = 1;
    }
  }
}

static void anyreplay_uninstall_signals(void) {
  for (int i = 0; i < ANYREPLAY_SIGNAL_COUNT; i++) {
    if (!anyreplay_has_previous[i]) continue;
    struct sigaction current;
    if (sigaction(anyreplay_signals[i], NULL, &current) != 0) continue;
    // Only where ours is still the handler: someone who installed theirs on
    // top of ours keeps it.
    if ((current.sa_flags & SA_SIGINFO) && current.sa_sigaction == anyreplay_on_signal) {
      sigaction(anyreplay_signals[i], &anyreplay_previous[i], NULL);
      anyreplay_has_previous[i] = 0;
    }
  }
}

/* ---------------------------------------------------------- exceptions -- */

static NSString *anyreplay_clip(NSString *text, NSUInteger max) {
  if (text.length <= max) return text;
  return [text substringToIndex:max];
}

static void anyreplay_on_exception(NSException *exception) {
  if (anyreplay_in_exception) return;
  anyreplay_in_exception = 1;
  if (anyreplay_enabled && !anyreplay_written && anyreplay_fd >= 0) {
    @try {
      NSArray<NSString *> *symbols = exception.callStackSymbols ?: @[];
      NSString *stack = anyreplay_clip([symbols componentsJoinedByString:@"\n"], ANYREPLAY_MAX_STACK);
      long long ms = (long long)([[NSDate date] timeIntervalSince1970] * 1000.0);
      NSDictionary *record = @{
        @"v" : @1,
        @"ts" : @(ms),
        @"platform" : @"ios",
        @"name" : exception.name ?: @"NSException",
        @"message" : anyreplay_clip(exception.reason ?: @"", ANYREPLAY_MAX_MESSAGE),
        @"stack" : stack,
      };
      NSData *data = [NSJSONSerialization dataWithJSONObject:record options:0 error:NULL];
      if (data.length > 0) {
        lseek(anyreplay_fd, 0, SEEK_SET);
        ftruncate(anyreplay_fd, 0);
        if (write(anyreplay_fd, data.bytes, data.length) == (ssize_t)data.length) {
          fsync(anyreplay_fd);
          anyreplay_written = 1;
        }
      }
    } @catch (__unused NSException *ignored) {
      // Never in the way of the crash itself.
    }
  }
  if (anyreplay_previous_exception != NULL) anyreplay_previous_exception(exception);
}

/* -------------------------------------------------------------- public -- */

int anyreplay_crash_install(const char *path) {
  @synchronized([NSProcessInfo processInfo]) {
    if (anyreplay_fd < 0) {
      if (path == NULL) return 0;
      anyreplay_fd = open(path, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
      if (anyreplay_fd < 0) return 0;
    }
    if (anyreplay_installed) return 1;
    anyreplay_installed = 1;
    anyreplay_enabled = 1;
    NSUncaughtExceptionHandler *current = NSGetUncaughtExceptionHandler();
    if (current != &anyreplay_on_exception) {
      anyreplay_previous_exception = current;
      NSSetUncaughtExceptionHandler(&anyreplay_on_exception);
    }
    anyreplay_install_signals();
    return 1;
  }
}

void anyreplay_crash_uninstall(void) {
  @synchronized([NSProcessInfo processInfo]) {
    if (!anyreplay_installed) return;
    anyreplay_installed = 0;
    anyreplay_enabled = 0;
    if (NSGetUncaughtExceptionHandler() == &anyreplay_on_exception) {
      NSSetUncaughtExceptionHandler(anyreplay_previous_exception);
    }
    anyreplay_uninstall_signals();
  }
}
