import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:anyreplay_flutter/src/transport.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// docs/SDK-CONTRACT.md §10, answer by answer.
class _Ingest {
  final List<Map<String, Object?>> bodies = [];
  final List<Object> answers = [];
  int now = 1760000000000;

  late final http.Client client = MockClient((request) async {
    final body = jsonDecode(request.body) as Map<String, Object?>;
    final answer = answers.isNotEmpty ? answers.removeAt(0) : 202;
    if (answer is SocketException) throw answer;
    bodies.add(body);
    if (answer is http.Response) return answer;
    return http.Response('{"accepted":true,"duplicate":false}', answer as int);
  });

  List<int> get seqs => [for (final b in bodies) b['seq']! as int];
}

Transport _transport(
  _Ingest ingest, {
  TransportHooks hooks = const TransportHooks(),
  int maxEvents = 200,
  int maxBuffered = 2000,
  int initialSeq = 0,
}) =>
    Transport(
      TransportOptions(
        ingestUrl: 'https://in.example.com',
        projectKey: 'ar_pk_live_0123456789abcdef01234567',
        sessionId: '3f1c2a4e-8b7d-4c3e-9a1b-2c3d4e5f6a7b',
        visitorId: 'v0123456789abcdef01234567',
        maxEventsPerChunk: maxEvents,
        maxBufferedEvents: maxBuffered,
        initialSeq: initialSeq,
        appId: 'com.example.shop',
        now: () => ingest.now,
        random: Random(1),
      ),
      hooks,
      ingest.client,
    );

Map<String, Object?> _tap(int i) => {
      'type': 3,
      'timestamp': 1760000000000 + i,
      'data': {'source': 2, 'type': 2, 'x': i % 300, 'y': 10}
    };
Map<String, Object?> _mutation(int i, [int size = 10]) => {
      'type': 3,
      'timestamp': 1760000000000 + i,
      'data': {
        'source': 0,
        'removes': [],
        'adds': [],
        'attributes': [],
        'texts': [
          {'id': 3, 'value': 'x' * size}
        ]
      }
    };

