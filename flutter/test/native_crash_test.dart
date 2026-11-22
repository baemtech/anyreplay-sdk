import 'dart:convert';

import 'package:anyreplay_flutter/anyreplay_flutter.dart';
import 'package:anyreplay_flutter/src/native_crash.dart';
import 'package:anyreplay_flutter/src/options.dart';
import 'package:anyreplay_flutter/src/recorder.dart';
import 'package:anyreplay_flutter/src/session.dart' show clipRingKey, nativeKeptKey;
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'harness.dart';
import 'recorder_test.dart' show FakeHost;
import 'support.dart' show testKey;

/// The native side, faked: what `takeNativeCrash` answers, and what was asked.
class FakeNative implements NativeCrashSource {
  FakeNative([this.next]);
  String? next;
  int takes = 0;
  int installs = 0;
  int uninstalls = 0;

  @override
  Future<String?> take() async {
    takes += 1;
    final value = next;
    next = null;
    return value;
  }

  @override
  Future<void> install() async => installs += 1;
  @override
  Future<void> uninstall() async => uninstalls += 1;
}

Future<(Recorder, FakeHost)> launch({
  required MemoryStore store,
  required FakeIngest ingest,
  NativeCrashSource native = const NoNativeCrashSource(),
  double sampleRate = 1,
  bool? crashClip,
  bool recordErrors = true,
  bool requireConsent = false,
  int? clock,
}) async {
  final host = FakeHost(ingest);
  if (clock != null) host.clock = clock;
  final options = ResolvedOptions.resolve(
    AnyReplayOptions(
      projectKey: testKey,
      sampleRate: sampleRate,
      crashClip: crashClip,
      recordErrors: recordErrors,
      requireConsent: requireConsent,
    ),
    platformAppId: 'com.example.shop',
  );
  final recorder = await Recorder.create(options, host, store, nativeCrash: native);
  await pumpEventQueue();
  return (recorder, host);
}

void fire(FakeHost host) {
  for (final callback in List.of(host.timers.values)) {
    callback();
  }
}

String androidCrash(int ts, {String message = 'boom for ayse@example.com'}) => jsonEncode({
      'v': 1,
      'ts': ts,
      'platform': 'android',
      'name': 'java.lang.IllegalStateException',
      'message': message,
      'stack':
          'java.lang.IllegalStateException: $message\n\tat com.example.shop.MainActivity.crash(MainActivity.kt:12)',
    });

