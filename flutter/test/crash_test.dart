import 'package:anyreplay_flutter/anyreplay_flutter.dart';
import 'package:anyreplay_flutter/src/crash.dart';
import 'package:anyreplay_flutter/src/options.dart';
import 'package:anyreplay_flutter/src/recorder.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';

import 'harness.dart';
import 'recorder_test.dart' show FakeHost;
import 'support.dart' show testKey;

/// Crash clips and fatal errors (crash.dart, diagnostics.dart), through the
/// same fake host the recorder tests use.
Future<(Recorder, FakeHost, MemoryStore)> startClip({
  bool? crashClip = true,
  double sampleRate = 0,
  bool requireConsent = false,
  FakeIngest? ingest,
  MemoryStore? store,
}) async {
  final host = FakeHost(ingest ?? FakeIngest());
  final memory = store ?? MemoryStore();
  final options = ResolvedOptions.resolve(
    AnyReplayOptions(projectKey: testKey, sampleRate: sampleRate, crashClip: crashClip, requireConsent: requireConsent),
    platformAppId: 'com.example.shop',
  );
  final recorder = await Recorder.create(options, host, memory);
  await pumpEventQueue();
  return (recorder, host, memory);
}

/// Fires every timer once, as the clock reaches it.
void fire(FakeHost host) {
  for (final callback in List.of(host.timers.values)) {
    callback();
  }
}

RecordedEventList eventsIn(List<Map<String, Object?>> chunks) =>
    [for (final c in chunks) ...(c['events']! as List).cast<Map<String, Object?>>()];

typedef RecordedEventList = List<Map<String, Object?>>;

Map<String, Object?> ev(int t, [int type = 3, Object? data]) => {
      'type': type,
      'timestamp': t,
      'data': data ?? {'source': 0, 'adds': [], 'removes': [], 'texts': []}
    };