void main() {
  test('a chunk carries the session, the app, the meta until accepted, and sentAt', () async {
    final ingest = _Ingest();
    final t = _transport(ingest)..setMeta({'startedAt': 1});
    t.flags.pageCount = 1;
    t.push(_tap(1));
    await t.flush();
    t.push(_tap(2));
    ingest.now += 1000;
    await t.flush();
    expect(ingest.seqs, [0, 1]);
    final first = ingest.bodies.first;
    expect(first['projectKey'], 'ar_pk_live_0123456789abcdef01234567');
    expect(first['appId'], 'com.example.shop');
    expect(first['meta'], {'startedAt': 1});
    expect(first['flags'], {'pageCount': 1});
    expect(first['sentAt'], 1760000000000);
    expect(ingest.bodies[1].containsKey('meta'), isFalse);
    expect(ingest.bodies[1]['sentAt'], 1760000001000);
  });

  test('never sends a chunk with no events', () async {
    final ingest = _Ingest();
    await _transport(ingest).flush();
    expect(ingest.bodies, isEmpty);
  });

  test('cuts a backlog by count (200) and by bytes (about 256 KB)', () async {
    final ingest = _Ingest();
    final t = _transport(ingest, maxEvents: 200);
    for (var i = 0; i < 450; i += 1) {
      t.push(_tap(i));
    }
    await pumpEventQueue();
    await t.flush();
    final sizes = [for (final b in ingest.bodies) (b['events']! as List).length];
    expect(sizes.reduce((a, b) => a + b), 450);
    expect(sizes.every((n) => n <= 200), isTrue);

    final big = _Ingest();
    final b = _transport(big, maxEvents: 200);
    for (var i = 0; i < 40; i += 1) {
      b.push(_mutation(i, 20 * 1024));
    }
    await b.flush();
    for (final body in big.bodies) {
      expect(utf8.encode(jsonEncode(body)).length, lessThan(300 * 1024));
    }
    expect([for (final body in big.bodies) ...(body['events']! as List)], hasLength(40));
  });

  test('reserves the next number before the request leaves', () async {
    final ingest = _Ingest();
    final reserved = <int>[];
    final t = _transport(ingest, hooks: TransportHooks(onSeqReserved: reserved.add), initialSeq: 5);
    t.push(_tap(1));
    await t.flush();
    expect(reserved, [6]);
    expect(ingest.seqs, [5]);
  });

  test('offline, 5xx and 429 keep the chunk and back off; Retry-After is honoured', () async {
    final ingest = _Ingest()..answers.addAll([const SocketException('offline'), 503]);
    final t = _transport(ingest);
    t.push(_tap(1));
    await t.flush();
    expect(t.bufferedCount, 1);
    final firstWait = t.nextAttemptAt - ingest.now;
    expect(firstWait, inInclusiveRange(1000, 2000));
    await t.flush(); // inside the backoff: nothing
    expect(ingest.bodies, isEmpty);

    ingest.now = t.nextAttemptAt;
    await t.flush(); // 503
    expect(t.bufferedCount, 1);
    expect(t.nextAttemptAt - ingest.now, inInclusiveRange(2000, 4000));

    ingest.now = t.nextAttemptAt;
    ingest.answers.add(http.Response('{"error":"rate_limited"}', 429, headers: {'retry-after': '120'}));
    await t.flush();
    expect(t.nextAttemptAt - ingest.now, 120000);
    // Coming back to the foreground skips our backoff, never the server's wait.
    t.retryNow();
    expect(t.nextAttemptAt - ingest.now, 120000);
    // Nor does the background flush.
    await t.flush(force: true);
    expect(ingest.bodies.where((b) => b['seq'] == 0), hasLength(2));

    ingest.now += 120000;
    await t.flush();
    expect(t.bufferedCount, 0);
    expect(t.isStopped, isFalse);
    // Every attempt reused seq 0 with the same events.
    expect(ingest.seqs.toSet(), {0});
  });

  test('a retry-after date, capped at ten minutes', () {
    final now = DateTime.utc(2026, 10, 8, 12).millisecondsSinceEpoch;
    expect(retryAfterMs({'retry-after': 'Thu, 08 Oct 2026 12:00:30 GMT'}, now), 30000);
    expect(retryAfterMs({'retry-after': '2.5'}, now), 2500);
    expect(retryAfterMs({'retry-after': 'soon'}, now), isNull);
    expect(retryAfterMs({}, now), isNull);
  });

  test('the background flush goes inside our own backoff', () async {
    final ingest = _Ingest()..answers.add(500);
    final t = _transport(ingest);
    t.push(_tap(1));
    await t.flush();
    await t.flush(force: true);
    expect(t.bufferedCount, 0);
  });

  test('a 413 re-cuts smaller under the next number and never stops', () async {
    final ingest = _Ingest()..answers.add(413);
    final t = _transport(ingest);
    for (var i = 0; i < 10; i += 1) {
      t.push(_tap(i));
    }
    await t.flush();
    expect(t.isStopped, isFalse);
    expect(t.bufferedCount, 0);
    expect(ingest.seqs.first, 0);
    expect(ingest.seqs.skip(1), everyElement(greaterThan(0)), reason: 'the refused number is not reused');
    expect(ingest.bodies.skip(1).map((b) => (b['events']! as List).length).reduce((a, b) => a + b), 10);
  });

  test('400 or 422 drops the chunk and carries on; three in a row stop', () async {
    final ingest = _Ingest()..answers.addAll([202, 422]);
    var dropped = 0;
    final t = _transport(ingest, hooks: TransportHooks(onDropped: (_) => dropped += 1), maxEvents: 1);
    t.push(_tap(0));
    await pumpEventQueue();
    t.push(_mutation(1));
    t.push(_tap(2));
    await pumpEventQueue();
    await t.flush();
    expect(t.isStopped, isFalse);
    expect(ingest.seqs, [0, 1, 2]);
    expect(jsonEncode(ingest.bodies.last['events']), contains('"x":2'));
    expect(dropped, 1, reason: 'a dropped tree event asks for a new snapshot');

    final again = _Ingest()..answers.addAll([400, 400, 422]);
    String? reason;
    final s = _transport(again, hooks: TransportHooks(onStopped: (r) => reason = r), maxEvents: 1);
    for (var i = 0; i < 4; i += 1) {
      s.push(_tap(i));
    }
    await pumpEventQueue();
    await s.flush();
    expect(s.isStopped, isTrue);
    expect(reason, 'rejected_422');
  });

  for (final status in [402, 403, 404]) {
    test('$status stops for the launch', () async {
      final ingest = _Ingest()..answers.add(status);
      String? reason;
      final t = _transport(ingest, hooks: TransportHooks(onStopped: (r) => reason = r));
      t.push(_tap(1));
      await t.flush();
      expect(t.isStopped, isTrue);
      expect(reason, 'rejected_$status');
      t.push(_tap(2));
      await t.flush();
      expect(ingest.bodies, hasLength(1));
    });
  }

  test('a number an earlier launch took moves to the one ingest names, at most three times', () async {
    final ingest = _Ingest()
      ..answers.addAll([
        http.Response('{"accepted":true,"duplicate":true,"nextSeq":9}', 202),
        202,
      ]);
    final t = _transport(ingest, initialSeq: 4);
    t.push(_tap(1));
    await t.flush();
    expect(ingest.seqs, [4, 9]);
    expect(jsonEncode(ingest.bodies[0]['events']), jsonEncode(ingest.bodies[1]['events']));
    expect(t.seq, 10);

    final stubborn = _Ingest()
      ..answers.addAll([
        for (var i = 0; i < 5; i += 1) http.Response('{"accepted":true,"duplicate":true,"nextSeq":${20 + i}}', 202),
      ]);
    final s = _transport(stubborn);
    s.push(_tap(1));
    await s.flush();
    expect(stubborn.seqs, [0, 20, 21, 22]);
    expect(s.bufferedCount, 0);
  });

  test('a duplicate on a retry is ours and counts as sent', () async {
    final ingest = _Ingest()
      ..answers.addAll([500, http.Response('{"accepted":true,"duplicate":true,"nextSeq":3}', 202)]);
    final t = _transport(ingest);
    t.push(_tap(1));
    await t.flush();
    await t.flush(force: true);
    expect(ingest.seqs, [0, 0]);
    expect(t.seq, 1);
  });

  test('the bounded buffer drops the oldest, and the tree after a lost tree event', () async {
    final ingest = _Ingest()..answers.add(const SocketException('offline'));
    var asked = 0;
    final t = _transport(ingest, maxBuffered: 5, maxEvents: 5, hooks: TransportHooks(onDropped: (_) => asked += 1));
    t.push(_tap(0));
    await t.flush(); // offline; nothing delivered yet
    for (var i = 1; i < 5; i += 1) {
      t.push(_mutation(i));
    }
    t.push(_tap(9)); // over the bound: the oldest (a tap) goes, nothing else
    expect(asked, 0);
    expect(t.bufferedCount, 5);
    t.push(_tap(10)); // now a mutation goes: before anything was delivered, the whole buffer goes
    expect(asked, 1);
    expect(t.bufferedCount, 0);
    expect(t.lostOpening, isTrue);
  });

  test('utf8Length counts what ingest counts', () {
    for (final text in ['abc', 'Şifre', '日本語', '😀 x', '\u{1F600}\u{1F601}']) {
      expect(utf8Length(text), utf8.encode(text).length, reason: text);
    }
  });

  test('tree events are snapshots, mutations and metas', () {
    expect(isTreeEvent({'type': 2, 'data': {}}), isTrue);
    expect(isTreeEvent({'type': 4, 'data': {}}), isTrue);
    expect(isTreeEvent(_mutation(1)), isTrue);
    expect(isTreeEvent(_tap(1)), isFalse);
    expect(
        isTreeEvent({
          'type': 5,
          'data': {'tag': 'anyreplay.track'}
        }),
        isFalse);
  });
}
