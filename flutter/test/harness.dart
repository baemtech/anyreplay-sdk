import 'dart:convert';
import 'dart:io';
import 'dart:ui' show ErrorCallback;

import 'package:anyreplay_flutter/anyreplay_flutter.dart';
import 'package:anyreplay_flutter/src/anyreplay.dart' show AnyReplayEnvironment;
import 'package:anyreplay_flutter/src/device.dart';
import 'package:anyreplay_flutter/src/diagnostics.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'shop_app.dart';
import 'support.dart';

/// One request ingest received.
class Sent {
  Sent(this.path, this.body);
  final String path;
  final Map<String, Object?> body;
}

/// A fake ingest: answers like the real one and keeps every body.
class FakeIngest {
  FakeIngest({this.online = true});

  bool online;
  final List<Sent> requests = [];

  /// Override the answer to the next chunks: status code, body, headers.
  final List<http.Response> scripted = [];

  late final http.Client client = MockClient((request) async {
    if (!online) throw const SocketException('offline');
    final body = jsonDecode(request.body) as Map<String, Object?>;
    final path = request.url.path;
    requests.add(Sent(path, body));
    if (path.endsWith('/assets/known')) return http.Response('{"known":[]}', 200);
    if (path.endsWith('/assets')) return http.Response('{"stored":true}', 201);
    if (path.endsWith('/identify')) return http.Response('{"applied":true}', 200);
    if (scripted.isNotEmpty) return scripted.removeAt(0);
    return http.Response('{"accepted":true,"duplicate":false}', 202);
  });

  List<Map<String, Object?>> get chunks => [
        for (final r in requests)
          if (r.path.endsWith('/v1/ingest/events')) r.body
      ];

  List<Map<String, Object?>> bodies(String suffix) => [
        for (final r in requests)
          if (r.path.endsWith(suffix)) r.body
      ];

  List<Map<String, Object?>> get events => [
        for (final chunk in chunks) ...(chunk['events']! as List).cast<Map<String, Object?>>(),
      ];

  /// Everything on the wire, as one string, for "is it absent" checks.
  String get wire => jsonEncode([for (final r in requests) r.body]);
}

/// Error hooks that are not Flutter's: tests that are not about them keep
/// the test binding's own handler untouched.
class FakeErrorHooks implements ErrorHooks {
  @override
  FlutterExceptionHandler? flutterError;
  @override
  ErrorCallback? platformError;
}

/// A clock the test moves by hand.
class TestClock {
  int now = 1760000000000;
  void advance(int ms) => now += ms;
}

const iphone = DeviceDescription(os: 'ios', osVersion: '18.0', model: 'iPhone15,2');
const android = DeviceDescription(os: 'android', osVersion: '14', model: 'Pixel 8');

AnyReplayEnvironment testEnvironment(
  FakeIngest ingest,
  TestClock clock, {
  DeviceDescription device = iphone,
  AnyReplayStore? store,
  ErrorHooks? errorHooks,
}) =>
    AnyReplayEnvironment(
      client: ingest.client,
      store: store ?? MemoryStore(),
      clock: () => clock.now,
      device: device,
      platformAppId: 'com.example.shop',
      platformAppVersion: '3.4.1',
      locale: 'tr-TR',
      manualTimers: true,
      errorHooks: errorHooks ?? FakeErrorHooks(),
      readAsset: (_) async => tinyPng,
    );

/// Moves time on, lets the app settle, and reads the screen.
Future<void> tickAfter(WidgetTester tester, TestClock clock, int ms) async {
  clock.advance(ms);
  await tester.pump(Duration(milliseconds: ms));
  AnyReplay.recorder!.tick();
}

/// Writes what was sent where the checker reads it from (contract §14.3).
void dump(String name, FakeIngest ingest) {
  final dir = Directory('build/anyreplay-conformance')..createSync(recursive: true);
  File('${dir.path}/$name.ndjson').writeAsStringSync('${ingest.chunks.map(jsonEncode).join('\n')}\n');
}

/// Every endpoint's bodies in one capture envelope.
void dumpEnvelope(String name, FakeIngest ingest) {
  final dir = Directory('build/anyreplay-conformance')..createSync(recursive: true);
  File('${dir.path}/$name.ndjson').writeAsStringSync('${jsonEncode({
        'chunks': ingest.chunks,
        'identify': ingest.bodies('/v1/ingest/identify'),
        'assetsKnown': ingest.bodies('/v1/ingest/assets/known'),
        'assets': ingest.bodies('/v1/ingest/assets'),
      })}\n');
}

void startPhone(WidgetTester tester) => usePhone(tester);
