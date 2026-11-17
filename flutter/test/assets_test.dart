import 'dart:convert';
import 'dart:typed_data';

import 'package:anyreplay_flutter/src/assets.dart';
import 'package:anyreplay_flutter/src/session.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'shop_app.dart' show tinyPng;

void main() {
  group('sha256', () {
    test('the standard vectors', () {
      expect(sha256Hex(Uint8List(0)), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
      expect(sha256Hex(utf8.encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
      expect(
        sha256Hex(utf8.encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')),
        '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
      );
      expect(sha256Hex(Uint8List.fromList(List.filled(1000, 0x61))),
          '41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3');
    });
  });

  test('only PNG, JPEG, GIF and WebP are uploadable', () {
    expect(isUploadableImage(tinyPng), isTrue);
    expect(isUploadableImage(Uint8List.fromList([0xff, 0xd8, 0xff, 0xe0])), isTrue);
    expect(isUploadableImage(Uint8List.fromList(utf8.encode('GIF89a'))), isTrue);
    expect(isUploadableImage(Uint8List.fromList([...utf8.encode('RIFF'), 0, 0, 0, 0, ...utf8.encode('WEBP')])), isTrue);
    expect(isUploadableImage(Uint8List.fromList(utf8.encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))), isFalse);
  });

  group('the uploader', () {
    final large = Uint8List.fromList([...tinyPng, ...List.filled(200 * 1024, 7)]);
    late List<(String, Map<String, Object?>)> requests;
    late List<String> known;

    AssetUploader uploader({AnyReplayStore? store, int status = 201}) {
      requests = [];
      return AssetUploader(
        ingestUrl: 'https://in.example.com',
        projectKey: 'ar_pk_live_0123456789abcdef01234567',
        appId: 'com.example.shop',
        store: store,
        readBytes: (key) async => switch (key) {
          'missing.png' => throw StateError('no such asset'),
          'large.png' => large,
          _ => tinyPng,
        },
        client: MockClient((request) async {
          final body = jsonDecode(request.body) as Map<String, Object?>;
          requests.add((request.url.path, body));
          if (request.url.path.endsWith('/known')) return http.Response(jsonEncode({'known': known}), 200);
          return http.Response('{"stored":true}', status);
        }),
      );
    }

    setUp(() => known = []);

    test('hashes a large image off the UI isolate, to the same hash', () async {
      final u = uploader();
      u.hashFor('large.png');
      await u.idle();
      expect(u.hashFor('large.png'), sha256Hex(large));
      expect(base64Decode(requests.last.$2['data']! as String), large);
    });

    test('asks first, uploads what the project lacks, then knows the hash', () async {
      final u = uploader();
      expect(u.hashFor('assets/logo.png'), isNull);
      await u.idle();
      final hash = sha256Hex(tinyPng);
      expect(u.hashFor('assets/logo.png'), hash);
      expect(requests.map((r) => r.$1), ['/v1/ingest/assets/known', '/v1/ingest/assets']);
      expect(requests[0].$2, {
        'projectKey': 'ar_pk_live_0123456789abcdef01234567',
        'hashes': [hash],
        'appId': 'com.example.shop'
      });
      expect(requests[1].$2['sha256'], hash);
      expect(base64Decode(requests[1].$2['data']! as String), tinyPng);
    });

    test('uploads nothing the project already holds', () async {
      known = [sha256Hex(tinyPng)];
      final u = uploader();
      u.hashFor('a.png');
      await u.idle();
      expect(u.hashFor('a.png'), sha256Hex(tinyPng));
      expect(requests.map((r) => r.$1), ['/v1/ingest/assets/known']);
    });

    test('remembers confirmed hashes across launches', () async {
      final store = MemoryStore();
      final first = uploader(store: store);
      first.hashFor('a.png');
      await first.idle();
      final second = uploader(store: store);
      await second.idle();
      expect(second.hashFor('a.png'), sha256Hex(tinyPng));
      expect(requests, isEmpty);
    });

    test('gives up on an image ingest refuses or cannot be read, for the launch', () async {
      final u = uploader(status: 413);
      u.hashFor('big.png');
      u.hashFor('missing.png');
      await u.idle();
      expect(u.hashFor('big.png'), isNull);
      expect(u.hashFor('missing.png'), isNull);
      await u.idle();
      expect(requests.where((r) => r.$1 == '/v1/ingest/assets'), hasLength(1));
    });
  });
}
