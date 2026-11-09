import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'shop_app.dart';
import 'support.dart';

/// The product translates what the reviewer sees (contract §7), so every word
/// Flutter draws must reach the recording as text — a text node, or the
/// placeholder or label the translator also reads — and nothing as pixels.
///
/// Flutter itself is the ground truth here: every `RichText` it laid out and
/// painted on screen is a string the recording must carry, unless it was
/// masked on purpose. (The monorepo also runs the server's own extractor over
/// the scenario's recording; see the README's "Translation" section.)
void main() {
  Set<String> paintedStrings(WidgetTester tester) {
    final screen = Offset.zero & tester.view.physicalSize / tester.view.devicePixelRatio;
    final strings = <String>{};
    for (final element in find.byType(RichText, skipOffstage: true).evaluate()) {
      final widget = element.widget as RichText;
      final family = widget.text.style?.fontFamily;
      if (family == 'MaterialIcons' || family == 'CupertinoIcons') continue;
      final box = element.renderObject! as RenderBox;
      if (!box.hasSize || box.size.isEmpty) continue;
      final rect = MatrixUtils.transformRect(box.getTransformTo(null), Offset.zero & box.size);
      if (!rect.overlaps(screen)) continue;
      final text = widget.text.toPlainText(includeSemanticsLabels: false, includePlaceholders: false);
      if (text.trim().isNotEmpty) strings.add(text);
    }
    return strings;
  }

  testWidgets('every string on the cart screen is in the recording', (tester) async {
    usePhone(tester);
    await tester.pumpWidget(const ShopApp());
    await tester.enterText(find.byKey(const Key('coupon')), 'YAZ25');
    await tester.pump();
    final tree = asJson(captureNow(tester));
    final recorded = words(tree).toSet();
    final painted = paintedStrings(tester);
    expect(painted, isNotEmpty);
    // The coupon's hint is not painted once something is typed; the
    // placeholder attribute still carries it.
    expect(recorded, containsAll(painted));
    expect(recorded, containsAll(['Kupon kodu', 'YAZ25', 'Favoriler', 'Kulaklık fotoğrafı']));
  });

  testWidgets('every string on the payment screen and its dialog, except what is masked', (tester) async {
    usePhone(tester);
    await tester.pumpWidget(const ShopApp());
    tester.state<NavigatorState>(find.byType(Navigator)).pushNamed('/payment');
    for (var i = 0; i < 10; i += 1) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    await tester.tap(find.text('Öde'));
    for (var i = 0; i < 10; i += 1) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    final tree = asJson(captureNow(tester));
    final recorded = words(tree).toSet();
    final painted = paintedStrings(tester)..remove('Bağdat Cd. 12, İstanbul');
    expect(recorded, containsAll(painted));
    expect(recorded, isNot(contains('Bağdat Cd. 12, İstanbul')));
  });

  testWidgets('a button\'s words sit inside a Pressable with role button, so they are read as one', (tester) async {
    usePhone(tester);
    await tester.pumpWidget(MaterialApp(
        home: Scaffold(body: Center(child: ElevatedButton(onPressed: () {}, child: const Text('Kaydet'))))));
    final tree = asJson(captureNow(tester));
    final button = tagged(tree, 'Pressable').single;
    expect(attrs(button)['role'], 'button');
    expect(words(button), ['Kaydet']);
  });

  testWidgets('nothing is recorded as a picture of words', (tester) async {
    usePhone(tester);
    await tester.pumpWidget(const ShopApp());
    final tree = asJson(captureNow(tester));
    final pictures = tagged(tree, 'Image').where((e) {
      final a = attrs(e);
      return (a['w']! as int) * (a['h']! as int) > 390 * 844 / 2;
    });
    expect(pictures, isEmpty);
    expect(words(tree), isNotEmpty);
  });
}
