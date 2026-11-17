import 'dart:convert';

import 'package:anyreplay_flutter/src/capture.dart';
import 'package:anyreplay_flutter/src/tree.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

const String testKey = 'ar_pk_live_0123456789abcdef01234567';

/// A phone: 390 × 844 logical pixels at 3×, like an iPhone 14.
void usePhone(WidgetTester tester, {Size size = const Size(390, 844)}) {
  tester.view.devicePixelRatio = 3;
  tester.view.physicalSize = size * 3;
  addTearDown(tester.view.reset);
}

/// Reads what is on screen now.
MobileNode captureNow(WidgetTester tester, {TreeCapture? with_, CaptureSettings settings = const CaptureSettings()}) {
  final capture = with_ ?? TreeCapture(settings);
  final view = tester.view;
  return capture.capture(
    WidgetsBinding.instance.rootElement,
    CaptureScreen(
      size: view.physicalSize / view.devicePixelRatio,
      statusBar: view.viewPadding.top / view.devicePixelRatio,
      bottomInset: view.padding.bottom / view.devicePixelRatio,
      keyboard: view.viewInsets.bottom / view.devicePixelRatio,
    ),
  );
}

Map<String, Object?> asJson(MobileNode node) => jsonDecode(jsonEncode(node.toJson())) as Map<String, Object?>;

/// Every element of the tree, depth first.
Iterable<Map<String, Object?>> elements(Map<String, Object?> node) sync* {
  if (node['type'] != 2) return;
  yield node;
  for (final child in (node['childNodes'] as List).cast<Map<String, Object?>>()) {
    yield* elements(child);
  }
}

Map<String, Object?> attrs(Map<String, Object?> node) => (node['attributes'] as Map).cast<String, Object?>();

String? textOf(Map<String, Object?> node) {
  final children = (node['childNodes'] as List).cast<Map<String, Object?>>();
  if (children.isEmpty || children.first['type'] != 3) return null;
  return children.first['textContent'] as String?;
}

/// The elements with this tag.
List<Map<String, Object?>> tagged(Map<String, Object?> tree, String tag) =>
    elements(tree).where((e) => e['tagName'] == tag).toList();

/// The element whose own text is [text].
Map<String, Object?>? withText(Map<String, Object?> tree, String text) {
  for (final e in elements(tree)) {
    if (textOf(e) == text) return e;
  }
  return null;
}

/// Every word in the tree, as the translator would read it.
List<String> words(Map<String, Object?> tree) => [
      for (final e in elements(tree)) ...[
        if (textOf(e) != null) textOf(e)!,
        for (final key in const ['placeholder', 'aria-label', 'alt'])
          if (attrs(e)[key] is String) attrs(e)[key]! as String,
      ],
    ];

/// The screen-space position of an element, adding up its ancestors (and
/// subtracting scroll offsets) the way a reader does.
Offset screenPosition(Map<String, Object?> tree, Map<String, Object?> target) {
  Offset? walk(Map<String, Object?> node, Offset origin) {
    final a = attrs(node);
    final here = origin + Offset((a['x']! as num).toDouble(), (a['y']! as num).toDouble());
    if (identical(node, target)) return here;
    final scroll = node['tagName'] == 'ScrollView'
        ? Offset((a['sx']! as num).toDouble(), (a['sy']! as num).toDouble())
        : Offset.zero;
    for (final child in (node['childNodes'] as List).cast<Map<String, Object?>>()) {
      if (child['type'] != 2) continue;
      final found = walk(child, here - scroll);
      if (found != null) return found;
    }
    return null;
  }

  return walk(tree, Offset.zero)!;
}