void main() {
  group('the ring', () {
    test('keeps segments back to the one that starts at or before now − 30 s', () {
      final ring = ClipRing();
      const t0 = 1000000;
      for (var s = 0; s < 6; s += 1) {
        final at = t0 + s * 10000;
        expect(ring.needsSegment(at), isTrue);
        ring.startSegment(at);
        ring.push(ev(at, 4, {'width': 1, 'height': 1}));
        ring.push(ev(at, 2, {'node': {}}));
        ring.push(ev(at + 5000));
        expect(ring.needsSegment(at + 5000), isFalse);
      }
      final events = ring.events();
      expect(events.first['timestamp'], t0 + 20000);
      expect(events.first['type'], 4);
      expect(ring.segmentCount, 4);
    });

    test('holds its byte cap by dropping whole segments, oldest first', () {
      final ring = ClipRing(windowMs: 1000000, maxBytes: 2000, segmentMs: 10);
      final big = 'x' * 600;
      for (var s = 0; s < 5; s += 1) {
        ring.startSegment(s * 10);
        ring.push(ev(s * 10, 4, {'width': 1, 'height': 1, 'pad': big}));
      }
      expect(ring.bytes, lessThanOrEqualTo(2000));
      expect(ring.segmentCount, 3);
      expect(ring.events().first['timestamp'], 20);
    });

    test('one segment over the cap stops taking tree events, but still takes the error', () {
      final ring = ClipRing(maxBytes: 500);
      ring.startSegment(0);
      ring.push(ev(0, 2, {
        'node': {'pad': 'x' * 400}
      }));
      ring.push(ev(1, 3, {'source': 0, 'pad': 'y' * 200}));
      ring.push(ev(2, 3, {'source': 0}));
      ring.push(ev(3, 5, {'tag': 'anyreplay.error'}));
      expect([for (final e in ring.events()) e['type']], [2, 5]);
    });

    test('a clip is a new session: seq from 0, meta.kind crash_clip, startedAt its first event', () {
      final chunks = clipChunks([ev(100), ev(101), ev(102)], {'startedAt': 1, 'platform': 'flutter'}, 2);
      expect([for (final c in chunks) c.seq], [0, 1]);
      expect(chunks.first.meta, {'startedAt': 100, 'platform': 'flutter', 'kind': 'crash_clip'});
      expect(chunks.last.meta, isNull);
      expect(chunks.every((c) => c.flags?['hasError'] == true), isTrue);
    });
  });

  group('the recorder', () {
    test('an error nobody handled is recorded as fatal; one the framework caught stays error', () async {
      final ingest = FakeIngest();
      final (recorder, host, _) = await startClip(sampleRate: 1, ingest: ingest);
      host.hooks.flutterError!(FlutterErrorDetails(exception: StateError('layout')));
      host.hooks.platformError!(Exception('async'), StackTrace.current);
      recorder.trackError(Exception('mine'), null, true);
      recorder.trackError(Exception('caught'));
      // A fatal error is sent at once; let that request land, then send the rest.
      await pumpEventQueue();
      await recorder.flush();
      await pumpEventQueue();
      final kinds = [
        for (final e in ingest.events)
          if (e['type'] == 5) ((e['data']! as Map)['payload'] as Map)['kind']
      ];
      expect(kinds, ['error', 'fatal', 'fatal', 'error']);
      expect(ingest.configRequests, isEmpty, reason: 'a recorded visitor needs no clip');
    });

    test('a sampled-out visitor sends the last seconds as a crash clip after an unhandled error', () async {
      final ingest = FakeIngest();
      final (recorder, host, store) = await startClip(ingest: ingest);
      expect(recorder.status, RecorderStatus.sampledOut);
      for (var i = 0; i < 50; i += 1) {
        host.advance(1000);
        host.text = 't$i';
        fire(host);
      }
      expect(ingest.chunks, isEmpty, reason: 'nothing leaves without a crash');

      host.hooks.platformError!(Exception('boom'), StackTrace.current);
      expect(ingest.chunks, isEmpty, reason: 'the aftermath is recorded first');
      host.advance(2000);
      fire(host);
      await pumpEventQueue();

      final chunks = ingest.chunks;
      expect(chunks, isNotEmpty);
      expect([for (final c in chunks) c['seq']], List.generate(chunks.length, (i) => i));
      final meta = chunks.first['meta']! as Map;
      final events = eventsIn(chunks);
      expect(meta['kind'], 'crash_clip');
      expect(meta['startedAt'], events.first['timestamp']);
      expect(events.first['type'], 4);
      final span = host.clock - (events.first['timestamp']! as int);
      expect(span, inInclusiveRange(30000, 42000));
      final fatal = events.firstWhere((e) => e['type'] == 5);
      expect(((fatal['data']! as Map)['payload'] as Map)['kind'], 'fatal');
      expect(chunks.first['flags'], {'hasError': true});
      expect(chunks.first['sessionId'], isNot(recorder.sessionId));
      expect(await store.getItem('anyreplay.clipAt'), isNotNull);
    });

    test('at most one clip per five minutes', () async {
      final ingest = FakeIngest();
      final (_, host, _) = await startClip(ingest: ingest);
      Future<void> crash() async {
        host.advance(1000);
        fire(host);
        host.hooks.flutterError!(FlutterErrorDetails(exception: StateError('x')));
        host.advance(2000);
        fire(host);
        await pumpEventQueue();
      }

      int sessions() => {for (final c in ingest.chunks) c['sessionId']}.length;
      await crash();
      expect(sessions(), 1);
      host.advance(60000);
      await crash();
      expect(sessions(), 1);
      host.advance(5 * 60000);
      await crash();
      expect(sessions(), 2);
    });

    test('follows the project switch when the app sets none, and asks again only after ten minutes', () async {
      final store = MemoryStore();
      final on = FakeIngest()..crashClip = true;
      final (_, host, _) = await startClip(crashClip: null, ingest: on, store: store);
      expect(on.configRequests, [
        {'projectKey': testKey, 'appId': 'com.example.shop'}
      ]);
      expect(host.timers, isNotEmpty);

      final again = FakeIngest()..crashClip = true;
      await startClip(crashClip: null, ingest: again, store: store);
      expect(again.configRequests, isEmpty, reason: 'the cached answer is fresh');

      final off = FakeIngest();
      final (_, offHost, _) = await startClip(crashClip: null, ingest: off);
      expect(off.configRequests, hasLength(1));
      expect(offHost.timers, isEmpty);
    });

    test('no clip without consent, and a refusal forgets when the last one was made', () async {
      final ingest = FakeIngest();
      final (recorder, host, store) = await startClip(ingest: ingest, requireConsent: true);
      expect(host.timers, isEmpty);
      recorder.consent(true);
      await pumpEventQueue();
      expect(host.timers, isNotEmpty);
      host.hooks.platformError!(Exception('boom'), StackTrace.current);
      expect(await store.getItem('anyreplay.clipAt'), isNotNull);
      recorder.consent(false);
      await pumpEventQueue();
      expect(await store.getItem('anyreplay.clipAt'), isNull);
      expect(host.timers, isEmpty);
      expect(ingest.chunks, isEmpty, reason: 'the pending clip went with the refusal');
    });
  });
}
