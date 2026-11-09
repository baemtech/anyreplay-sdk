import 'package:flutter/widgets.dart';

import 'anyreplay.dart';

/// Names each screen of the recording after its route
/// (docs/SDK-CONTRACT.md §5.3).
///
/// ```dart
/// MaterialApp(navigatorObservers: [AnyReplayNavigatorObserver()], …)
/// GoRouter(observers: [AnyReplayNavigatorObserver()], …)
/// ```
///
/// The name is `RouteSettings.name` — `/checkout`, `ProductDetail` — with any
/// query string or fragment cut off. Name routes after what they are, never
/// after who is looking at them: `/orders/:id`, not `/orders/829461`.
/// Dialogs, sheets and menus are layers of the screen they open over, not
/// screens of their own; a route without a name changes nothing.
class AnyReplayNavigatorObserver extends NavigatorObserver {
  AnyReplayNavigatorObserver({this.nameOf});

  /// Overrides how a route is named. Return null to leave the screen as it was.
  final String? Function(Route<dynamic> route)? nameOf;

  @override
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) => _show(route);

  @override
  void didPop(Route<dynamic> route, Route<dynamic>? previousRoute) {
    if (_isScreen(route) && previousRoute != null) _show(previousRoute);
  }

  @override
  void didReplace({Route<dynamic>? newRoute, Route<dynamic>? oldRoute}) {
    if (newRoute != null) _show(newRoute);
  }

  static bool _isScreen(Route<dynamic> route) =>
      route is PageRoute || (route is! PopupRoute && route is ModalRoute && route.opaque);

  void _show(Route<dynamic> route) {
    if (!_isScreen(route)) return;
    try {
      final name = screenName(nameOf != null ? nameOf!(route) : route.settings.name);
      if (name != null) AnyReplay.screen(name);
    } catch (_) {/* naming a screen must never break navigation */}
  }
}

/// A route name as the recording carries it: without query or fragment, at
/// most 2048 characters, or null when nothing is left.
String? screenName(String? raw) {
  if (raw == null) return null;
  var name = raw;
  final cut = name.indexOf(RegExp(r'[?#]'));
  if (cut >= 0) name = name.substring(0, cut);
  name = name.trim();
  if (name.isEmpty) return null;
  return name.length > 2048 ? name.substring(0, 2048) : name;
}
