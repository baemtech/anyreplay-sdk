import 'dart:async';
import 'dart:ui' as ui;

import 'package:flutter/gestures.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/widgets.dart';
import 'package:http/http.dart' as http;

import 'capture.dart';
import 'device.dart';
import 'diagnostics.dart';
import 'gestures.dart';
import 'recorder.dart';
import 'tree.dart';

/// The recorder's window on a running Flutter app.
class FlutterHost implements RecorderHost {
  FlutterHost({
    required this.treeCapture,
    required this.client,
    required DeviceDescription device,
    int Function()? clock,
    String? locale,
    ErrorHooks? errorHooks,
    this.manualTimers = false,
  })  : _device = device,
        _clock = clock,
        _locale = locale,
        errorHooks = errorHooks ?? const FlutterErrorHooks();

  final TreeCapture treeCapture;
  @override
  final http.Client client;
  @override
  final ErrorHooks errorHooks;

  /// Timers are registered but never fire: a test ticks the recorder itself.
  final bool manualTimers;

  final DeviceDescription _device;
  final int Function()? _clock;
  final String? _locale;
  TapDetector? _taps;

  /// Callbacks registered while [manualTimers] is on, by handle.
  final Map<Object, void Function()> manualCallbacks = {};

  ui.FlutterView? get _view {
    final dispatcher = WidgetsBinding.instance.platformDispatcher;
    return dispatcher.implicitView ?? (dispatcher.views.isEmpty ? null : dispatcher.views.first);
  }

  @override
  int now() => _clock?.call() ?? DateTime.now().millisecondsSinceEpoch;

  @override
  Size screenSize() {
    final view = _view;
    if (view == null || view.devicePixelRatio <= 0) return Size.zero;
    return view.physicalSize / view.devicePixelRatio;
  }

  @override
  DeviceDescription device() {
    final size = screenSize();
    final tablet = _device.tablet || (size.shortestSide >= 600);
    return DeviceDescription(os: _device.os, osVersion: _device.osVersion, model: _device.model, tablet: tablet);
  }

  @override
  String? locale() {
    if (_locale != null) return _locale;
    try {
      final tag = WidgetsBinding.instance.platformDispatcher.locale.toLanguageTag();
      return tag.isEmpty || tag.length > 16 ? null : tag;
    } catch (_) {
      return null;
    }
  }

  @override
  MobileNode? capture(Size size) {
    final root = WidgetsBinding.instance.rootElement;
    final view = _view;
    if (root == null || view == null || size.isEmpty) return null;
    final ratio = view.devicePixelRatio;
    return treeCapture.capture(
      root,
      CaptureScreen(
        size: size,
        statusBar: view.viewPadding.top / ratio,
        bottomInset: view.padding.bottom / ratio,
        keyboard: view.viewInsets.bottom / ratio,
      ),
    );
  }

  @override
  Object setInterval(void Function() callback, Duration every) {
    if (manualTimers) {
      final handle = Object();
      manualCallbacks[handle] = callback;
      return handle;
    }
    return Timer.periodic(every, (_) => _betweenFrames(callback));
  }

  @override
  void clearInterval(Object handle) {
    if (handle is Timer) handle.cancel();
    manualCallbacks.remove(handle);
  }

  /// Reads the tree only between frames, never in the middle of one.
  static void _betweenFrames(void Function() callback) {
    final phase = SchedulerBinding.instance.schedulerPhase;
    if (phase == SchedulerPhase.idle || phase == SchedulerPhase.postFrameCallbacks) {
      callback();
    } else {
      SchedulerBinding.instance.addPostFrameCallback((_) => callback());
    }
  }

  @override
  void attachTaps(void Function(double x, double y) onTap) {
    if (_taps != null) return;
    final detector = TapDetector(onTap, gestureSettings: () {
      final view = _view;
      return view == null ? null : DeviceGestureSettings.fromView(view);
    });
    _taps = detector;
    GestureBinding.instance.pointerRouter.addGlobalRoute(detector.handleEvent);
  }

  @override
  void detachTaps() {
    final detector = _taps;
    if (detector == null) return;
    _taps = null;
    try {
      GestureBinding.instance.pointerRouter.removeGlobalRoute(detector.handleEvent);
    } catch (_) {/* already gone */}
  }
}
