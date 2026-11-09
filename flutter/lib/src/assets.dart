import 'dart:async';
import 'dart:convert';
import 'dart:isolate';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import 'session.dart';

/// Images the app ships (docs/SDK-CONTRACT.md §9).
///
/// A reviewer's browser can load a photo from the app's CDN, but not an
/// image inside the app. So each bundled image is uploaded once per project,
/// by content hash, checked against the server first and remembered on the
/// device; the recording refers to it as `asset: <sha256>`. Only files from
/// the app's own asset bundle qualify — never a photo the person took.

const List<int> _k = [
  0x428a2f98,
  0x71374491,
  0xb5c0fbcf,
  0xe9b5dba5,
  0x3956c25b,
  0x59f111f1,
  0x923f82a4,
  0xab1c5ed5,
  0xd807aa98,
  0x12835b01,
  0x243185be,
  0x550c7dc3,
  0x72be5d74,
  0x80deb1fe,
  0x9bdc06a7,
  0xc19bf174,
  0xe49b69c1,
  0xefbe4786,
  0x0fc19dc6,
  0x240ca1cc,
  0x2de92c6f,
  0x4a7484aa,
  0x5cb0a9dc,
  0x76f988da,
  0x983e5152,
  0xa831c66d,
  0xb00327c8,
  0xbf597fc7,
  0xc6e00bf3,
  0xd5a79147,
  0x06ca6351,
  0x14292967,
  0x27b70a85,
  0x2e1b2138,
  0x4d2c6dfc,
  0x53380d13,
  0x650a7354,
  0x766a0abb,
  0x81c2c92e,
  0x92722c85,
  0xa2bfe8a1,
  0xa81a664b,
  0xc24b8b70,
  0xc76c51a3,
  0xd192e819,
  0xd6990624,
  0xf40e3585,
  0x106aa070,
  0x19a4c116,
  0x1e376c08,
  0x2748774c,
  0x34b0bcb5,
  0x391c0cb3,
  0x4ed8aa4a,
  0x5b9cca4f,
  0x682e6ff3,
  0x748f82ee,
  0x78a5636f,
  0x84c87814,
  0x8cc70208,
  0x90befffa,
  0xa4506ceb,
  0xbef9a3f7,
  0xc67178f2,
];

int _rotr(int x, int n) => ((x >> n) | (x << (32 - n))) & 0xffffffff;

/// SHA-256 as 64 lowercase hex digits. Written out rather than taken from
/// `package:crypto`, so the SDK adds no dependency for one function; the
/// tests check it against the standard vectors.
String sha256Hex(Uint8List bytes) {
  final length = bytes.length;
  final paddedLength = ((length + 9 + 63) >> 6) << 6;
  final padded = Uint8List(paddedLength)..setAll(0, bytes);
  padded[length] = 0x80;
  final bitLength = length * 8;
  final view = ByteData.sublistView(padded);
  view.setUint32(paddedLength - 8, (bitLength ~/ 0x100000000) & 0xffffffff);
  view.setUint32(paddedLength - 4, bitLength & 0xffffffff);

  final h = <int>[0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  final w = List<int>.filled(64, 0);
  for (var offset = 0; offset < paddedLength; offset += 64) {
    for (var i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(offset + i * 4);
    }
    for (var i = 16; i < 64; i += 1) {
      final s0 = _rotr(w[i - 15], 7) ^ _rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
      final s1 = _rotr(w[i - 2], 17) ^ _rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) & 0xffffffff;
    }
    var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (var i = 0; i < 64; i += 1) {
      final s1 = _rotr(e, 6) ^ _rotr(e, 11) ^ _rotr(e, 25);
      final ch = (e & f) ^ ((~e & 0xffffffff) & g);
      final t1 = (hh + s1 + ch + _k[i] + w[i]) & 0xffffffff;
      final s0 = _rotr(a, 2) ^ _rotr(a, 13) ^ _rotr(a, 22);
      final maj = (a & b) ^ (a & c) ^ (b & c);
      final t2 = (s0 + maj) & 0xffffffff;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) & 0xffffffff;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) & 0xffffffff;
    }
    h[0] = (h[0] + a) & 0xffffffff;
    h[1] = (h[1] + b) & 0xffffffff;
    h[2] = (h[2] + c) & 0xffffffff;
    h[3] = (h[3] + d) & 0xffffffff;
    h[4] = (h[4] + e) & 0xffffffff;
    h[5] = (h[5] + f) & 0xffffffff;
    h[6] = (h[6] + g) & 0xffffffff;
    h[7] = (h[7] + hh) & 0xffffffff;
  }
  return h.map((v) => v.toRadixString(16).padLeft(8, '0')).join();
}

/// What ingest accepts, by the file's first bytes: PNG, JPEG, GIF, WebP.
bool isUploadableImage(Uint8List bytes) {
  bool starts(List<int> magic, [int at = 0]) {
    if (bytes.length < at + magic.length) return false;
    for (var i = 0; i < magic.length; i += 1) {
      if (bytes[at + i] != magic[i]) return false;
    }
    return true;
  }

  return starts(const [0x89, 0x50, 0x4e, 0x47]) ||
      starts(const [0xff, 0xd8, 0xff]) ||
      starts(const [0x47, 0x49, 0x46, 0x38]) ||
      (starts(const [0x52, 0x49, 0x46, 0x46]) && starts(const [0x57, 0x45, 0x42, 0x50], 8));
}

