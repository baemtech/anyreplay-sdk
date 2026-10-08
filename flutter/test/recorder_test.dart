import 'dart:convert';
import 'dart:ui' show Size;

import 'package:anyreplay_flutter/anyreplay_flutter.dart';
import 'package:anyreplay_flutter/src/device.dart';
import 'package:anyreplay_flutter/src/diagnostics.dart';
import 'package:anyreplay_flutter/src/options.dart';
import 'package:anyreplay_flutter/src/recorder.dart';
import 'package:anyreplay_flutter/src/session.dart';
import 'package:anyreplay_flutter/src/tree.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

import 'harness.dart';
import 'support.dart' show testKey;

/// The recorder's rules (contract §3, §5, §8), driven through a fake host:
/// no widgets, a clock and timers the test moves by hand.
class FakeHost implements RecorderHost {
  FakeHost(this.ingest);

  final FakeIngest ingest;
  int clock = 1760000000000;
  Size size = const Size(390, 844);
  String text = 'Merhaba';
  bool hasScreen = true;
  final Map<Object, void Function()> timers = {};
  void Function(double, double)? taps;
  final FakeErrorHooks hooks = FakeErrorHooks();
  int captures = 0;

  @override
  int now() => clock;
  @override
  Size screenSize() => size;
  @override
  DeviceDescription device() => iphone;
  @override
  String? locale() => 'tr-TR';
  @override
  http.Client get client => ingest.client;
  @override
  ErrorHooks get errorHooks => hooks;

  @override
  MobileNode? capture(Size size) {
    captures += 1;
    if (!hasScreen) return null;
    return MobileNode.element(1, 'Screen', {'x': 0, 'y': 0, 'w': size.width.round(), 'h': size.height.round()})
      ..children.add(
          MobileNode.element(2, 'Text', {'x': 0, 'y': 0, 'w': 100, 'h': 20})..children.add(MobileNode.text(3, text)));
  }

  @override
  Object setInterval(void Function() callback, Duration every) {
    final handle = Object();
    timers[handle] = callback;
    return handle;
  }

  @override
  void clearInterval(Object handle) => timers.remove(handle);
  @override
  void attachTaps(void Function(double x, double y) onTap) => taps = onTap;
  @override
  void detachTaps() => taps = null;

  void advance(int ms) => clock += ms;
}

Future<(Recorder, FakeHost, MemoryStore)> start({
  bool requireConsent = false,
  double sampleRate = 1,
  MemoryStore? store,
  FakeIngest? ingest,
  int? cap,
}) async {
  final host = FakeHost(ingest ?? FakeIngest());
  final memory = store ?? MemoryStore();
  final options = ResolvedOptions.resolve(
    AnyReplayOptions(
        projectKey: testKey, requireConsent: requireConsent, sampleRate: sampleRate, maxSessionsPerMonth: cap),
    platformAppId: 'com.example.shop',
    platformAppVersion: '3.4.1',
  );
  final recorder = await Recorder.create(options, host, memory);
  return (recorder, host, memory);
}

List<Map<String, Object?>> eventsOf(FakeIngest ingest) => ingest.events;

