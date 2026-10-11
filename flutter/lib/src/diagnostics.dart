import 'dart:ui' show ErrorCallback, PlatformDispatcher;

import 'package:flutter/foundation.dart';

import 'events.dart';

/// Where uncaught errors are heard. The real one is Flutter's two global
/// hooks; tests pass a fake.
abstract class ErrorHooks {
  FlutterExceptionHandler? get flutterError;
  set flutterError(FlutterExceptionHandler? handler);
  ErrorCallback? get platformError;
  set platformError(ErrorCallback? handler);
}

/// `FlutterError.onError` (errors the framework caught: build, layout,
/// paint, gestures) and `PlatformDispatcher.instance.onError` (errors nothing
/// caught: an async gap, a timer, a platform callback).
class FlutterErrorHooks implements ErrorHooks {
  const FlutterErrorHooks();
  @override
  FlutterExceptionHandler? get flutterError => FlutterError.onError;
  @override
  set flutterError(FlutterExceptionHandler? handler) => FlutterError.onError = handler;
  @override
  ErrorCallback? get platformError => PlatformDispatcher.instance.onError;
  @override
  set platformError(ErrorCallback? handler) => PlatformDispatcher.instance.onError = handler;
}

/// Installs the error hooks while a recording runs, chained to whatever was
/// there before — the app's crash reporter, Flutter's red screen and console
/// output keep working — and puts them back on [stop] (contract §8.3).
class Diagnostics {
  Diagnostics({
    required this.hooks,
    required this.emit,
    required this.onError,
    required bool install,
  }) {
    if (install) _install();
  }

  final ErrorHooks hooks;
  final void Function(String tag, Object payload) emit;

  /// The first error of a session sets `hasError`.
  final void Function() onError;

  int _count = 0;
  bool _stopped = false;
  bool _installed = false;
  FlutterExceptionHandler? _previousFlutter;
  ErrorCallback? _previousPlatform;
  FlutterExceptionHandler? _ownFlutter;
  ErrorCallback? _ownPlatform;

  void _install() {
    _installed = true;
    _previousFlutter = hooks.flutterError;
    _ownFlutter = (FlutterErrorDetails details) {
      try {
        record(ErrorKind.error, details.exception, stack: details.stack, message: details.exceptionAsString());
      } catch (_) {/* fall through to the app's own handler regardless */}
      _previousFlutter?.call(details);
    };
    hooks.flutterError = _ownFlutter;

    _previousPlatform = hooks.platformError;
    _ownPlatform = (Object error, StackTrace stack) {
      try {
        record(ErrorKind.error, error, stack: stack);
      } catch (_) {/* as above */}
      return _previousPlatform?.call(error, stack) ?? false;
    };
    hooks.platformError = _ownPlatform;
  }

  /// Records one error: redacted, counted against the per-launch ceiling.
  void record(ErrorKind kind, Object? error, {StackTrace? stack, String? message}) {
    if (_stopped) return;
    try {
      onError();
    } catch (_) {/* never the app's problem */}
    if (_count >= maxErrorsPerLaunch) return;
    _count += 1;
    try {
      emit(errorTag, errorPayload(kind, error, stack: stack, message: message));
    } catch (_) {/* as above */}
  }

  void stop() {
    if (_stopped) return;
    _stopped = true;
    if (!_installed) return;
    // Only where nothing has replaced ours since: putting the old handler
    // back over a newer one would silence whoever installed it.
    if (identical(hooks.flutterError, _ownFlutter)) hooks.flutterError = _previousFlutter;
    if (identical(hooks.platformError, _ownPlatform)) hooks.platformError = _previousPlatform;
  }
}
