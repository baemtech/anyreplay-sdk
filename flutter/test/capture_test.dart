import 'package:anyreplay_flutter/anyreplay_flutter.dart';
import 'package:anyreplay_flutter/src/capture.dart';
import 'package:anyreplay_flutter/src/icons.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support.dart';

/// What the capture makes of real Flutter screens (docs/MOBILE-REPLAY-FORMAT.md).
Future<Map<String, Object?>> pumpAndCapture(
  WidgetTester tester,
  Widget home, {
  CaptureSettings settings = const CaptureSettings(),
  TreeCapture? capture,
}) async {
  usePhone(tester);
  await tester.pumpWidget(MaterialApp(debugShowCheckedModeBanner: false, home: home));
  return asJson(captureNow(tester, with_: capture, settings: settings));
}

Rect screenRect(Map<String, Object?> tree, Map<String, Object?> node) {
  final at = screenPosition(tree, node);
  final a = attrs(node);
  return Rect.fromLTWH(at.dx, at.dy, (a['w']! as num).toDouble(), (a['h']! as num).toDouble());
}

class _Chart extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) => canvas.drawLine(Offset.zero, Offset(size.width, size.height), Paint());
  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

/// Stands in for webview_flutter's widget: recognised by its name.
class WebViewWidget extends StatelessWidget {
  const WebViewWidget({super.key});
  @override
  Widget build(BuildContext context) =>
      const ColoredBox(color: Colors.white, child: Text('https://pay.example.com/3ds?session=abc'));
}

