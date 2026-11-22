import 'dart:async';
import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

import 'crash.dart';
import 'events.dart';
import 'options.dart';
import 'session.dart';
import 'transport.dart';
import 'tree.dart' show customEvent;

/// Crashes in the app's own native code: a Kotlin or Java exception nobody
/// caught on Android, an Objective-C exception or a fatal signal (SIGABRT,
/// SIGSEGV, SIGBUS, SIGILL, SIGFPE, SIGTRAP — Swift's `fatalError` and a
/// forced unwrap of nil end in the last) on iOS. A Dart error is not one of
/// them: diagnostics.dart hears those.
///
/// The process does not survive such a crash, so nothing Dart holds survives
/// it either. The plugin's native side (android/, ios/) installs its handlers
/// when the plugin registers, at app start, and writes one small file when
/// the app crashes: `anyreplay-native-crash.json` in the app's private files
/// (Android `filesDir`; iOS Application Support/anyreplay). On the next
/// launch the recorder takes it — `takeNativeCrash` returns the file's text
/// and deletes it — before it opens the new recording, and:
///
/// - when the crashed launch was recording (its session id and the next
///   chunk number are still in the store), sends one chunk into that session
///   with the next number: an `anyreplay.error` event `{kind: 'fatal',
///   native: true}` stamped at the crash time. Ingest marks the old recording
///   crashed at that moment.
/// - when it was keeping a crash clip instead (sampled out), sends the ring
///   the crashed launch last wrote to the store (every completed ten-second
///   segment overwrites it) with the fatal event at its end, as a crash clip
///   — if the ring's last event is less than a minute older than the crash,
///   and outside the five-minute cool-down.
///
/// Without the native side (web, desktop, tests, an app built before the
/// plugin was added) the channel answers `MissingPluginException` and
/// nothing changes.

const String nativeCrashChannelName = 'anyreplay_flutter/crash';

/// The name of the file the native side writes. For the record: Dart never
/// opens it; it is read through the channel.
const String nativeCrashFileName = 'anyreplay-native-crash.json';

/// A ring whose last event is older than this before the crash is not a clip of it.
const int nativeClipMaxGapMs = 60000;

/// At most this many undelivered native crashes are kept for a later launch.
const int _maxKept = 3;

/// The Darwin signal numbers the iOS side catches, by name.
const Map<int, String> darwinSignals = {
  4: 'SIGILL',
  5: 'SIGTRAP',
  6: 'SIGABRT',
  8: 'SIGFPE',
  10: 'SIGBUS',
  11: 'SIGSEGV',
};

const Map<String, String> _signalMeaning = {
  'SIGILL': 'an illegal instruction',
  'SIGTRAP': "a trap: Swift's fatalError, a forced unwrap of nil, an index out of range or an overflow",
  'SIGABRT': 'abort() was called',
  'SIGFPE': 'an arithmetic error',
  'SIGBUS': 'a bad memory access (bus error)',
  'SIGSEGV': 'a bad memory access (segmentation fault)',
};

/// One crash as the native side recorded it.
class NativeCrash {
  const NativeCrash({required this.ts, required this.platform, required this.name, required this.message, this.stack});

  /// When it happened, in epoch milliseconds.
  final int ts;
  final String platform;
  final String name;
  final String message;
  final String? stack;

  RecordedEvent toEvent({int? at}) => {
        'type': customEvent,
        'timestamp': at ?? ts,
        'data': {'tag': errorTag, 'payload': nativeErrorPayload(name: name, message: message, stack: stack)},
      };
}

/// Reads what the native side wrote. Two shapes:
///
/// - JSON, written by the Kotlin handler and the Objective-C exception
///   handler: `{"v":1,"ts":EPOCH_MS,"platform":"android"|"ios","name":…,"message":…,"stack":…}`.
/// - One line, written by the iOS signal handler, which may do nothing but
///   `write()` a buffer it formats itself: `SIG\tSIGNO\tEPOCH_SECONDS\n`
///   (decimal). A time over 10^11 is read as milliseconds.
///
/// Anything else is null.
NativeCrash? parseNativeCrash(String? raw) {
  if (raw == null) return null;
  final text = raw.trim();
  if (text.isEmpty) return null;
  if (text.startsWith('SIG\t')) {
    final parts = text.split('\n').first.split('\t');
    if (parts.length < 3) return null;
    final signo = int.tryParse(parts[1].trim());
    final time = int.tryParse(parts[2].trim());
    if (signo == null || time == null || time <= 0) return null;
    final name = darwinSignals[signo] ?? 'SIG$signo';
    final meaning = _signalMeaning[name];
    return NativeCrash(
      ts: time > 100000000000 ? time : time * 1000,
      platform: 'ios',
      name: name,
      message: meaning == null ? 'Fatal signal $name' : 'Fatal signal $name: $meaning',
    );
  }
  try {
    final decoded = jsonDecode(text);
    if (decoded is! Map) return null;
    final ts = decoded['ts'];
    final name = decoded['name'];
    if (decoded['v'] != 1 || ts is! num || ts <= 0 || name is! String || name.isEmpty) return null;
    final message = decoded['message'];
    final stack = decoded['stack'];
    final platform = decoded['platform'];
    return NativeCrash(
      ts: ts.toInt(),
      platform: platform is String ? platform : 'unknown',
      name: name,
      message: message is String ? message : '',
      stack: stack is String && stack.isNotEmpty ? stack : null,
    );
  } catch (_) {
    return null;
  }
}

