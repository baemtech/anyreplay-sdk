import 'dart:async';

import 'package:anyreplay_flutter/anyreplay_flutter.dart';
import 'package:anyreplay_flutter/src/diagnostics.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'harness.dart';
import 'support.dart';

/// The public API: `AnyReplay`, the navigator observer, the error hooks.
void main() {
  setUp(AnyReplay.reset);
  tearDown(AnyReplay.reset);

  testWidgets('calls made before init has finished are applied, in order', (tester) async {
    usePhone(tester);
    final ingest = FakeIngest();
    final clock = TestClock();
    final starting =
        AnyReplay.init(const AnyReplayOptions(projectKey: testKey), environment: testEnvironment(ingest, clock));
    AnyReplay.screen('/home');
    AnyReplay.track('opened', {'from': 'push'});
    AnyReplay.identify(userId: 'u_7');
    await starting;
    await tester.pumpWidget(const MaterialApp(home: Text('Merhaba')));
    AnyReplay.recorder!.tick();
    await AnyReplay.flush();
    expect(AnyReplay.status, RecorderStatus.recording);
    expect(AnyReplay.sessionId, matches(RegExp(r'^[0-9a-f-]{36}$')));
    final types = [for (final e in ingest.events) e['type']];
    expect(types.take(4), [4, 4, 2, 5],
        reason: 'size, the screen named before init finished, the snapshot, the tracked event');
    expect((ingest.chunks.first['meta']! as Map)['url'], '/home');
    await tester.runAsync(pumpEventQueue);
    expect(ingest.bodies('/identify').single['userId'], 'u_7');
  });

  testWidgets('a wrong key records nothing and throws nothing', (tester) async {
    final ingest = FakeIngest();
    final printed = <String>[];
    final original = debugPrint;
    debugPrint = (message, {wrapWidth}) => printed.add(message ?? '');
    try {
      await AnyReplay.init(const AnyReplayOptions(projectKey: 'ar_pk_live_nope'),
          environment: testEnvironment(ingest, TestClock()));
      AnyReplay.track('x');
      AnyReplay.consent(true);
      await AnyReplay.flush();
    } finally {
      debugPrint = original;
    }
    expect(AnyReplay.status, RecorderStatus.idle);
    expect(ingest.requests, isEmpty);
    expect(printed.single, contains('projectKey looks wrong'));
  });

  testWidgets('a second init is ignored', (tester) async {
    final ingest = FakeIngest();
    await AnyReplay.init(const AnyReplayOptions(projectKey: testKey),
        environment: testEnvironment(ingest, TestClock()));
    final first = AnyReplay.recorder;
    await AnyReplay.init(const AnyReplayOptions(projectKey: testKey, sampleRate: 0),
        environment: testEnvironment(ingest, TestClock()));
    expect(AnyReplay.recorder, same(first));
  });

  testWidgets('the navigator observer names screens by route; dialogs are not screens', (tester) async {
    usePhone(tester);
    final ingest = FakeIngest();
    final clock = TestClock();
    await AnyReplay.init(const AnyReplayOptions(projectKey: testKey), environment: testEnvironment(ingest, clock));
    final navigator = GlobalKey<NavigatorState>();
    await tester.pumpWidget(MaterialApp(
      navigatorKey: navigator,
      navigatorObservers: [AnyReplayNavigatorObserver()],
      routes: {
        '/': (_) => const Text('Ana sayfa'),
        '/orders': (_) => const Text('Siparişler'),
        '/orders/detail': (_) => const Text('Detay'),
      },
    ));
    navigator.currentState!.push(MaterialPageRoute<void>(
        settings: const RouteSettings(name: '/orders?page=2'), builder: (_) => const Text('Siparişler')));
    await tester.pumpAndSettle();
    unawaited(showDialog<void>(context: navigator.currentState!.overlay!.context, builder: (_) => const Text('Uyarı')));
    await tester.pumpAndSettle();
    navigator.currentState!.pop();
    await tester.pumpAndSettle();
    navigator.currentState!.push(MaterialPageRoute<void>(builder: (_) => const Text('Adsız')));
    await tester.pumpAndSettle();
    navigator.currentState!.pushReplacementNamed('/orders/detail');
    await tester.pumpAndSettle();
    navigator.currentState!.pop();
    await tester.pumpAndSettle();
    await AnyReplay.flush();
    final hrefs = [
      for (final e in ingest.events)
        if (e['type'] == 4 && (e['data']! as Map).containsKey('href')) (e['data']! as Map)['href'],
    ];
    expect(hrefs, ['/', '/orders', '/orders/detail', '/orders']);
  });

  testWidgets('a custom name for a route, and none for a route that should stay unnamed', (tester) async {
    usePhone(tester);
    final ingest = FakeIngest();
    await AnyReplay.init(const AnyReplayOptions(projectKey: testKey),
        environment: testEnvironment(ingest, TestClock()));
    await tester.pumpWidget(MaterialApp(
      navigatorObservers: [AnyReplayNavigatorObserver(nameOf: (route) => route.settings.name == '/' ? 'Home' : null)],
      home: const Text('x'),
    ));
    await AnyReplay.flush();
    final hrefs = [
      for (final e in ingest.events)
        if (e['type'] == 4 && (e['data']! as Map).containsKey('href')) (e['data']! as Map)['href']
    ];
    expect(hrefs, ['Home']);
  });

  testWidgets('Flutter\'s own error hooks: recorded, chained, and put back on stop', (tester) async {
    usePhone(tester);
    final ingest = FakeIngest();
    final before = FlutterError.onError;
    final seen = <Object>[];
    FlutterError.onError = (details) => seen.add(details.exception);
    final appHandler = FlutterError.onError;
    try {
      await AnyReplay.init(const AnyReplayOptions(projectKey: testKey),
          environment: testEnvironment(ingest, TestClock(), errorHooks: const FlutterErrorHooks()));
      expect(FlutterError.onError, isNot(same(appHandler)));
      FlutterError.reportError(FlutterErrorDetails(exception: StateError('render failed for ali@example.com')));
      expect(seen, hasLength(1), reason: 'the app\'s handler still runs');
      await AnyReplay.flush();
      AnyReplay.stop();
      expect(FlutterError.onError, same(appHandler));
    } finally {
      FlutterError.onError = before;
    }
    final error = ingest.events.firstWhere((e) => e['type'] == 5)['data']! as Map;
    expect(error['tag'], 'anyreplay.error');
    expect((error['payload'] as Map)['message'], 'Bad state: render failed for [redacted]');
  });

  testWidgets('recordErrors: false installs nothing', (tester) async {
    final hooks = FakeErrorHooks();
    await AnyReplay.init(const AnyReplayOptions(projectKey: testKey, recordErrors: false),
        environment: testEnvironment(FakeIngest(), TestClock(), errorHooks: hooks));
    expect(AnyReplay.status, RecorderStatus.recording);
    expect(hooks.flutterError, isNull);
    expect(hooks.platformError, isNull);
  });
}