void main() {
  group('the tree', () {
    testWidgets('Screen root id 1, even element ids, text id + 1, whole points', (tester) async {
      final tree = await pumpAndCapture(
          tester, Scaffold(appBar: AppBar(title: const Text('Başlık')), body: const Center(child: Text('Merhaba'))));
      expect(tree['id'], 1);
      expect(tree['tagName'], 'Screen');
      expect(attrs(tree), {'x': 0, 'y': 0, 'w': 390, 'h': 844});
      for (final e in elements(tree).skip(1)) {
        expect((e['id']! as int).isEven, isTrue);
        for (final key in ['x', 'y', 'w', 'h']) {
          expect(attrs(e)[key], isA<int>(), reason: '$key of ${e['tagName']}');
        }
        final children = (e['childNodes']! as List).cast<Map<String, Object?>>();
        final texts = children.where((c) => c['type'] == 3).toList();
        expect(texts.length, lessThanOrEqualTo(1));
        if (texts.isNotEmpty) {
          expect(children.first, same(texts.single));
          expect(texts.single['id'], (e['id']! as int) + 1);
        }
      }
      final hello = withText(tree, 'Merhaba')!;
      final onScreen = tester.getRect(find.text('Merhaba'));
      expect(
          screenRect(tree, hello),
          Rect.fromLTWH(onScreen.left.roundToDouble(), onScreen.top.roundToDouble(), onScreen.width.roundToDouble(),
              onScreen.height.roundToDouble()));
    });

    testWidgets('ids are stable between captures, and new for new elements', (tester) async {
      final capture = TreeCapture(const CaptureSettings());
      final first = await pumpAndCapture(tester, const Scaffold(body: Column(children: [Text('A'), Text('B')])),
          capture: capture);
      final again = asJson(captureNow(tester, with_: capture));
      expect(withText(again, 'A')!['id'], withText(first, 'A')!['id']);
      await tester.pumpWidget(
          const MaterialApp(home: Scaffold(body: Column(children: [Text('A'), Text('C', key: ValueKey('c'))]))));
      final later = asJson(captureNow(tester, with_: capture));
      expect(withText(later, 'A')!['id'], withText(first, 'A')!['id']);
      expect(elements(first).map((e) => e['id']), isNot(contains(withText(later, 'C')!['id'])));
    });
  });

  group('words', () {
    testWidgets('text keeps its style as the format names it', (tester) async {
      final tree = await pumpAndCapture(
        tester,
        const Scaffold(
          body: Column(children: [
            Text('Kalın', style: TextStyle(fontWeight: FontWeight.bold, color: Color(0xFF112233), fontSize: 20)),
            Text('Eğik', style: TextStyle(fontStyle: FontStyle.italic, fontFamily: 'Courier New')),
            Text('Ortada', textAlign: TextAlign.center),
            SizedBox(
                width: 120,
                child: Text('Uzun bir açıklama üç satıra yayılır ve kesilmez', style: TextStyle(fontSize: 14))),
            Text('Yarı saydam', style: TextStyle(color: Color(0x80FF0000))),
          ]),
        ),
      );
      expect(attrs(withText(tree, 'Kalın')!),
          allOf(containsPair('fw', 700), containsPair('color', '#112233'), containsPair('size', 20)));
      expect(attrs(withText(tree, 'Eğik')!), allOf(containsPair('it', true), containsPair('ff', 'mono')));
      expect(attrs(withText(tree, 'Ortada')!)['al'], 'center');
      expect(attrs(withText(tree, 'Uzun bir açıklama üç satıra yayılır ve kesilmez')!)['lines'], greaterThan(1));
      expect(attrs(withText(tree, 'Yarı saydam')!)['color'], '#ff000080');
    });

    testWidgets('Text.rich is recorded in the style most of its words use, on the lines it really takes',
        (tester) async {
      // Found on an iOS simulator: the theme's 14 pt body style sits at the
      // root of Text.rich, so a 22 pt bold headline was recorded as 14 pt on
      // two lines.
      final tree = await pumpAndCapture(
        tester,
        const Scaffold(
          body: Column(children: [
            Text.rich(TextSpan(children: [
              TextSpan(text: 'Taze ekmek ', style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
              TextSpan(text: 'her sabah!!', style: TextStyle(fontStyle: FontStyle.italic)),
            ])),
          ]),
        ),
      );
      final a = attrs(withText(tree, 'Taze ekmek her sabah!!')!);
      expect(a, allOf(containsPair('size', 20), containsPair('fw', 700)));
      expect(a['lines'], isNull);
    });

    testWidgets('text drawn through a scale is recorded at the size it is drawn', (tester) async {
      // Found on an iOS simulator: a TextField's floated label is 16 pt text
      // scaled to 0.75, recorded as 16 pt in a 12 pt box and clipped.
      final tree = await pumpAndCapture(
        tester,
        Scaffold(
          body: Column(children: [
            Transform.scale(
                scale: 0.75, alignment: Alignment.topLeft, child: const Text('Küçük', style: TextStyle(fontSize: 16))),
          ]),
        ),
      );
      expect(attrs(withText(tree, 'Küçük')!)['size'], 12);
    });

    testWidgets('the text scale factor is in the size', (tester) async {
      usePhone(tester);
      await tester.pumpWidget(const MaterialApp(
        home: MediaQuery(
            data: MediaQueryData(textScaler: TextScaler.linear(1.5)),
            child: Text('Büyük', style: TextStyle(fontSize: 10))),
      ));
      expect(attrs(withText(asJson(captureNow(tester)), 'Büyük')!)['size'], 15);
    });

    testWidgets('a header and a link by their semantics, each only on what it names', (tester) async {
      final tree = await pumpAndCapture(
        tester,
        Scaffold(
          body: Column(children: [
            Semantics(header: true, child: const Text('Hesap')),
            Semantics(header: true, child: const Text('Kalın başlık', style: TextStyle(fontWeight: FontWeight.w700))),
            Semantics(link: true, child: const Column(children: [Text('Koşullar'), Text('Gizlilik')])),
          ]),
        ),
      );
      expect(attrs(withText(tree, 'Hesap')!)['role'], 'header');
      // A reader draws a header semi-bold unless told otherwise; this one is regular.
      expect(attrs(withText(tree, 'Hesap')!)['fw'], 400);
      expect(attrs(withText(tree, 'Kalın başlık')!)['fw'], 700);
      expect(attrs(withText(tree, 'Koşullar')!)['role'], 'link');
      expect(attrs(withText(tree, 'Gizlilik')!).containsKey('role'), isFalse);
    });

    testWidgets('SelectableText is the app\'s words, not a field', (tester) async {
      final tree = await pumpAndCapture(tester, const Scaffold(body: SelectableText('Sipariş no: 829461')));
      expect(withText(tree, 'Sipariş no: 829461')!['tagName'], 'Text');
      expect(tagged(tree, 'TextInput'), isEmpty);
    });
  });

  group('fields', () {
    Future<Map<String, Object?>> form(WidgetTester tester, Map<Key, String> typed,
        {CaptureSettings settings = const CaptureSettings()}) async {
      usePhone(tester);
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: ListView(children: const [
            TextField(key: Key('plain'), decoration: InputDecoration(hintText: 'Kupon kodu')),
            TextField(key: Key('secret'), obscureText: true, decoration: InputDecoration(labelText: 'Şifre')),
            TextField(key: Key('card'), autofillHints: [AutofillHints.creditCardNumber]),
            TextField(key: Key('otp'), autofillHints: [AutofillHints.oneTimeCode]),
            TextField(key: Key('show'), keyboardType: TextInputType.visiblePassword),
            TextField(key: Key('cvv-input')),
            TextField(key: Key('note'), decoration: InputDecoration(labelText: 'Not')),
            TextField(key: Key('email'), autofillHints: [AutofillHints.email]),
            TextField(key: Key('off'), enabled: false, decoration: InputDecoration(hintText: 'Kapalı')),
            CupertinoTextField(key: Key('cupertino'), placeholder: 'Ara'),
          ]),
        ),
      ));
      for (final entry in typed.entries) {
        await tester.enterText(find.byKey(entry.key), entry.value);
      }
      await tester.pump();
      return asJson(captureNow(tester, settings: settings));
    }

    Map<String, Object?> input(Map<String, Object?> tree, int index) => tagged(tree, 'TextInput')[index];

    testWidgets('what people type is recorded, and the floor is not', (tester) async {
      final tree = await form(tester, {
        const Key('plain'): 'YAZ25',
        const Key('secret'): 'hunter2',
        const Key('card'): '4242',
        const Key('otp'): '123456',
        const Key('show'): 'hunter3',
        const Key('cvv-input'): '123',
        const Key('note'): '4111111111111111',
        const Key('email'): 'ayse@example.com',
        const Key('cupertino'): 'kulaklık',
      });
      expect(tagged(tree, 'TextInput'), hasLength(10));
      expect(textOf(input(tree, 0)), 'YAZ25');
      expect(attrs(input(tree, 0))['placeholder'], 'Kupon kodu');
      for (final i in [1, 2, 3, 4, 5, 6]) {
        expect(attrs(input(tree, i))['masked'], isTrue, reason: 'field $i');
        expect(textOf(input(tree, i)), '••••••', reason: 'field $i');
      }
      expect(attrs(input(tree, 1))['aria-label'], '••••••');
      expect(textOf(input(tree, 7)), 'ayse@example.com', reason: 'contact details are not the floor');
      expect(attrs(input(tree, 8))['disabled'], isTrue);
      expect(textOf(input(tree, 9)), 'kulaklık');
      expect(attrs(input(tree, 9))['placeholder'], 'Ara');
      final wire = words(tree).join('|');
      for (final secret in ['hunter2', 'hunter3', '4242', '123456', '4111111111111111']) {
        expect(wire, isNot(contains(secret)));
      }
      // The hint is the placeholder, not a second line of text over the field.
      expect(withText(tree, 'Kupon kodu'), isNull);
      // A label is the app's words, and stays readable even beside a masked field.
      expect(withText(tree, 'Şifre'), isNotNull);
    });

    testWidgets('a card number being typed into a plain field never shows more than six digits', (tester) async {
      // Found on an iOS simulator: a field with no hints recorded `4242424…`
      // on each tick until the number was long enough to pass the Luhn check.
      const number = '4242424242424242';
      for (var n = 1; n <= number.length; n += 1) {
        final tree = await form(tester, {const Key('plain'): number.substring(0, n)});
        final shown = textOf(input(tree, 0))!;
        expect(shown.replaceAll(RegExp('[^0-9]'), '').length, lessThanOrEqualTo(6), reason: number.substring(0, n));
        expect(attrs(input(tree, 0))['masked'], n > 6 ? isTrue : isNull, reason: number.substring(0, n));
      }
      // A phone number written the usual way is not a card.
      final phone = await form(tester, {const Key('plain'): '0532 123 45 67'});
      expect(textOf(input(phone, 0)), '0532 123 45 67');
    });

    testWidgets('a card number inside longer text is starred, and the words around it stay', (tester) async {
      const typedAll = 'Hunter2 card 5555555555554444 thanks';
      for (var n = 1; n <= typedAll.length; n += 1) {
        final typed = typedAll.substring(0, n);
        final tree = await form(tester, {const Key('plain'): typed});
        final shown = textOf(input(tree, 0))!;
        expect(shown.length, typed.length, reason: typed);
        expect(shown.replaceAll(RegExp('[^0-9]'), '').length, lessThanOrEqualTo(7), reason: typed); // the 2 of Hunter2
        expect(shown, isNot(contains('5555555')), reason: typed);
      }
      final tree = await form(tester, {const Key('plain'): typedAll});
      expect(textOf(input(tree, 0)), 'Hunter2 card **************** thanks');
      expect(attrs(input(tree, 0))['masked'], isNull);
    });

    testWidgets('an empty masked field has no text child, and keeps its placeholder', (tester) async {
      final tree = await form(tester, {});
      expect(textOf(input(tree, 1)), isNull);
      expect(attrs(input(tree, 1))['masked'], isTrue);
    });

    testWidgets('maskAllInputs and maskAllTyping mask every field', (tester) async {
      for (final settings in const [CaptureSettings(maskAllInputs: true), CaptureSettings(maskAllTyping: true)]) {
        final tree = await form(tester, {const Key('plain'): 'YAZ25'}, settings: settings);
        expect(textOf(input(tree, 0)), '••••••');
        expect(attrs(input(tree, 0))['placeholder'], 'Kupon kodu');
      }
    });
  });

  group('lists', () {
    testWidgets('a scroll view carries sx/sy and its children are in content coordinates', (tester) async {
      usePhone(tester);
      final controller = ScrollController();
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: ListView.builder(
            controller: controller,
            itemExtent: 60,
            itemCount: 100,
            itemBuilder: (_, i) => Text('Satır $i'),
          ),
        ),
      ));
      final capture = TreeCapture(const CaptureSettings());
      final before = asJson(captureNow(tester, with_: capture));
      final list = tagged(before, 'ScrollView').single;
      expect((attrs(list)['sx'], attrs(list)['sy']), (0, 0));

      controller.jumpTo(300);
      await tester.pump();
      final after = asJson(captureNow(tester, with_: capture));
      final scrolled = tagged(after, 'ScrollView').single;
      expect(attrs(scrolled)['sy'], 300);
      final row = withText(after, 'Satır 10')!;
      expect(attrs(row)['y'], 600, reason: 'content coordinates: row 10 of 60 points');
      final onScreen = tester.getRect(find.text('Satır 10'));
      expect(screenRect(after, row).top, onScreen.top.roundToDouble());
      expect(withText(after, 'Satır 0'), isNull, reason: 'scrolled off the screen');
      expect(withText(after, 'Satır 99'), isNull, reason: 'never built');
    });

    testWidgets('a horizontal list scrolls in sx', (tester) async {
      usePhone(tester);
      final controller = ScrollController();
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: SizedBox(
            height: 80,
            child: ListView(
              controller: controller,
              scrollDirection: Axis.horizontal,
              children: [for (var i = 0; i < 20; i += 1) SizedBox(width: 100, child: Text('Kart $i'))],
            ),
          ),
        ),
      ));
      controller.jumpTo(250);
      await tester.pump();
      final tree = asJson(captureNow(tester));
      final list = tagged(tree, 'ScrollView').single;
      expect((attrs(list)['sx'], attrs(list)['sy']), (250, 0));
      expect(
          screenRect(tree, withText(tree, 'Kart 3')!).left, tester.getRect(find.text('Kart 3')).left.roundToDouble());
    });

    testWidgets('a reversed list still places its rows where they are', (tester) async {
      usePhone(tester);
      final controller = ScrollController();
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: ListView(
              controller: controller,
              reverse: true,
              children: [for (var i = 0; i < 40; i += 1) SizedBox(height: 50, child: Text('Mesaj $i'))]),
        ),
      ));
      controller.jumpTo(120);
      await tester.pump();
      final tree = asJson(captureNow(tester));
      expect(attrs(tagged(tree, 'ScrollView').single)['sy'], -120);
      expect(
          screenRect(tree, withText(tree, 'Mesaj 5')!).top, tester.getRect(find.text('Mesaj 5')).top.roundToDouble());
    });
  });

  group('controls', () {
    testWidgets('switches, checkboxes, radios, sliders, progress', (tester) async {
      final tree = await pumpAndCapture(
        tester,
        Scaffold(
          body: ListView(children: [
            Switch(value: true, onChanged: (_) {}),
            const Switch(value: false, onChanged: null),
            CupertinoSwitch(value: true, onChanged: (_) {}),
            Checkbox(value: true, onChanged: (_) {}),
            Checkbox(value: null, tristate: true, onChanged: (_) {}),
            RadioGroup<int>(
              groupValue: 2,
              onChanged: (_) {},
              child: const Column(children: [Radio<int>(value: 1), Radio<int>(value: 2)]),
            ),
            Slider(value: 30, min: 0, max: 100, onChanged: (_) {}),
            const LinearProgressIndicator(value: 0.4),
            const CircularProgressIndicator(),
          ]),
        ),
      );
      final switches = tagged(tree, 'Switch');
      expect(switches.map((s) => attrs(s)['on']), [true, false, true]);
      expect(attrs(switches[1])['disabled'], isTrue);
      final boxes = tagged(tree, 'Checkbox');
      expect(boxes.map((b) => attrs(b)['on']), [true, 'mixed', false, true]);
      expect(boxes.skip(2).map((b) => attrs(b)['role']), ['radio', 'radio']);
      final slider = tagged(tree, 'Slider').single;
      expect((attrs(slider)['val'], attrs(slider)['min'], attrs(slider)['max']), (30, 0, 100));
      final progress = tagged(tree, 'Progress');
      expect(attrs(progress[0])['val'], 0.4);
      expect(attrs(progress[1]).containsKey('val'), isFalse, reason: 'indeterminate');
    });

    testWidgets('a dropdown is a picker with its choice as text; segments are a segmented picker', (tester) async {
      final tree = await pumpAndCapture(
        tester,
        Scaffold(
          body: Column(children: [
            DropdownButton<String>(
              value: 'tr',
              onChanged: (_) {},
              items: const [
                DropdownMenuItem(value: 'en', child: Text('English')),
                DropdownMenuItem(value: 'tr', child: Text('Türkçe')),
              ],
            ),
            SegmentedButton<int>(
              segments: const [
                ButtonSegment(value: 1, label: Text('Gün')),
                ButtonSegment(value: 2, label: Text('Hafta'))
              ],
              selected: const {1},
              onSelectionChanged: (_) {},
            ),
          ]),
        ),
      );
      final pickers = tagged(tree, 'Picker');
      expect(attrs(pickers[0])['mode'], 'select');
      expect(textOf(pickers[0]), 'Türkçe');
      expect(attrs(pickers[1])['mode'], 'segmented');
      expect(words(tree), containsAll(['Gün', 'Hafta']));
      expect(words(tree), isNot(contains('English')));
    });

    testWidgets('buttons are pressables with their label inside; disabled ones say so', (tester) async {
      final tree = await pumpAndCapture(
        tester,
        Scaffold(
          appBar: AppBar(actions: [IconButton(onPressed: () {}, tooltip: 'Ara', icon: const Icon(Icons.search))]),
          body: Column(children: [
            ElevatedButton(onPressed: () {}, child: const Text('Kaydet')),
            const TextButton(onPressed: null, child: Text('Gönder')),
            InkWell(onTap: () {}, child: const Padding(padding: EdgeInsets.all(8), child: Text('Satır'))),
            GestureDetector(onTap: () {}, child: const Text('Dokun')),
          ]),
          floatingActionButton: FloatingActionButton(onPressed: () {}, tooltip: 'Ekle', child: const Icon(Icons.add)),
        ),
      );
      final pressables = tagged(tree, 'Pressable');
      Map<String, Object?> holding(String text) =>
          pressables.firstWhere((p) => elements(p).any((e) => textOf(e) == text));
      expect(attrs(holding('Kaydet'))['role'], 'button');
      expect(attrs(holding('Gönder'))['disabled'], isTrue);
      expect(holding('Satır'), isNotNull);
      expect(holding('Dokun'), isNotNull);
      final search = pressables.firstWhere((p) => attrs(p)['aria-label'] == 'Ara');
      expect(attrs(tagged(search, 'Icon').single)['glyph'], 'search');
      expect(pressables.where((p) => attrs(p)['aria-label'] == 'Ekle'), hasLength(1));
      // One control is one Pressable, however many widgets build it.
      expect(elements(search).where((e) => e['tagName'] == 'Pressable'), hasLength(1));
    });
  });

  group('layers', () {
    testWidgets('a dialog is a Modal over the screen with its dimming, and what it shows inside', (tester) async {
      usePhone(tester);
      await tester.pumpWidget(MaterialApp(
        home: Builder(
            builder: (context) => Scaffold(
                  body: Center(
                      child: ElevatedButton(
                    onPressed: () => showDialog<void>(
                        context: context,
                        builder: (_) =>
                            const AlertDialog(title: Text('Silinsin mi?'), content: Text('Geri alınamaz.'))),
                    child: const Text('Sil'),
                  )),
                )),
      ));
      await tester.tap(find.text('Sil'));
      await tester.pumpAndSettle();
      final tree = asJson(captureNow(tester));
      final modal = tagged(tree, 'Modal').single;
      expect((tree['childNodes']! as List), contains(same(modal)));
      expect(attrs(modal), containsPair('bg', '#0000008a'));
      expect(words(modal), containsAll(['Silinsin mi?', 'Geri alınamaz.']));
      expect(words(modal), isNot(contains('Sil')), reason: 'the page under it is not inside the layer');
    });

    testWidgets('a modal bottom sheet is a Sheet inside its Modal; a persistent one sits on Screen', (tester) async {
      usePhone(tester);
      await tester.pumpWidget(MaterialApp(
        home: Builder(
            builder: (context) => Scaffold(
                  body: Column(children: [
                    ElevatedButton(
                      onPressed: () => showModalBottomSheet<void>(
                        context: context,
                        builder: (_) => const SizedBox(height: 200, width: double.infinity, child: Text('Paylaş')),
                      ),
                      child: const Text('Aç'),
                    ),
                  ]),
                )),
      ));
      await tester.tap(find.text('Aç'));
      await tester.pumpAndSettle();
      final tree = asJson(captureNow(tester));
      final modal = tagged(tree, 'Modal').single;
      final sheet = tagged(modal, 'Sheet').single;
      expect(words(sheet), contains('Paylaş'));
      expect(attrs(sheet)['bg'], isNotNull);

      await tester.pumpWidget(const SizedBox());
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: const Text('Sayfa'),
          bottomSheet:
              BottomSheet(onClosing: () {}, builder: (_) => const SizedBox(height: 100, child: Text('Sepet özeti'))),
        ),
      ));
      final persistent = asJson(captureNow(tester));
      final hoisted = tagged(persistent, 'Sheet').single;
      expect((persistent['childNodes']! as List), contains(same(hoisted)));
      expect(screenRect(persistent, hoisted).bottom, 844);
    });

    testWidgets('a popup menu is a layer too', (tester) async {
      final tree = await pumpAndCapture(
        tester,
        Scaffold(
          appBar: AppBar(actions: [
            PopupMenuButton<int>(itemBuilder: (_) => const [PopupMenuItem(value: 1, child: Text('Paylaş'))]),
          ]),
        ),
      );
      expect(tagged(tree, 'Modal'), isEmpty);
      await tester.tap(find.byType(PopupMenuButton<int>));
      await tester.pumpAndSettle();
      final open = asJson(captureNow(tester));
      expect(words(tagged(open, 'Modal').single), contains('Paylaş'));
    });

    testWidgets('the keyboard and the system bars are frames on Screen', (tester) async {
      usePhone(tester);
      tester.view.padding = const FakeViewPadding(top: 47 * 3, bottom: 34 * 3);
      tester.view.viewPadding = const FakeViewPadding(top: 47 * 3, bottom: 34 * 3);
      await tester.pumpWidget(const MaterialApp(home: Scaffold(body: Text('x'))));
      var tree = asJson(captureNow(tester));
      final bars = tagged(tree, 'SystemBar');
      expect(bars.map(attrs).map((a) => (a['y'], a['h'])), [(0, 47), (810, 34)]);
      expect(tagged(tree, 'Keyboard'), isEmpty);

      tester.view.viewInsets = const FakeViewPadding(bottom: 336 * 3);
      tester.view.padding = const FakeViewPadding(top: 47 * 3);
      await tester.pump();
      tree = asJson(captureNow(tester));
      final keyboard = tagged(tree, 'Keyboard').single;
      expect(attrs(keyboard), {'x': 0, 'y': 508, 'w': 390, 'h': 336});
      expect(keyboard['childNodes'], isEmpty);
      expect(tagged(tree, 'SystemBar'), hasLength(1));
    });
  });

  group('what is not on screen', () {
    testWidgets('Offstage, Visibility, Opacity 0, IndexedStack and covered routes are left out', (tester) async {
      usePhone(tester);
      await tester.pumpWidget(MaterialApp(
        initialRoute: '/b',
        routes: {
          '/': (_) => const Scaffold(body: Text('Altta kalan sayfa')),
          '/b': (_) => const Scaffold(
                body: Column(children: [
                  Offstage(child: Text('Offstage')),
                  Visibility(visible: false, child: Text('Görünmez')),
                  Opacity(opacity: 0, child: Text('Saydam')),
                  Opacity(opacity: 0.5, child: Text('Yarım')),
                  IndexedStack(index: 1, children: [Text('Sekme 1'), Text('Sekme 2')]),
                ]),
              ),
        },
      ));
      await tester.pumpAndSettle();
      final tree = asJson(captureNow(tester));
      final all = words(tree);
      expect(all, containsAll(['Yarım', 'Sekme 2']));
      for (final hidden in ['Offstage', 'Görünmez', 'Saydam', 'Sekme 1', 'Altta kalan sayfa']) {
        expect(all, isNot(contains(hidden)), reason: hidden);
      }
      expect(attrs(withText(tree, 'Yarım')!)['op'], 0.5);
    });
  });

  group('looks', () {
    testWidgets('backgrounds, corners, borders, gradients, circles', (tester) async {
      final tree = await pumpAndCapture(
        tester,
        Scaffold(
          body: Column(children: [
            Container(
              width: 100,
              height: 40,
              decoration: BoxDecoration(
                  color: const Color(0xFF7C3AED),
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: const Color(0xFF000000), width: 2)),
            ),
            Container(
              width: 100,
              height: 40,
              decoration: const BoxDecoration(
                  gradient: LinearGradient(
                      begin: Alignment.topCenter,
                      end: Alignment.bottomCenter,
                      colors: [Color(0xFFA78BFA), Color(0xFFEDE9FE)])),
            ),
            Container(
                width: 48,
                height: 48,
                decoration: const BoxDecoration(color: Color(0xFFFF0000), shape: BoxShape.circle)),
            const Card(child: SizedBox(width: 100, height: 40)),
            const ColoredBox(color: Color(0xFF00FF00), child: SizedBox(width: 10, height: 10)),
            const SizedBox(width: 50, height: 50, child: DecoratedBox(decoration: BoxDecoration())),
          ]),
        ),
      );
      final views = tagged(tree, 'View').map(attrs).toList();
      expect(
          views,
          contains(allOf(containsPair('bg', '#7c3aed'), containsPair('r', 12), containsPair('bw', 2),
              containsPair('bc', '#000000'))));
      expect(views, contains(containsPair('grad', '0.5,0,0.5,1|#a78bfa@0|#ede9fe@1')));
      expect(views, contains(allOf(containsPair('bg', '#ff0000'), containsPair('r', 24))));
      expect(views, contains(allOf(containsPair('r', 12), contains('bg'))), reason: 'a Card');
      expect(views, contains(containsPair('bg', '#00ff00')));
      expect(views.where((v) => v['w'] == 50 && v['h'] == 50), isEmpty,
          reason: 'a box that draws nothing is not recorded');
    });

    testWidgets('a background exactly under a button is the button\'s own', (tester) async {
      final tree = await pumpAndCapture(
        tester,
        Scaffold(
            body: Center(
                child:
                    SizedBox(width: 200, height: 56, child: FilledButton(onPressed: () {}, child: const Text('Öde'))))),
      );
      final button = tagged(tree, 'Pressable').single;
      expect(attrs(button)['bg'], isNotNull);
      expect(tagged(button, 'View'), isEmpty);
    });
  });

  group('icons and images', () {
    testWidgets('icons by name, never by code point', (tester) async {
      final tree = await pumpAndCapture(
        tester,
        const Scaffold(
          body: Column(children: [
            Icon(Icons.shopping_cart_outlined, color: Color(0xFF7C3AED), semanticLabel: 'Sepet'),
            Icon(CupertinoIcons.heart_fill),
            Text('', style: TextStyle(fontFamily: 'MaterialIcons')),
            Icon(IconData(0xe000, fontFamily: 'MyIcons')),
          ]),
        ),
      );
      final icons = tagged(tree, 'Icon').map(attrs).toList();
      expect(
          icons[0],
          allOf(containsPair('iconSet', 'material'), containsPair('glyph', 'shopping_cart'),
              containsPair('color', '#7c3aed'), containsPair('aria-label', 'Sepet')));
      expect(icons[1], allOf(containsPair('iconSet', 'sf'), containsPair('glyph', 'heart.fill')));
      // Flutter's own numbering: its e8b6 is not what Google's font calls e8b6.
      expect(icons[2], containsPair('glyph', namedIconFor(0xe8b6, 'MaterialIcons')!.name));
      expect(icons[3].containsKey('glyph'), isFalse, reason: 'an app\'s own font: an icon was here');
      expect(tagged(tree, 'Text'), isEmpty);
    });

    testWidgets('a network image by address; an asset by its hash once known; a file by neither', (tester) async {
      final hashes = <String, String>{'assets/logo.png': 'a' * 64};
      final tree = await pumpAndCapture(
        tester,
        Scaffold(
          body: Column(children: [
            Image.network('https://cdn.example.com/a.jpg',
                width: 50,
                height: 50,
                fit: BoxFit.contain,
                semanticLabel: 'Ürün',
                errorBuilder: (_, __, ___) => const SizedBox(width: 50, height: 50)),
            Image(
                image: ResizeImage(const NetworkImage('https://cdn.example.com/b.jpg'), width: 10),
                width: 50,
                height: 50,
                errorBuilder: (_, __, ___) => const SizedBox(width: 50, height: 50)),
            Image.asset('assets/logo.png',
                width: 50, height: 50, errorBuilder: (_, __, ___) => const SizedBox(width: 50, height: 50)),
            Image.asset('assets/new.png',
                width: 50, height: 50, errorBuilder: (_, __, ___) => const SizedBox(width: 50, height: 50)),
            Image.memory(Uint8List(0),
                width: 50, height: 50, errorBuilder: (_, __, ___) => const SizedBox(width: 50, height: 50)),
          ]),
        ),
        settings: CaptureSettings(assetHash: (key) => hashes[key]),
      );
      final images = tagged(tree, 'Image').map(attrs).toList();
      expect(images, hasLength(5));
      expect(
          images[0],
          allOf(containsPair('src', 'https://cdn.example.com/a.jpg'), containsPair('fit', 'contain'),
              containsPair('alt', 'Ürün')));
      expect(images[1]['src'], 'https://cdn.example.com/b.jpg');
      expect(images[2]['asset'], 'a' * 64);
      expect(images[3].containsKey('asset'), isFalse, reason: 'not uploaded yet: neither asset nor src');
      expect(images[4].containsKey('src') || images[4].containsKey('asset'), isFalse);
    });

    testWidgets('maskImages: no address, no asset, masked', (tester) async {
      final tree = await pumpAndCapture(
        tester,
        Scaffold(
            body: Image.network('https://cdn.example.com/a.jpg',
                width: 50,
                height: 50,
                semanticLabel: 'Yüz',
                errorBuilder: (_, __, ___) => const SizedBox(width: 50, height: 50))),
        settings: const CaptureSettings(maskImages: true),
      );
      final image = attrs(tagged(tree, 'Image').single);
      expect(image['masked'], isTrue);
      expect(image.containsKey('src'), isFalse);
      expect(image['alt'], '••••••');
    });
  });

  group('masking', () {
    testWidgets('everything inside AnyReplayMask is masked', (tester) async {
      final tree = await pumpAndCapture(
        tester,
        Scaffold(
          body: AnyReplayMask(
            child: Container(
              color: const Color(0xFFF7F7F8),
              child: Column(children: [
                const Text('Bağdat Cd. 12'),
                Semantics(label: 'Ev adresi', child: const Icon(Icons.home)),
                Image.network('https://cdn.example.com/kapı.jpg',
                    width: 40, height: 40, errorBuilder: (_, __, ___) => const SizedBox(width: 40, height: 40)),
                const TextField(decoration: InputDecoration(hintText: 'Kat')),
              ]),
            ),
          ),
        ),
      );
      final box = tagged(tree, 'View').firstWhere((v) => attrs(v)['bg'] == '#f7f7f8');
      for (final e in elements(box)) {
        expect(attrs(e)['masked'], isTrue, reason: '${e['tagName']}');
      }
      expect(textOf(withText(tree, '••••••')!), '••••••');
      expect(words(tree), isNot(contains('Bağdat Cd. 12')));
      expect(words(tree), isNot(contains('Ev adresi')));
      expect(words(tree), contains('Kat'), reason: 'a placeholder is the app\'s copy and survives masking');
      expect(attrs(tagged(box, 'Image').single).containsKey('src'), isFalse);
    });
  });

  group('what cannot be read', () {
    testWidgets('an app\'s own painting is a labelled Canvas; web views are opaque and never read', (tester) async {
      final tree = await pumpAndCapture(
        tester,
        Scaffold(
          body: Column(children: [
            Semantics(label: 'Satış grafiği', child: CustomPaint(size: const Size(200, 100), painter: _Chart())),
            const SizedBox(width: 300, height: 200, child: WebViewWidget()),
            const SizedBox(width: 300, height: 100, child: Texture(textureId: 1)),
            const TextField(),
          ]),
        ),
      );
      final canvas = tagged(tree, 'Canvas').single;
      expect(attrs(canvas)['aria-label'], 'Satış grafiği');
      expect(attrs(canvas)['w'], 200);
      final web = tagged(tree, 'WebView').single;
      expect(web['childNodes'], isEmpty);
      expect(words(tree).join(), isNot(contains('pay.example.com')));
      expect(tagged(tree, 'Video'), hasLength(1));
      expect(tagged(tree, 'Canvas'), hasLength(1),
          reason: 'the framework\'s own painters (the field\'s border) are not drawings');
    });
  });

  testWidgets('a busy screen of ~300 nodes is read quickly', (tester) async {
    usePhone(tester, size: const Size(390, 3200));
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: Wrap(children: [
          for (var i = 0; i < 100; i += 1)
            Container(
              width: 190,
              height: 60,
              color: const Color(0xFFFAFAFA),
              child: Row(children: [const Icon(Icons.star), Expanded(child: Text('Ürün $i'))]),
            ),
        ]),
      ),
    ));
    final capture = TreeCapture(const CaptureSettings());
    captureNow(tester, with_: capture);
    final watch = Stopwatch()..start();
    const runs = 20;
    for (var i = 0; i < runs; i += 1) {
      captureNow(tester, with_: capture);
    }
    final perCapture = watch.elapsedMicroseconds / runs / 1000;
    expect(capture.lastNodeCount, greaterThanOrEqualTo(300));
    // A JIT test build, not a release device: a ceiling, not the target.
    expect(perCapture, lessThan(40));
    // ignore: avoid_print
    print('capture of ${capture.lastNodeCount} nodes: ${perCapture.toStringAsFixed(2)} ms (debug JIT)');
  });
}