/// The native side, as the recorder sees it.
abstract class NativeCrashSource {
  /// What the native side wrote about the last launch's crash, deleting it;
  /// null when there was none or there is no native side.
  Future<String?> take();

  /// Puts the native handlers in place (they already are from app start; a
  /// second call does nothing).
  Future<void> install();

  /// Puts back the handlers that were there before, where nothing has
  /// replaced them since.
  Future<void> uninstall();
}

/// No native side: tests, and platforms without one.
class NoNativeCrashSource implements NativeCrashSource {
  const NoNativeCrashSource();
  @override
  Future<String?> take() async => null;
  @override
  Future<void> install() async {}
  @override
  Future<void> uninstall() async {}
}

/// The plugin's method channel. Every call is safe without the plugin: a
/// `MissingPluginException` (web, desktop, a test, a build from before the
/// plugin) is no crash and no error.
class MethodChannelNativeCrashSource implements NativeCrashSource {
  const MethodChannelNativeCrashSource([this.channel = const MethodChannel(nativeCrashChannelName)]);
  final MethodChannel channel;

  Future<Object?> _call(String method) async {
    try {
      return await channel.invokeMethod<Object?>(method);
    } on MissingPluginException {
      return null;
    } catch (_) {
      return null;
    }
  }

  @override
  Future<String?> take() async {
    final reply = await _call('takeNativeCrash');
    if (reply is String) return reply;
    if (reply is Map) return jsonEncode(reply);
    return null;
  }

  @override
  Future<void> install() => _call('install');
  @override
  Future<void> uninstall() => _call('uninstall');
}

/// Takes the last launch's native crash and sends it where it belongs (see
/// the top of this file). Everything the store must know before the new
/// recording opens — the chunk number used, the ring removed — is done when
/// this returns; the requests themselves go on afterwards, each checking
/// [stillAllowed] (consent not refused meanwhile) first.
Future<void> deliverNativeCrash({
  required NativeCrashSource source,
  required AnyReplayStore store,
  required http.Client client,
  required ResolvedOptions options,
  required int Function() now,
  required bool Function() stillAllowed,
  void Function(String message)? warn,
}) async {
  String? raw;
  try {
    raw = await source.take();
  } catch (_) {
    raw = null;
  }
  final ring = await _readAndRemove(store, clipRingKey);
  final kept = await _readKept(store);

  final crash = parseNativeCrash(raw);
  final toSend = <_Delivery>[...kept];
  if (crash != null && options.recordErrors) {
    final delivery = await _place(crash, ring, store, options, now());
    if (delivery != null) {
      toSend.add(delivery);
      warn?.call('the app crashed in native code last time (${crash.name}); sending it');
    }
  }
  if (toSend.isEmpty) return;
  unawaited(_sendAll(toSend, store, client, options, now, stillAllowed).catchError((Object _) {}));
}

/// Where the crash goes: into the crashed recording, as a crash clip, or nowhere.
Future<_Delivery?> _place(
    NativeCrash crash, String? ring, AnyReplayStore store, ResolvedOptions options, int now) async {
  final visitorId = await store.getItem(visitorKey);
  if (visitorId == null || !visitorIdPattern.hasMatch(visitorId)) return null;
  final sessionId = await store.getItem(sessionKey);
  final nextSeq = int.tryParse(await store.getItem(seqKey) ?? '') ?? 0;

  // A chunk number above 0 was reserved, so the crashed launch was
  // recording and ingest has that session.
  if (sessionId != null && sessionId.isNotEmpty && nextSeq > 0) {
    await reserveSeq(store, nextSeq + 1);
    return _Delivery(sessionId, visitorId, [
      PendingChunk(nextSeq, [crash.toEvent()], flags: const {'hasError': true})
    ]);
  }

  if (ring == null || options.crashClip == false) return null;
  Map<String, Object?>? meta;
  List<RecordedEvent> events;
  try {
    final decoded = jsonDecode(ring);
    if (decoded is! Map || decoded['v'] != 1 || decoded['events'] is! List) return null;
    final m = decoded['meta'];
    meta = m is Map ? m.cast<String, Object?>() : <String, Object?>{};
    events = [
      for (final e in decoded['events'] as List)
        if (e is Map) e.cast<String, Object?>()
    ];
  } catch (_) {
    return null;
  }
  if (events.isEmpty) return null;
  final last = events.last['timestamp'];
  if (last is! int) return null;
  final gap = crash.ts - last;
  // A second of slack the other way, for a clock that moved.
  if (gap > nativeClipMaxGapMs || gap < -1000) return null;
  final clipAt = int.tryParse(await store.getItem(clipAtKey) ?? '') ?? 0;
  if (clipAt > 0 && now - clipAt < clipCooldownMs) return null;
  await store.setItem(clipAtKey, '$now');
  final chunks = clipChunks([...events, crash.toEvent(at: gap < 0 ? last : crash.ts)], meta, options.maxEventsPerChunk);
  if (chunks.isEmpty) return null;
  return _Delivery(uuidV4(), visitorId, chunks);
}

