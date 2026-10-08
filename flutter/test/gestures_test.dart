import 'package:anyreplay_flutter/anyreplay_flutter.dart';
import 'package:anyreplay_flutter/src/gestures.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'harness.dart';
import 'support.dart';

void main() {
  group('the tap detector', () {
    late List<Offset> taps;
    late TapDetector detector;

    setUp(() {
      taps = [];
      detector = TapDetector((x, y) => taps.add(Offset(x, y)));
    });

    test('a tap is reported at touch-up, where the finger went down', () {
      detector.handleEvent(const PointerDownEvent(pointer: 1, position: Offset(100, 200)));
      expect(taps, isEmpty);
      detector.handleEvent(const PointerMoveEvent(pointer: 1, position: Offset(105, 204)));
      detector.handleEvent(const PointerUpEvent(pointer: 1, position: Offset(106, 205)));
      expect(taps, [const Offset(100, 200)]);
    });

    test('a drag past the slop is not a tap, even if it comes back', () {
      detector.handleEvent(const PointerDownEvent(pointer: 1, position: Offset(100, 200)));
      detector.handleEvent(const PointerMoveEvent(pointer: 1, position: Offset(100, 260)));
      detector.handleEvent(const PointerMoveEvent(pointer: 1, position: Offset(100, 201)));
      detector.handleEvent(const PointerUpEvent(pointer: 1, position: Offset(100, 201)));
      expect(taps, isEmpty);
    });

    test('a lift far from the start without moves in between is not a tap', () {
      detector.handleEvent(const PointerDownEvent(pointer: 1, position: Offset(100, 200)));
      detector.handleEvent(const PointerUpEvent(pointer: 1, position: Offset(100, 240)));
      expect(taps, isEmpty);
    });

    test('a cancelled pointer is never a tap', () {
      detector.handleEvent(const PointerDownEvent(pointer: 1, position: Offset(100, 200)));
      detector.handleEvent(const PointerCancelEvent(pointer: 1, position: Offset(100, 200)));
      detector.handleEvent(const PointerUpEvent(pointer: 1, position: Offset(100, 200)));
      expect(taps, isEmpty);
    });

    test('two fingers are two taps', () {
      detector.handleEvent(const PointerDownEvent(pointer: 1, position: Offset(10, 10)));
      detector.handleEvent(const PointerDownEvent(pointer: 2, position: Offset(50, 50)));
      detector.handleEvent(const PointerUpEvent(pointer: 2, position: Offset(50, 50)));
      detector.handleEvent(const PointerUpEvent(pointer: 1, position: Offset(10, 10)));
      expect(taps, [const Offset(50, 50), const Offset(10, 10)]);
    });

    test('the slop is the device\'s when it reports one', () {
      final strict = TapDetector((x, y) => taps.add(Offset(x, y)),
          gestureSettings: () => const DeviceGestureSettings(touchSlop: 4));
      strict.handleEvent(const PointerDownEvent(pointer: 1, position: Offset(0, 0)));
      strict.handleEvent(const PointerUpEvent(pointer: 1, position: Offset(6, 0)));
      expect(taps, isEmpty);
      expect(kTouchSlop, 18);
    });
  });

  testWidgets('taps are heard without changing what the app does with them', (tester) async {
    usePhone(tester);
    final ingest = FakeIngest();
    final clock = TestClock();
    AnyReplay.reset();
    final routesBefore = GestureBinding.instance.pointerRouter.debugGlobalRouteCount;
    await AnyReplay.init(const AnyReplayOptions(projectKey: testKey), environment: testEnvironment(ingest, clock));
    var pressed = 0;
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: ListView(children: [
          for (var i = 0; i < 40; i += 1) ListTile(title: Text('Satır $i')),
          ElevatedButton(onPressed: () => pressed += 1, child: const Text('Kaydet')),
        ]),
      ),
    ));
    await tester.fling(find.byType(ListView), const Offset(0, -800), 2000);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Kaydet'));
    await tester.pump();
    expect(pressed, 1);
    await AnyReplay.flush();
    final taps = [
      for (final e in ingest.events)
        if (e['type'] == 3 && (e['data']! as Map)['source'] == 2) e['data']
    ];
    expect(taps, hasLength(1), reason: 'the fling is not a tap');
    final center = tester.getCenter(find.text('Kaydet'));
    expect(taps.single, {'source': 2, 'type': 2, 'x': center.dx.round(), 'y': center.dy.round()});
    expect(AnyReplay.status, RecorderStatus.recording);
    AnyReplay.reset();
    expect(GestureBinding.instance.pointerRouter.debugGlobalRouteCount, routesBefore,
        reason: 'the route is removed on stop');
  });
}