void main() {
  test('opens with a Meta of the size, the screen, then a full snapshot; diffs after; nothing when nothing changed',
      () async {
    final (recorder, host, _) = await start();
    recorder.screen('/cart');
    host.advance(500);
    recorder.tick();
    host.text = 'Merhaba!';
    host.advance(500);
    recorder.tick();
    host.advance(500);
    recorder.tick();
    await recorder.flush();
    final events = eventsOf(host.ingest);
    expect([for (final e in events) e['type']], [4, 2, 4, 2, 3]);
    expect(events[0]['data'], {'width': 390, 'height': 844});
    expect(events[2]['data'], {'href': '/cart'});
    expect((events[4]['data']! as Map)['texts'], [
      {'id': 3, 'value': 'Merhaba!'}
    ]);
    final meta = host.ingest.chunks.first['meta']! as Map;
    expect(meta['url'], isNull, reason: 'the screen was named after recording started');
    expect(meta['lang'], 'tr-TR');
    expect(meta['screenWidth'], 390);
    expect(host.ingest.chunks.first['flags'], {'pageCount': 1});
  });

  test('a screen named before recording opens the recording and counts once', () async {
    final (recorder, host, _) = await start(requireConsent: true);
    recorder.screen('/home');
    recorder.consent(true);
    await pumpEventQueue();
    recorder.screen('/detail');
    await recorder.flush();
    final chunk = host.ingest.chunks.first;
    expect((chunk['meta']! as Map)['url'], '/home');
    expect(chunk['flags'], {'pageCount': 2});
    final hrefs = [
      for (final e in eventsOf(host.ingest))
        if (e['type'] == 4 && (e['data']! as Map).containsKey('href')) (e['data']! as Map)['href']
    ];
    expect(hrefs, ['/home', '/detail']);
  });

  test('no screen yet: no snapshot until there is one', () async {
    final (recorder, host, _) = await start();
    host.hasScreen = false;
    recorder.tick();
    host.hasScreen = true;
    recorder.tick();
    await recorder.flush();
    final snapshots = eventsOf(host.ingest).where((e) => e['type'] == 2);
    expect(snapshots, hasLength(1));
  });

  test('a rotation sends a Meta of the new size and a full snapshot', () async {
    final (recorder, host, _) = await start();
    host.size = const Size(844, 390);
    host.advance(500);
    recorder.tick();
    await recorder.flush();
    final types = [for (final e in eventsOf(host.ingest)) e['type']];
    expect(types, [4, 2, 4, 2]);
    expect(eventsOf(host.ingest)[2]['data'], {'width': 844, 'height': 390});
  });

  group('consent (contract §3.5)', () {
    test('before consent nothing is stored, sent or read', () async {
      final (recorder, host, store) = await start(requireConsent: true);
      recorder.track('a');
      recorder.trackError(Exception('boot'));
      recorder.identify(const IdentifyTraits(userId: 'u_1'));
      recorder.tick();
      await pumpEventQueue();
      expect(recorder.status, RecorderStatus.awaitingConsent);
      expect(store.values, isEmpty);
      expect(host.ingest.requests, isEmpty);
      expect(host.captures, 0);
      expect(host.timers, isEmpty);
      expect(host.hooks.flutterError, isNull);
      expect(host.taps, isNull);
    });

    test('consent(true) starts, sends what waited, stamped now, and flags the held error', () async {
      final (recorder, host, _) = await start(requireConsent: true);
      recorder.trackError(Exception('boot failed'));
      recorder.track('opened');
      recorder.identify(const IdentifyTraits(userId: 'u_1'));
      host.advance(5000);
      recorder.consent(true);
      await pumpEventQueue();
      expect(recorder.status, RecorderStatus.recording);
      await recorder.flush();
      final custom = eventsOf(host.ingest).where((e) => e['type'] == 5).toList();
      expect(custom.map((e) => (e['data']! as Map)['tag']), ['anyreplay.error', 'anyreplay.track']);
      expect(custom.every((e) => e['timestamp'] == host.clock), isTrue);
      expect((host.ingest.chunks.last['flags']! as Map)['hasError'], isTrue);
      await pumpEventQueue();
      expect(host.ingest.bodies('/identify').single, containsPair('userId', 'u_1'));
      expect(host.hooks.flutterError, isNotNull);
      expect(host.taps, isNotNull);
    });

    test('holds at most 32 events before consent, the oldest kept', () async {
      final (recorder, host, _) = await start(requireConsent: true);
      for (var i = 0; i < 40; i += 1) {
        recorder.track('e$i');
      }
      recorder.consent(true);
      await pumpEventQueue();
      await recorder.flush();
      final names = [
        for (final e in eventsOf(host.ingest))
          if (e['type'] == 5) ((e['data']! as Map)['payload'] as Map)['name']
      ];
      expect(names, [for (var i = 0; i < 32; i += 1) 'e$i']);
    });

    test('a refusal while waiting is an answer: a later yes still starts, as a new visitor', () async {
      final (recorder, host, store) = await start(requireConsent: true);
      recorder.consent(false);
      await pumpEventQueue();
      expect(recorder.status, RecorderStatus.awaitingConsent);
      expect(store.values, isEmpty, reason: 'a refusal before anything was stored stores nothing');
      recorder.consent(true);
      await pumpEventQueue();
      expect(recorder.status, RecorderStatus.recording);
      expect(host.ingest.requests, isEmpty, reason: 'nothing flushed yet');
    });

    test('a refusal during recording stops it and deletes every key', () async {
      final (recorder, host, store) = await start();
      recorder.tick();
      expect(store.values.keys, containsAll(['anyreplay.vid', 'anyreplay.sid', 'anyreplay.sts', 'anyreplay.seq']));
      recorder.consent(false);
      await pumpEventQueue();
      expect(recorder.status, RecorderStatus.stopped);
      expect(store.values.keys.where((k) => k.startsWith('anyreplay.') && k != 'anyreplay.assets'), isEmpty);
      expect(host.timers, isEmpty);
      expect(host.hooks.flutterError, isNull, reason: 'the handler that was there before is back');
      recorder.consent(true);
      await pumpEventQueue();
      expect(recorder.status, RecorderStatus.stopped,
          reason: 'a recording that was refused stays stopped for the launch');
    });

    test('a refusal that lands while consent is reading the store leaves nothing behind', () async {
      final (recorder, _, store) = await start(requireConsent: true);
      recorder.consent(true);
      recorder.consent(false);
      await pumpEventQueue();
      expect(recorder.status, RecorderStatus.awaitingConsent);
      expect(store.values.keys.where((k) => k.startsWith('anyreplay.')), isEmpty);
    });

    test('yes, no, yes in one breath ends recording', () async {
      final (recorder, _, _) = await start(requireConsent: true);
      recorder.consent(true);
      recorder.consent(false);
      recorder.consent(true);
      await pumpEventQueue();
      expect(recorder.status, RecorderStatus.recording);
    });

    test('stop() before consent means a later consent does not start', () async {
      final (recorder, host, _) = await start(requireConsent: true);
      recorder.stop();
      recorder.consent(true);
      await pumpEventQueue();
      expect(recorder.status, RecorderStatus.stopped);
      expect(host.ingest.requests, isEmpty);
    });
  });

  test('a sampled-out visitor is stored, and gets nothing else', () async {
    final (recorder, host, store) = await start(sampleRate: 0);
    expect(recorder.status, RecorderStatus.sampledOut);
    expect(store.values[visitorKey], isNotNull);
    recorder.track('x');
    recorder.tick();
    await pumpEventQueue();
    expect(host.ingest.requests, isEmpty);
    expect(host.timers, isEmpty);
  });

  test('a 402 stops, and no session starts for two minutes, across launches', () async {
    final ingest = FakeIngest()..scripted.add(http.Response('{"error":"quota_exceeded"}', 402));
    final store = MemoryStore();
    final (recorder, host, _) = await start(ingest: ingest, store: store);
    await recorder.flush();
    expect(recorder.status, RecorderStatus.stopped);
    await pumpEventQueue();
    expect(int.parse(store.values[cooldownKey]!), host.clock + quotaCooldownMs);

    final (again, _, _) = await start(store: store);
    expect(again.status, RecorderStatus.stopped);
  });

  test('sessionCap goes on seq 0 only', () async {
    final (recorder, host, store) = await start(cap: 500);
    await recorder.flush();
    expect((host.ingest.chunks.first['meta']! as Map)['sessionCap'], 500);
    final (resumed, other, _) = await start(cap: 500, store: store);
    await resumed.flush();
    expect((other.ingest.chunks.first['meta']! as Map).containsKey('sessionCap'), isFalse);
    expect(other.ingest.chunks.first['seq'], 1);
  });

  group('taps (contract §5.4)', () {
    test('rounded to whole points; three near one another within a second are rage', () async {
      final (recorder, host, _) = await start();
      recorder.touch(10.4, 10.6);
      host.advance(2000);
      recorder.touch(200, 700); // a stray tap elsewhere does not hide the burst
      host.advance(100);
      recorder.touch(195.2, 802);
      host.advance(400);
      recorder.touch(199, 804);
      await recorder.flush();
      expect(host.ingest.chunks.last['flags'], isNot(contains('hasRageClick')));
      host.advance(500);
      recorder.touch(170, 790); // 29 away in x from 199, 25 from 195: still near
      await recorder.flush();
      final taps = [
        for (final e in eventsOf(host.ingest))
          if (e['type'] == 3 && (e['data']! as Map)['source'] == 2) e['data']
      ];
      expect(taps.first, {'source': 2, 'type': 2, 'x': 10, 'y': 11});
      expect((host.ingest.chunks.last['flags']! as Map)['hasRageClick'], isTrue);
    });

    test('30 points apart is not near', () async {
      final (recorder, host, _) = await start();
      recorder.touch(100, 100);
      recorder.touch(130, 100);
      recorder.touch(100, 130);
      await recorder.flush();
      expect(host.ingest.chunks.last['flags'], isNot(contains('hasRageClick')));
    });
  });

  group('the app lifecycle (contract §5.7)', () {
    test('background flushes at once and stops every timer; returning restarts them with a whole screen', () async {
      final (recorder, host, _) = await start();
      host.advance(500);
      recorder.tick();
      expect(host.ingest.requests, isEmpty);
      await recorder.background();
      expect(host.ingest.chunks, hasLength(1));
      expect(host.timers, isEmpty);
      final before = host.captures;
      recorder.tick();
      expect(host.captures, before, reason: 'no reading the screen in the background');
      host.advance(60 * 1000);
      recorder.foreground();
      expect(host.timers, hasLength(2));
      recorder.tick();
      await recorder.flush();
      expect(eventsOf(host.ingest).last['type'], 2, reason: 'a full snapshot after returning');
      expect(host.ingest.chunks.map((c) => c['sessionId']).toSet(), hasLength(1));
    });

    test('an app left open and untouched for 30 minutes starts a new session at its next event', () async {
      final (recorder, host, _) = await start();
      recorder.screen('/cart');
      recorder.tick();
      final first = recorder.sessionId;
      host.advance(sessionIdleMs - 1);
      recorder.tick(); // nothing changed: no event, so no activity either
      expect(recorder.sessionId, first);
      host.advance(1);
      recorder.touch(10, 10);
      await recorder.flush();
      expect(recorder.sessionId, isNot(first));
      final second = host.ingest.chunks.where((c) => c['sessionId'] == recorder.sessionId).single;
      expect([for (final e in (second['events']! as List).cast<Map<String, Object?>>()) e['type']], [4, 4, 2, 3]);
      expect(second['seq'], 0);
    });

    test('consent given while in the background starts the timers when the app returns', () async {
      final (recorder, host, _) = await start(requireConsent: true);
      await recorder.background();
      recorder.consent(true);
      await pumpEventQueue();
      expect(recorder.status, RecorderStatus.recording);
      expect(host.timers, isEmpty);
      recorder.foreground();
      expect(host.timers, hasLength(2));
    });

    test('back after 30 idle minutes is a new session, with its own meta, Meta and snapshot', () async {
      final (recorder, host, _) = await start();
      recorder.identify(const IdentifyTraits(userId: 'u_1'));
      recorder.screen('/cart');
      await recorder.background();
      final first = recorder.sessionId;
      host.advance(31 * 60 * 1000);
      recorder.foreground();
      await recorder.flush();
      expect(recorder.sessionId, isNot(first));
      final second = host.ingest.chunks.where((c) => c['sessionId'] == recorder.sessionId).toList();
      expect(second.first['seq'], 0);
      expect((second.first['meta']! as Map)['url'], '/cart');
      expect([for (final e in (second.first['events']! as List).cast<Map<String, Object?>>()) e['type']], [4, 4, 2]);
      await pumpEventQueue();
      expect(host.ingest.bodies('/identify').map((b) => b['sessionId']), [first, recorder.sessionId]);
    });
  });

  test('errors: the hooks chain to the handlers before them and are put back on stop', () async {
    final (recorder, host, _) = await start();
    final seen = <String>[];
    // Installed after ours: stop must not put the old one back over it.
    final (r2, h2, _) = (recorder, host, null);
    expect(h2.hooks.flutterError, isNotNull);
    final ours = h2.hooks.flutterError!;
    h2.hooks.flutterError = (details) {
      seen.add('newer');
      ours(details);
    };
    r2.stop();
    expect(h2.hooks.flutterError, isNotNull, reason: 'a newer handler is left alone');

    final ingest = FakeIngest();
    final host3 = FakeHost(ingest);
    host3.hooks.flutterError = (details) => seen.add('app');
    host3.hooks.platformError = (error, stack) {
      seen.add('platform');
      return true;
    };
    final appHandler = host3.hooks.flutterError;
    final appPlatform = host3.hooks.platformError;
    final options =
        ResolvedOptions.resolve(const AnyReplayOptions(projectKey: testKey), platformAppId: 'com.example.shop');
    final rec = await Recorder.create(options, host3, MemoryStore());
    host3.hooks
        .flutterError!(FlutterErrorDetails(exception: StateError('layout ali@example.com'), stack: StackTrace.current));
    expect(host3.hooks.platformError!(Exception('async'), StackTrace.current), isTrue);
    await rec.flush();
    expect(seen, ['app', 'platform']);
    final errors = [
      for (final e in ingest.events)
        if (e['type'] == 5) (e['data']! as Map)['payload'] as Map
    ];
    expect(errors.map((e) => e['message']), ['Bad state: layout [redacted]', 'Exception: async']);
    expect(errors.every((e) => e['kind'] == 'error'), isTrue);
    expect((ingest.chunks.last['flags']! as Map)['hasError'], isTrue);
    rec.stop();
    expect(identical(host3.hooks.flutterError, appHandler), isTrue);
    expect(identical(host3.hooks.platformError, appPlatform), isTrue);
  });

  test('at most 100 errors per launch', () async {
    final (recorder, host, _) = await start();
    for (var i = 0; i < 120; i += 1) {
      recorder.trackError(Exception('e$i'));
    }
    await recorder.flush();
    await recorder.flush();
    expect(eventsOf(host.ingest).where((e) => e['type'] == 5), hasLength(100));
  });

  test('identify needs a user id or a valid e-mail', () async {
    final (recorder, host, _) = await start();
    recorder.identify(const IdentifyTraits());
    recorder.identify(const IdentifyTraits(email: 'not an address'));
    recorder.identify(const IdentifyTraits(email: 'ayse@example.com'));
    await recorder.flush();
    await pumpEventQueue();
    expect(host.ingest.bodies('/identify'), [
      {
        'projectKey': testKey,
        'sessionId': recorder.sessionId,
        'email': 'ayse@example.com',
        'appId': 'com.example.shop'
      },
    ]);
  });

  test('identify before the first chunk waits for it, so the session exists to be linked', () async {
    // Found on an iOS simulator: identify() right after init went out seconds
    // before the session's first chunk, ingest answered 202 { applied: false },
    // and the session was never linked to the person.
    final (recorder, host, _) = await start();
    recorder.identify(const IdentifyTraits(userId: 'u_9'));
    await pumpEventQueue();
    expect(host.ingest.bodies('/identify'), isEmpty);
    await recorder.flush();
    await pumpEventQueue();
    expect(host.ingest.bodies('/identify').single, containsPair('userId', 'u_9'));
    // Once the session exists, identify goes at once, and only once.
    recorder.identify(const IdentifyTraits(userId: 'u_10'));
    await pumpEventQueue();
    await recorder.flush(force: true);
    await pumpEventQueue();
    expect(host.ingest.bodies('/identify').map((b) => b['userId']), ['u_9', 'u_10']);
  });

  test('every chunk is valid JSON under 512 KB with sentAt not before its events', () async {
    final (recorder, host, _) = await start();
    for (var i = 0; i < 300; i += 1) {
      host.advance(10);
      recorder.touch(5, 5);
    }
    await recorder.flush();
    await recorder.flush();
    for (final chunk in host.ingest.chunks) {
      expect(utf8.encode(jsonEncode(chunk)).length, lessThan(512 * 1024));
      for (final e in (chunk['events']! as List).cast<Map<String, Object?>>()) {
        expect(e['timestamp']! as int, lessThanOrEqualTo(chunk['sentAt']! as int));
      }
    }
  });
}
