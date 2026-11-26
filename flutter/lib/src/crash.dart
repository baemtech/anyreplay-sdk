import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'session.dart';
import 'transport.dart';

/// Crash clips: the last ~30 seconds before a crash, for a visitor who is
/// not being recorded (sampled out). The port of the React Native SDK's
/// `crash.ts`.
///
/// For such a visitor — consent still required — the recorder keeps reading
/// the screen, but into a ring in memory instead of a transport: a fresh Meta
/// and full snapshot every 10 seconds starts a segment, and segments older
/// than the window are dropped whole, so what is kept always opens with a
/// complete screen. Nothing leaves the device unless the app crashes; then
/// the ring goes to ingest as a new session whose meta says
/// `kind: 'crash_clip'`.
///
/// Unlike React Native, a Flutter app almost always survives an uncaught
/// error (the engine logs it and carries on), so the clip is sent directly,
/// two seconds after the error, and is not written to the store first.

/// A fresh full snapshot this often starts a new segment of the ring.
const int clipSegmentMs = 10000;

/// How far back a clip reaches: segments back to the one that starts at or before now − this.
const int clipWindowMs = 30000;

/// What the ring may hold, in serialised bytes.
const int clipMaxBytes = 2 * 1024 * 1024;

/// How long the recorder keeps going after the crash, for the aftermath.
const Duration clipAftermath = Duration(seconds: 2);

/// At most one clip per visitor in this long.
const int clipCooldownMs = 5 * 60000;

/// How long the remote switch is believed before it is asked again.
const int configTtlMs = 10 * 60000;

int _sizeOf(RecordedEvent event) {
  try {
    return utf8Length(jsonEncode(event));
  } catch (_) {
    return -1;
  }
}

class _Segment {
  _Segment(this.startedAt);
  final int startedAt;
  final List<RecordedEvent> events = [];
  int bytes = 0;
  bool overflowed = false;
}

/// The rolling buffer behind a crash clip.
class ClipRing {
  ClipRing({this.windowMs = clipWindowMs, this.maxBytes = clipMaxBytes, this.segmentMs = clipSegmentMs});

  final int windowMs;
  final int maxBytes;
  final int segmentMs;
  final List<_Segment> _segments = [];
  int _total = 0;

  /// True when the recorder should open a new segment (send a whole screen) now.
  bool needsSegment(int now) => _segments.isEmpty || now - _segments.last.startedAt >= segmentMs;

  void startSegment(int now) {
    _segments.add(_Segment(now));
    _trim(now);
  }

  void push(RecordedEvent event) {
    if (_segments.isEmpty) return;
    final last = _segments.last;
    final bytes = _sizeOf(event);
    if (bytes < 0 || bytes > maxEventBytes) return;
    if (isTreeEvent(event)) {
      // One segment alone over the cap: the tree waits for the next segment,
      // since a later diff would point at what was not kept. Taps and errors
      // still go in.
      if (last.overflowed) return;
      if (_segments.length == 1 && _total + bytes > maxBytes) {
        last.overflowed = true;
        return;
      }
    }
    last.events.add(event);
    last.bytes += bytes;
    _total += bytes;
    _trim(event['timestamp'] as int? ?? 0);
  }

  void _trim(int now) {
    while (_segments.length > 1 && _segments[1].startedAt <= now - windowMs) {
      _total -= _segments.removeAt(0).bytes;
    }
    while (_segments.length > 1 && _total > maxBytes) {
      _total -= _segments.removeAt(0).bytes;
    }
  }

  int get bytes => _total;
  int get segmentCount => _segments.length;
  List<RecordedEvent> events() => [for (final s in _segments) ...s.events];
}

/// Splits events into chunk-sized groups, oldest first; an event no chunk could carry is left out.
List<List<RecordedEvent>> splitChunks(List<RecordedEvent> events, int maxEvents, {int maxBytes = targetChunkBytes}) {
  final out = <List<RecordedEvent>>[];
  var current = <RecordedEvent>[];
  var bytes = 0;
  for (final event in events) {
    final size = _sizeOf(event);
    if (size < 0 || size > maxEventBytes) continue;
    if (current.isNotEmpty && (current.length >= maxEvents || bytes + size + 1 > maxBytes)) {
      out.add(current);
      current = [];
      bytes = 0;
    }
    current.add(event);
    bytes += size + 1;
  }
  if (current.isNotEmpty) out.add(current);
  return out;
}

