import 'dart:convert';
import 'dart:io';

import 'package:anyreplay_flutter/anyreplay_flutter.dart';
import 'package:anyreplay_flutter/src/device.dart';
import 'package:anyreplay_flutter/src/diagnostics.dart';
import 'package:anyreplay_flutter/src/session.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'harness.dart';
import 'shop_app.dart';
import 'support.dart';

/// The Flutter SDK, recording the contract's conformance scenario (§14.3)
/// on a real tree of Flutter's own widgets.
///
/// Nothing between the screen and the wire is faked: Flutter builds and lays
/// out the app, the capture reads its element and render trees, the recorder
/// diffs and the transport builds the bodies. Only the clock, the network
/// and the device description are stand-ins. The bodies are written to
/// build/anyreplay-conformance/, and the monorepo's checker reads them:
///
///   pnpm --filter @anyreplay/shared conformance packages/recorder-flutter/build/anyreplay-conformance/*.ndjson
Future<FakeIngest> recordScenario(WidgetTester tester, DeviceDescription device, {ErrorHooks? errorHooks}) async {
  usePhone(tester);
  final ingest = FakeIngest();
  final clock = TestClock();
  AnyReplay.reset();
  await AnyReplay.init(
    const AnyReplayOptions(projectKey: testKey, requireConsent: true),
    environment: testEnvironment(ingest, clock, device: device, errorHooks: errorHooks),
  );

  // A crash during boot, before the person answered the consent prompt.
  AnyReplay.trackError(Exception('Ödeme servisi yanıt vermedi: ali@example.com'));
  await tester.pumpWidget(ShopApp(observer: AnyReplayNavigatorObserver()));
  expect(AnyReplay.status, RecorderStatus.awaitingConsent);
  expect(ingest.requests, isEmpty);

  AnyReplay.consent(true);
  await tester.pump();
  expect(AnyReplay.status, RecorderStatus.recording);
  AnyReplay.identify(userId: 'u_1842');
  AnyReplay.track('cart_viewed', {'items': 2});

  await tickAfter(tester, clock, 500);
  tester.state<CartScreenState>(find.byType(CartScreen)).addOne();
  await tester.enterText(find.byKey(const Key('coupon')), 'YAZ25');
  await tester.enterText(find.byKey(const Key('password')), 'hunter2');
  await tickAfter(tester, clock, 500);
  await tickAfter(tester, clock, 500); // nothing changed: nothing is sent

  // A scroll through the list: an attribute change on the scroll view, never a tap.
  await tester.drag(find.byKey(const Key('cart-list')), const Offset(0, -160));
  await tester.pumpAndSettle();
  await tickAfter(tester, clock, 500);
  await tester.tap(find.byType(Switch));
  await tickAfter(tester, clock, 500);
  await AnyReplay.flush();

  // One tap somewhere else, then three on the button that does not answer.
  final devam = tester.getCenter(find.text('Devam'));
  await tester.tapAt(const Offset(200, 700));
  clock.advance(300);
  await tester.tapAt(devam);
  clock.advance(200);
  await tester.tapAt(devam + const Offset(4, 2));
  clock.advance(200);
  await tester.tapAt(devam + const Offset(-3, -1));
  await tickAfter(tester, clock, 300);

  // The second screen.
  tester.state<NavigatorState>(find.byType(Navigator)).pushNamed('/payment');
  await settle(tester);
  await tickAfter(tester, clock, 300);
  await tester.enterText(find.byKey(const Key('card')), '4242 4242 4242 4242');
  await tester.enterText(find.byKey(const Key('name')), '4111111111111111');
  await tickAfter(tester, clock, 500);
  await tester.tap(find.text('Öde'));
  await settle(tester);
  await tickAfter(tester, clock, 500);
  await tester.tap(find.text('Onayla'));
  await settle(tester);
  await tickAfter(tester, clock, 500);

  // Turned on its side: a new canvas, and a whole screen on it.
  tester.view.physicalSize = const Size(844, 390) * 3;
  await tester.pump();
  await tickAfter(tester, clock, 500);

  // To the background: the tail is flushed at once.
  tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
  tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
  await tester.pump();
  tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
  await tester.pump();
  // Back, and done.
  tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
  tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
  tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
  AnyReplay.stop();
  AnyReplay.reset();
  return ingest;
}