Future<void> _sendAll(List<_Delivery> deliveries, AnyReplayStore store, http.Client client, ResolvedOptions options,
    int Function() now, bool Function() stillAllowed) async {
  final failed = <_Delivery>[];
  for (final delivery in deliveries) {
    if (!stillAllowed()) return;
    final done = await uploadChunks(
      client,
      ingestUrl: options.ingestUrl,
      projectKey: options.projectKey,
      sessionId: delivery.sessionId,
      visitorId: delivery.visitorId,
      appId: options.appId,
      now: now,
      chunks: delivery.chunks,
    ).catchError((Object _) => false);
    if (!done) failed.add(delivery);
  }
  if (failed.isEmpty || !stillAllowed()) return;
  final keep = failed.length > _maxKept ? failed.sublist(failed.length - _maxKept) : failed;
  try {
    await store.setItem(nativeKeptKey, jsonEncode([for (final d in keep) d.toJson()]));
  } catch (_) {/* lost, as it would have been without the store */}
}

Future<String?> _readAndRemove(AnyReplayStore store, String key) async {
  try {
    final value = await store.getItem(key);
    if (value != null) await store.removeItem(key);
    return value;
  } catch (_) {
    return null;
  }
}

Future<List<_Delivery>> _readKept(AnyReplayStore store) async {
  final raw = await _readAndRemove(store, nativeKeptKey);
  if (raw == null) return const [];
  try {
    final decoded = jsonDecode(raw);
    if (decoded is! List) return const [];
    final out = <_Delivery>[];
    for (final item in decoded) {
      final delivery = item is Map ? _Delivery.fromJson(item.cast<String, Object?>()) : null;
      if (delivery != null) out.add(delivery);
    }
    return out;
  } catch (_) {
    return const [];
  }
}

class _Delivery {
  const _Delivery(this.sessionId, this.visitorId, this.chunks);
  final String sessionId;
  final String visitorId;
  final List<PendingChunk> chunks;

  Map<String, Object?> toJson() => {
        'sid': sessionId,
        'vid': visitorId,
        'chunks': [
          for (final c in chunks)
            {
              'seq': c.seq,
              'events': c.events,
              if (c.meta != null) 'meta': c.meta,
              if (c.flags != null) 'flags': c.flags
            }
        ],
      };

  static _Delivery? fromJson(Map<String, Object?> json) {
    final sid = json['sid'];
    final vid = json['vid'];
    final chunks = json['chunks'];
    if (sid is! String || vid is! String || chunks is! List) return null;
    final out = <PendingChunk>[];
    for (final c in chunks) {
      if (c is! Map || c['seq'] is! int || c['events'] is! List) return null;
      final meta = c['meta'];
      final flags = c['flags'];
      out.add(PendingChunk(
        c['seq'] as int,
        [
          for (final e in c['events'] as List)
            if (e is Map) e.cast<String, Object?>()
        ],
        meta: meta is Map ? meta.cast<String, Object?>() : null,
        flags: flags is Map ? flags.cast<String, Object?>() : null,
      ));
    }
    return out.isEmpty ? null : _Delivery(sid, vid, out);
  }
}

/// The ring as it stands, for [clipRingKey]: null when it is empty or over
/// the cap (then the stored one is removed instead, so a stale ring is never
/// sent with a later crash).
String? serialiseRing(List<RecordedEvent> events, Map<String, Object?> meta, int now) {
  if (events.isEmpty) return null;
  try {
    final text = jsonEncode({'v': 1, 'at': now, 'meta': meta, 'events': events});
    return utf8Length(text) > clipMaxBytes ? null : text;
  } catch (_) {
    return null;
  }
}