/// One chunk of an upload, as sent.
class PendingChunk {
  const PendingChunk(this.seq, this.events, {this.meta, this.flags});
  final int seq;
  final List<RecordedEvent> events;
  final Map<String, Object?>? meta;
  final Map<String, Object?>? flags;
}

/// A crash clip as chunks of a new session: seq from 0, `kind: 'crash_clip'`,
/// `startedAt` its first kept event, `hasError` on every chunk.
List<PendingChunk> clipChunks(List<RecordedEvent> events, Map<String, Object?> meta, int maxEvents) {
  final groups = splitChunks(events, maxEvents);
  if (groups.isEmpty) return const [];
  final startedAt = groups.first.first['timestamp'];
  return [
    for (var seq = 0; seq < groups.length; seq += 1)
      PendingChunk(
        seq,
        groups[seq],
        meta: seq == 0 ? {...meta, 'startedAt': startedAt, 'kind': 'crash_clip'} : null,
        flags: const {'hasError': true},
      ),
  ];
}

/// Sends chunks of one session, oldest first. True when every chunk was
/// accepted or refused for good (a 4xx); false when the network or the
/// server failed.
Future<bool> uploadChunks(
  http.Client client, {
  required String ingestUrl,
  required String projectKey,
  required String sessionId,
  required String visitorId,
  String? appId,
  required int Function() now,
  required List<PendingChunk> chunks,
}) async {
  for (final chunk in chunks) {
    http.Response response;
    try {
      response = await client
          .post(
            Uri.parse('$ingestUrl/v1/ingest/events'),
            headers: const {'Content-Type': 'application/json'},
            body: jsonEncode({
              'projectKey': projectKey,
              'sessionId': sessionId,
              'visitorId': visitorId,
              'seq': chunk.seq,
              'events': chunk.events,
              if (appId != null) 'appId': appId,
              if (chunk.meta != null) 'meta': chunk.meta,
              if (chunk.flags != null && chunk.flags!.isNotEmpty) 'flags': chunk.flags,
              'sentAt': now(),
            }),
          )
          .timeout(requestTimeout);
    } catch (_) {
      return false;
    }
    final status = response.statusCode;
    if (status >= 200 && status < 300) continue;
    if (status == 429 || status == 408 || status >= 500) return false;
    return true;
  }
  return true;
}

/// Whether the project wants crash clips, from `GET /v1/ingest/config`.
///
/// Asked at most every ten minutes; the answer is kept in the store so a
/// launch inside that time asks nothing. When ingest cannot be reached an
/// older answer is used, and with none at all the answer is no.
Future<bool> remoteCrashClip(
  AnyReplayStore store,
  http.Client client, {
  required String ingestUrl,
  required String projectKey,
  String? appId,
  required int now,
}) async {
  Map<String, Object?>? cached;
  try {
    final raw = await store.getItem(configKey);
    final decoded = raw == null || raw.isEmpty ? null : jsonDecode(raw);
    if (decoded is Map<String, Object?>) cached = decoded;
  } catch (_) {
    cached = null;
  }
  final at = cached?['at'];
  if (at is int && now - at >= 0 && now - at < configTtlMs) return cached!['crashClip'] == true;
  try {
    final uri = Uri.parse('$ingestUrl/v1/ingest/config').replace(queryParameters: {
      'projectKey': projectKey,
      if (appId != null) 'appId': appId,
    });
    final response = await client.get(uri).timeout(requestTimeout);
    if (response.statusCode != 200) return cached?['crashClip'] == true;
    final reply = jsonDecode(response.body);
    if (reply is! Map) return cached?['crashClip'] == true;
    final fresh = {
      'at': now,
      'crashClip': reply['crashClip'] == true,
      if (reply['maskAllInputs'] is bool) 'maskAllInputs': reply['maskAllInputs'],
    };
    unawaited(store.setItem(configKey, jsonEncode(fresh)).catchError((Object _) {}));
    return fresh['crashClip'] == true;
  } catch (_) {
    return cached?['crashClip'] == true;
  }
}