Map<String, Object?> payloadOf(Map<String, Object?> event) =>
    ((event['data']! as Map)['payload']! as Map).cast<String, Object?>();

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('what the native side wrote', () {
    test('the JSON record of the Kotlin and Objective-C handlers', () {
      final crash = parseNativeCrash(androidCrash(1760000000123))!;
      expect(crash.ts, 1760000000123);
      expect(crash.platform, 'android');
      expect(crash.name, 'java.lang.IllegalStateException');
      final payload = payloadOf(crash.toEvent());
      expect(payload['kind'], 'fatal');
      expect(payload['native'], true);
      expect(payload['message'], 'boom for [redacted]');
      expect(payload['stack'], contains('[redacted]'));
      expect(payload['stack'], isNot(contains('ayse@')));
    });

    test('the line the iOS signal handler writes, in seconds or milliseconds', () {
      final segv = parseNativeCrash('SIG\t11\t1760000000\n')!;
      expect(segv.name, 'SIGSEGV');
      expect(segv.ts, 1760000000000);
      expect(segv.platform, 'ios');
      expect(segv.message, startsWith('Fatal signal SIGSEGV'));
      expect(parseNativeCrash('SIG\t5\t1760000000456')!.ts, 1760000000456);
      expect(parseNativeCrash('SIG\t5\t1760000000')!.name, 'SIGTRAP');
      expect(parseNativeCrash('SIG\t99\t1760000000')!.name, 'SIG99');
    });

    test('nothing, or anything else, is no crash', () {
      for (final raw in [
        null,
        '',
        '  \n',
        'SIG\tx\t1',
        'SIG\t6',
        '{"v":2,"ts":1,"name":"x"}',
        '{"v":1}',
        'garbage',
        '[]'
      ]) {
        expect(parseNativeCrash(raw), isNull, reason: '$raw');
      }
    });
  });

  group('the method channel', () {
    const channel = MethodChannel(nativeCrashChannelName);
    final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    tearDown(() => messenger.setMockMethodCallHandler(channel, null));

    test('takes what the native side kept', () async {
      final calls = <String>[];
      messenger.setMockMethodCallHandler(channel, (call) async {
        calls.add(call.method);
        return call.method == 'takeNativeCrash' ? 'SIG\t6\t1760000000' : null;
      });
      const source = MethodChannelNativeCrashSource();
      expect(await source.take(), 'SIG\t6\t1760000000');
      await source.install();
      await source.uninstall();
      expect(calls, ['takeNativeCrash', 'install', 'uninstall']);
    });

    test('without the plugin (web, desktop, a test) every call is a quiet no-op', () async {
      const source = MethodChannelNativeCrashSource();
      expect(await source.take(), isNull);
      await source.install();
      await source.uninstall();
    });

    test('a native side that fails is no crash either', () async {
      messenger.setMockMethodCallHandler(channel, (call) async => throw PlatformException(code: 'io'));
      expect(await const MethodChannelNativeCrashSource().take(), isNull);
    });

    test('a recorder over the channel with no plugin records as before', () async {
      final ingest = FakeIngest();
      final (recorder, _) =
          await launch(store: MemoryStore(), ingest: ingest, native: const MethodChannelNativeCrashSource());
      expect(recorder.status, RecorderStatus.recording);
      await recorder.flush();
      expect(ingest.chunks, hasLength(1));
    });
  });

  group('a crash in a recorded launch', () {
    test('goes into the recording it ended, with the next chunk number, stamped at the crash', () async {
      final store = MemoryStore();
      final ingest = FakeIngest();
      final (first, host) = await launch(store: store, ingest: ingest);
      await first.flush();
      host.advance(3000);
      host.text = 'changed';
      first.tick();
      await first.flush();
      final crashedSession = first.sessionId;
      expect([for (final c in ingest.chunks) c['seq']], [0, 1]);

      // The process died; the native side wrote its file. Next launch, 10 s later.
      final crashAt = host.clock + 500;
      final native = FakeNative(androidCrash(crashAt));
      final (second, _) = await launch(store: store, ingest: ingest, native: native, clock: host.clock + 10000);
      await pumpEventQueue();
      expect(native.takes, 1);
      expect(native.installs, 1);

      final crashChunk = ingest.chunks[2];
      expect(crashChunk['sessionId'], crashedSession);
      expect(crashChunk['seq'], 2);
      expect(crashChunk['flags'], {'hasError': true});
      expect(crashChunk.containsKey('meta'), isFalse);
      final events = (crashChunk['events']! as List).cast<Map<String, Object?>>();
      expect(events, hasLength(1));
      expect(events.single['type'], 5);
      expect(events.single['timestamp'], crashAt);
      final payload = payloadOf(events.single);
      expect(payload['kind'], 'fatal');
      expect(payload['native'], true);
      expect(payload['name'], 'java.lang.IllegalStateException');
      expect(ingest.wire, isNot(contains('ayse@example.com')));

      // Inside 30 minutes the session resumes after the crash chunk, not on top of it.
      expect(second.sessionId, crashedSession);
      await second.flush();
      expect(ingest.chunks.last['sessionId'], crashedSession);
      expect(ingest.chunks.last['seq'], 3);
    });

    test('a session over 30 minutes old still gets its crash; the new launch starts a new one', () async {
      final store = MemoryStore();
      final ingest = FakeIngest();
      final (first, host) = await launch(store: store, ingest: ingest);
      await first.flush();
      final crashed = first.sessionId;
      final native = FakeNative('SIG\t11\t${(host.clock + 1000) ~/ 1000}');
      final (second, _) = await launch(store: store, ingest: ingest, native: native, clock: host.clock + 3600000);
      await pumpEventQueue();
      expect(ingest.chunks[1]['sessionId'], crashed);
      expect(ingest.chunks[1]['seq'], 1);
      expect(payloadOf((ingest.chunks[1]['events']! as List).single as Map<String, Object?>)['name'], 'SIGSEGV');
      expect(second.sessionId, isNot(crashed));
    });

    test('kept for the next launch when ingest cannot be reached, sent then', () async {
      final store = MemoryStore();
      final ingest = FakeIngest();
      final (first, host) = await launch(store: store, ingest: ingest);
      await first.flush();
      final crashed = first.sessionId;

      ingest.online = false;
      await launch(
          store: store, ingest: ingest, native: FakeNative(androidCrash(host.clock + 100)), clock: host.clock + 5000);
      await pumpEventQueue();
      expect(await store.getItem(nativeKeptKey), isNotNull);

      ingest.online = true;
      await launch(store: store, ingest: ingest, native: FakeNative(), clock: host.clock + 9000);
      await pumpEventQueue();
      final crashChunks = [
        for (final c in ingest.chunks)
          if (c['sessionId'] == crashed && c['seq'] == 1) c
      ];
      expect(crashChunks, hasLength(1));
      expect(await store.getItem(nativeKeptKey), isNull);
    });

    test('not sent with error recording off, and not before consent', () async {
      final store = MemoryStore();
      final ingest = FakeIngest();
      final (first, host) = await launch(store: store, ingest: ingest);
      await first.flush();

      final off = FakeNative(androidCrash(host.clock));
      await launch(store: store, ingest: ingest, native: off, recordErrors: false, clock: host.clock + 1000);
      await pumpEventQueue();
      expect(off.takes, 1, reason: 'taken, so it is not sent later either');
      expect(ingest.chunks.where((c) => c['flags'] is Map && (c['flags']! as Map)['hasError'] == true), isEmpty);

      final waiting = FakeNative(androidCrash(host.clock));
      final (third, _) =
          await launch(store: store, ingest: ingest, native: waiting, requireConsent: true, clock: host.clock + 2000);
      expect(waiting.takes, 0);
      third.consent(false);
      await pumpEventQueue();
      expect(waiting.takes, 1, reason: 'a refusal throws it away unsent');
      expect(ingest.chunks.where((c) => c['flags'] is Map && (c['flags']! as Map)['hasError'] == true), isEmpty);
    });

    test('stop() puts the native handlers back', () async {
      final native = FakeNative();
      final (recorder, _) = await launch(store: MemoryStore(), ingest: FakeIngest(), native: native);
      recorder.stop();
      await pumpEventQueue();
      expect(native.uninstalls, 1);
    });
  });

  group('a crash while keeping a crash clip', () {
    Future<(MemoryStore, FakeIngest, FakeHost)> clipLaunch() async {
      final store = MemoryStore();
      final ingest = FakeIngest();
      final (recorder, host) = await launch(store: store, ingest: ingest, sampleRate: 0, crashClip: true);
      expect(recorder.status, RecorderStatus.sampledOut);
      for (var i = 0; i < 35; i += 1) {
        host.advance(1000);
        host.text = 't$i';
        fire(host);
      }
      await pumpEventQueue();
      expect(ingest.chunks, isEmpty);
      return (store, ingest, host);
    }

    test('the ring is written to the store as each segment completes', () async {
      final (store, _, host) = await clipLaunch();
      final ring = jsonDecode((await store.getItem(clipRingKey))!) as Map<String, Object?>;
      expect(ring['v'], 1);
      final events = (ring['events']! as List).cast<Map<String, Object?>>();
      expect(events.first['type'], 4, reason: 'a kept ring opens with a whole screen');
      expect(host.clock - (events.last['timestamp']! as int), lessThan(11000));
      expect((ring['meta']! as Map)['platform'], isNotNull);
    });

    test('goes out on the next launch as a crash clip that ends in the fatal event', () async {
      final (store, ingest, host) = await clipLaunch();
      final crashAt = host.clock + 200;
      final (next, _) = await launch(
          store: store,
          ingest: ingest,
          native: FakeNative('SIG\t6\t$crashAt'),
          sampleRate: 0,
          crashClip: true,
          clock: host.clock + 20000);
      await pumpEventQueue();
      final chunks = ingest.chunks;
      expect(chunks, isNotEmpty);
      final sessionId = chunks.first['sessionId'];
      expect(sessionId, isNot(next.sessionId));
      expect([for (final c in chunks) c['seq']], List.generate(chunks.length, (i) => i));
      final meta = chunks.first['meta']! as Map;
      expect(meta['kind'], 'crash_clip');
      final events = [for (final c in chunks) ...(c['events']! as List).cast<Map<String, Object?>>()];
      expect(meta['startedAt'], events.first['timestamp']);
      expect(events.last['timestamp'], crashAt);
      expect(payloadOf(events.last), containsPair('name', 'SIGABRT'));
      expect(payloadOf(events.last), containsPair('native', true));
      expect(chunks.every((c) => (c['flags']! as Map)['hasError'] == true), isTrue);
      expect(await store.getItem('anyreplay.clipAt'), isNotNull);
    });

    test('not when the ring ends more than a minute before the crash', () async {
      final (store, ingest, host) = await clipLaunch();
      await launch(
          store: store,
          ingest: ingest,
          native: FakeNative(androidCrash(host.clock + 120000)),
          sampleRate: 0,
          crashClip: true,
          clock: host.clock + 130000);
      await pumpEventQueue();
      expect(ingest.chunks, isEmpty);
    });

    test('not inside the five-minute cool-down', () async {
      final (store, ingest, host) = await clipLaunch();
      await store.setItem('anyreplay.clipAt', '${host.clock - 60000}');
      await launch(
          store: store,
          ingest: ingest,
          native: FakeNative(androidCrash(host.clock)),
          sampleRate: 0,
          crashClip: true,
          clock: host.clock + 5000);
      await pumpEventQueue();
      expect(ingest.chunks, isEmpty);
    });

    test('a launch without a crash throws the old ring away; a refusal removes it', () async {
      final (store, ingest, host) = await clipLaunch();
      await launch(store: store, ingest: ingest, sampleRate: 0, crashClip: false, clock: host.clock + 1000);
      expect(await store.getItem(clipRingKey), isNull);

      final (store2, _, host2) = await clipLaunch();
      expect(await store2.getItem(clipRingKey), isNotNull);
      final (recorder, _) =
          await launch(store: store2, ingest: FakeIngest(), sampleRate: 0, crashClip: false, clock: host2.clock);
      await store2.setItem(clipRingKey, '{"v":1}');
      recorder.consent(false);
      await pumpEventQueue();
      expect(await store2.getItem(clipRingKey), isNull);
    });
  });
}