const String _memoryKey = 'anyreplay.assets';

/// Images up to this size are hashed where they are read; larger ones on
/// another isolate.
const int _inlineHashBytes = 64 * 1024;
const int _memoryLimit = 300;

/// Ingest's limit for one image, decoded.
const int maxAssetBytes = 3 * 1024 * 1024;

/// Turns asset keys into content hashes, uploading each image the project
/// does not hold yet.
///
/// [hashFor] never waits: an image seen for the first time has no hash on
/// that tick, the upload happens in the background, one image at a time,
/// and the hash appears in a later tick's diff.
class AssetUploader {
  AssetUploader({
    required this.ingestUrl,
    required this.projectKey,
    required this.client,
    required this.readBytes,
    this.appId,
    this.store,
    this.debug = false,
  }) {
    _loaded = _load();
  }

  final String ingestUrl;
  final String projectKey;
  final String? appId;
  final http.Client client;

  /// Reads an asset's bytes from the app's bundle.
  final Future<Uint8List> Function(String key) readBytes;
  final AnyReplayStore? store;
  final bool debug;

  final Map<String, String> _hashes = {};
  final Set<String> _failed = {};
  final List<String> _queue = [];
  final Set<String> _queued = {};
  bool _running = false;
  bool _closed = false;
  late final Future<void> _loaded;

  /// The confirmed hash of the asset [key], or null while it is not known.
  String? hashFor(String key) {
    final known = _hashes[key];
    if (known != null) return known;
    if (!_closed && !_failed.contains(key) && !_queued.contains(key)) {
      _queued.add(key);
      _queue.add(key);
      unawaited(_drain());
    }
    return null;
  }

  /// Stops uploading; what is in flight finishes, nothing new starts.
  void close() {
    _closed = true;
    _queue.clear();
  }

  /// Resolves once everything queued so far has been handled. For tests.
  Future<void> idle() async {
    await _loaded;
    while (_running || _queue.isNotEmpty) {
      await Future<void>.delayed(const Duration(milliseconds: 1));
    }
  }

  Future<void> _load() async {
    try {
      final raw = await store?.getItem(_memoryKey);
      if (raw == null) return;
      final entries = jsonDecode(raw);
      if (entries is! List) return;
      for (final entry in entries) {
        if (entry is List &&
            entry.length == 2 &&
            entry[0] is String &&
            entry[1] is String &&
            RegExp(r'^[0-9a-f]{64}$').hasMatch(entry[1] as String)) {
          _hashes[entry[0] as String] = entry[1] as String;
        }
      }
    } catch (_) {/* a corrupt memory is an empty one */}
  }

  Future<void> _remember(String key, String hash) async {
    _hashes[key] = hash;
    final entries = _hashes.entries.map((e) => [e.key, e.value]).toList();
    final kept = entries.length > _memoryLimit ? entries.sublist(entries.length - _memoryLimit) : entries;
    try {
      await store?.setItem(_memoryKey, jsonEncode(kept));
    } catch (_) {/* best effort */}
  }

  Future<void> _drain() async {
    if (_running) return;
    _running = true;
    try {
      await _loaded;
      while (_queue.isNotEmpty && !_closed) {
        final key = _queue.removeAt(0);
        if (_hashes.containsKey(key)) continue;
        try {
          final hash = await _ensure(key);
          if (hash != null) {
            await _remember(key, hash);
          } else {
            _failed.add(key);
          }
        } catch (error) {
          _failed.add(key);
          if (debug) debugPrint('[anyreplay] could not upload image $key: $error');
        }
      }
    } finally {
      _running = false;
    }
  }

  Future<String?> _ensure(String key) async {
    final bytes = await readBytes(key);
    if (bytes.isEmpty || bytes.length > maxAssetBytes || !isUploadableImage(bytes)) return null;
    // Hashing and encoding a large image is real work: done on another
    // isolate, so a tick never waits behind it.
    final (hash, encoded) = bytes.length > _inlineHashBytes
        ? await Isolate.run(() => (sha256Hex(bytes), base64Encode(bytes)))
        : (sha256Hex(bytes), base64Encode(bytes));
    const headers = {'Content-Type': 'application/json'};

    final known = await client.post(
      Uri.parse('$ingestUrl/v1/ingest/assets/known'),
      headers: headers,
      body: jsonEncode({
        'projectKey': projectKey,
        'hashes': [hash],
        if (appId != null) 'appId': appId
      }),
    );
    if (known.statusCode == 200) {
      try {
        final body = jsonDecode(known.body);
        if (body is Map && body['known'] is List && (body['known'] as List).contains(hash)) return hash;
      } catch (_) {/* fall through to the upload */}
    }

    final upload = await client.post(
      Uri.parse('$ingestUrl/v1/ingest/assets'),
      headers: headers,
      body: jsonEncode({'projectKey': projectKey, 'sha256': hash, 'data': encoded, if (appId != null) 'appId': appId}),
    );
    return upload.statusCode == 200 || upload.statusCode == 201 ? hash : null;
  }
}
