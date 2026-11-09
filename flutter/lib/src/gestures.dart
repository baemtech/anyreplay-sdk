import 'package:flutter/gestures.dart';

/// Taps, heard without taking part in the gesture (docs/SDK-CONTRACT.md §5.4).
///
/// The detector is fed every pointer event from a global route on
/// `GestureBinding.instance.pointerRouter`, which sees each event after hit
/// testing and claims nothing: no widget's gesture is changed by it.
///
/// A tap is reported once, when the finger lifts, at the point where it went
/// **down** — the point Flutter hit-tested to choose the widget — and only if
/// it never moved further than the platform's touch slop from there
/// (`computeHitSlop`: 18 logical pixels for a finger by default, the
/// device's own value when the engine reports one). A cancelled pointer — a
/// scroll view or a route taking over — is never a tap.
class TapDetector {
  TapDetector(this.onTap, {this.gestureSettings});

  /// Called with the tap's position in logical pixels, from the top-left of
  /// the view.
  final void Function(double x, double y) onTap;

  /// The view's gesture settings (its touch slop), when known.
  final DeviceGestureSettings? Function()? gestureSettings;

  final Map<int, _Down> _down = {};

  void handleEvent(PointerEvent event) {
    try {
      if (event is PointerDownEvent) {
        _down[event.pointer] = _Down(event.position, computeHitSlop(event.kind, gestureSettings?.call()));
      } else if (event is PointerMoveEvent) {
        final start = _down[event.pointer];
        if (start != null && !start.moved && (event.position - start.at).distance > start.slop) start.moved = true;
      } else if (event is PointerUpEvent) {
        final start = _down.remove(event.pointer);
        if (start == null || start.moved) return;
        // A move can be coalesced away under load; the lifting point is checked too.
        if ((event.position - start.at).distance > start.slop) return;
        onTap(start.at.dx, start.at.dy);
      } else if (event is PointerCancelEvent) {
        _down.remove(event.pointer);
      }
    } catch (_) {/* a recorder must never break a gesture */}
  }

  void reset() => _down.clear();
}

class _Down {
  _Down(this.at, this.slop);
  final Offset at;
  final double slop;
  bool moved = false;
}