/// The payment screen has a spinner, which never settles.
Future<void> settle(WidgetTester tester) async {
  for (var i = 0; i < 10; i += 1) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

void main() {
  testWidgets('records the scenario on an iPhone', (tester) async {
    final ingest = await recordScenario(tester, iphone, errorHooks: const FlutterErrorHooks());
    dump('flutter-iphone', ingest);
    dumpEnvelope('flutter-endpoints', ingest);

    expect(ingest.chunks.length, greaterThanOrEqualTo(2));
    final meta = ingest.chunks.first['meta']! as Map<String, Object?>;
    expect(meta['platform'], 'flutter');
    expect(meta['sdk'], {'name': 'anyreplay_flutter', 'version': sdkVersion});
    expect(meta['userAgent'], 'AnyReplayFlutter/0.1 (iPhone; iOS 18.0; iPhone15,2) Mobile');
    expect(meta['url'], '/cart');
    expect(meta['appVersion'], '3.4.1');
    expect(ingest.chunks.every((c) => c['appId'] == 'com.example.shop'), isTrue);
    // Uploaded once, then referenced by hash.
    expect(ingest.bodies('/v1/ingest/assets'), hasLength(1));
    expect(ingest.wire, contains('"asset":"${ingest.bodies('/v1/ingest/assets').single['sha256']}"'));
  });

  testWidgets('records the scenario on an Android tablet-free phone', (tester) async {
    final ingest = await recordScenario(tester, android);
    dump('flutter-android', ingest);
    final meta = ingest.chunks.first['meta']! as Map<String, Object?>;
    expect(meta['userAgent'], 'AnyReplayFlutter/0.1 (Android 14; Pixel 8) Mobile');
    expect(meta['deviceModel'], 'Pixel 8');
  });

  testWidgets('sends an identify given right after init only once its session exists', (tester) async {
    usePhone(tester);
    final ingest = FakeIngest();
    final clock = TestClock();
    AnyReplay.reset();
    await AnyReplay.init(
      const AnyReplayOptions(projectKey: testKey),
      environment: testEnvironment(ingest, clock),
    );
    // The usual place: a stored login read at launch, on the line after init.
    AnyReplay.identify(userId: 'u_1842');
    await tester.pumpWidget(ShopApp(observer: AnyReplayNavigatorObserver()));
    await tickAfter(tester, clock, 500);
    await AnyReplay.flush();
    await tester.pump();
    AnyReplay.stop();
    AnyReplay.reset();
    // Every endpoint, in the order the requests left, so EVT-010 can judge identify.
    dumpEnvelope('flutter-identify', ingest);

    expect(ingest.requests.first.path, endsWith('/v1/ingest/events'));
    expect(ingest.identifies, hasLength(1));
    expect(ingest.linked, hasLength(1));
  });

  testWidgets('never sends what the masking floor keeps on the device', (tester) async {
    final ingest = await recordScenario(tester, iphone);
    final wire = ingest.wire;
    expect(wire, isNot(contains('hunter2')));
    expect(wire, isNot(contains('4242 4242 4242 4242')));
    expect(wire, isNot(contains('4242424242424242')));
    expect(wire, isNot(contains('4111111111111111')));
    expect(wire, isNot(contains('Bağdat')));
    expect(wire, isNot(contains('ali@example.com')));
    expect(wire, contains('YAZ25'));
  });

  testWidgets('sends the scenario in the shape the format describes', (tester) async {
    final ingest = await recordScenario(tester, iphone);
    final wire = ingest.wire;
    for (final tag in [
      'ScrollView',
      'Switch',
      'Checkbox',
      'Slider',
      'Progress',
      'TextInput',
      'Image',
      'Icon',
      'Pressable',
      'Modal'
    ]) {
      expect(wire, contains('"tagName":"$tag"'), reason: tag);
    }
    for (final fragment in [
      '"role":"header"',
      '"role":"button"',
      '"on":true',
      '"it":true',
      '"ff":"mono"',
      '"masked":true',
      '"iconSet":"material"',
      '"glyph":"favorite_border"',
      '"src":"https://cdn.example.com/kulaklik.jpg"',
      '"sx":0',
      '"sy":160'
    ]) {
      expect(wire, contains(fragment), reason: fragment);
    }
    final taps = ingest.events.where((e) => e['type'] == 3 && (e['data']! as Map)['source'] == 2).toList();
    // The switch, one stray tap, three on Devam, Öde and Onayla; the drag is none of them.
    expect(taps, hasLength(7));
    final last = ingest.chunks.last;
    expect((last['flags']! as Map)['hasRageClick'], isTrue);
    expect((last['flags']! as Map)['hasError'], isTrue);
    expect((last['flags']! as Map)['pageCount'], 2);
    final hrefs = [
      for (final e in ingest.events)
        if (e['type'] == 4 && (e['data']! as Map).containsKey('href')) (e['data']! as Map)['href'],
    ];
    expect(hrefs, ['/cart', '/payment']);
    final sizes = [
      for (final e in ingest.events)
        if (e['type'] == 4 && (e['data']! as Map).containsKey('width'))
          [(e['data']! as Map)['width'], (e['data']! as Map)['height']],
    ];
    expect(sizes, [
      [390, 844],
      [844, 390],
    ]);
  });

  testWidgets('an outage that overflows the buffer, then a long absence, still read as whole recordings',
      (tester) async {
    usePhone(tester);
    final ingest = FakeIngest(online: false);
    final clock = TestClock();
    AnyReplay.reset();
    await AnyReplay.init(
      const AnyReplayOptions(projectKey: testKey, maxBufferedEvents: 12, maxEventsPerChunk: 5),
      environment: testEnvironment(ingest, clock),
    );
    await tester.pumpWidget(const ShopApp());
    // Offline long enough for the oldest events — the snapshot among them — to go.
    for (var n = 0; n < 40; n += 1) {
      tester.state<CartScreenState>(find.byType(CartScreen)).addOne();
      if (n % 7 == 0) AnyReplay.track('tick', {'n': n});
      await tickAfter(tester, clock, 500);
      await AnyReplay.flush();
    }
    ingest.online = true;
    clock.advance(60000);
    AnyReplay.recorder!.foreground();
    await tickAfter(tester, clock, 500);
    await AnyReplay.flush();
    await AnyReplay.flush();
    final first = AnyReplay.sessionId;

    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    await tester.pump();
    clock.advance(31 * 60 * 1000);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    tester.state<CartScreenState>(find.byType(CartScreen)).addOne();
    await tickAfter(tester, clock, 500);
    await AnyReplay.flush();
    final second = AnyReplay.sessionId;
    AnyReplay.reset();

    expect(second, isNot(first));
    final sessions = {for (final c in ingest.chunks) c['sessionId']};
    expect(sessions, {first, second});
    final dir = Directory('build/anyreplay-conformance')..createSync(recursive: true);
    var i = 0;
    for (final id in [first, second]) {
      i += 1;
      final stream = ingest.chunks.where((c) => c['sessionId'] == id).map(jsonEncode).join('\n');
      File('${dir.path}/flutter-outage-$i.ndjson').writeAsStringSync('$stream\n');
    }
    // The first chunk delivered opens with a Meta and a full snapshot, and
    // the meta was re-stamped to that moment.
    final opening = ingest.chunks.firstWhere((c) => c['sessionId'] == first);
    final events = (opening['events']! as List).cast<Map<String, Object?>>();
    expect(events.first['type'], 4);
    expect(events.indexWhere((e) => e['type'] == 2), lessThan(events.indexWhere((e) => e['type'] == 3).clamp(0, 999)));
  });

  test('sampling decides what every native SDK decides (contract §3.4)', () {
    final file = File('../shared/test-fixtures/conformance/sampling-vectors.json');
    if (!file.existsSync()) {
      markTestSkipped('sampling-vectors.json lives in the AnyReplay monorepo');
      return;
    }
    final vectors =
        ((jsonDecode(file.readAsStringSync()) as Map<String, Object?>)['native']! as List).cast<Map<String, Object?>>();
    expect(vectors.length, greaterThan(100));
    for (final v in vectors) {
      final id = v['visitorId']! as String;
      final rate = (v['rate']! as num).toDouble();
      expect(samplingBucket(id), v['bucket'], reason: id);
      expect(isSampledIn(id, rate), v['sampled'], reason: '$id @ $rate');
    }
  });
}
