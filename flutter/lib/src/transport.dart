import 'dart:async';
import 'dart:convert';
import 'dart:io' show HttpDate;
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import 'tree.dart';

/// Ships chunks to ingest (docs/SDK-CONTRACT.md §10): the same endpoint,
/// schema, limits and answers as the React Native SDK's `transport.ts`, of
/// which this is a port.
///
/// One request at a time; chunks cut by count (200) and by bytes (about
/// 256 KB, never over 512 KB); a failed chunk kept and retried with backoff
/// and `Retry-After`; a refusal (4xx) ends the recording for the launch.

/// One recorded event, already in its wire shape.
typedef RecordedEvent = Map<String, Object?>;

/// What ingest accepts as one request body. Above it the answer is 413.
const int maxBodyBytes = 512 * 1024;

/// What a chunk aims for: half the limit.
const int targetChunkBytes = 256 * 1024;
const int _envelopeBytes = 16 * 1024;

/// One event bigger than this can never be sent, alone or otherwise.
const int maxEventBytes = maxBodyBytes - _envelopeBytes;
const int _minChunkBytes = 8 * 1024;

/// How many times one flush may move to a new chunk number before giving up.
const int _maxStaleRecoveries = 3;

/// First wait after a failure; doubles with each failure in a row.
const int backoffBaseMs = 2000;

/// The longest wait between attempts, however long the outage.
const int backoffMaxMs = 60000;
const int _retryAfterMaxMs = 10 * 60000;

/// How long one request may take before it counts as a failure.
const Duration requestTimeout = Duration(seconds: 30);

/// The chunk's flags; cumulative over the session.
class ChunkFlags {
  bool? hasError;
  bool? hasRageClick;
  int? pageCount;

  bool get isEmpty => hasError == null && hasRageClick == null && pageCount == null;

  Map<String, Object> toJson() => {
        if (pageCount != null) 'pageCount': pageCount!,
        if (hasRageClick != null) 'hasRageClick': hasRageClick!,
        if (hasError != null) 'hasError': hasError!,
      };
}

class TransportOptions {
  TransportOptions({
    required this.ingestUrl,
    required this.projectKey,
    required this.sessionId,
    required this.visitorId,
    required this.maxEventsPerChunk,
    required this.maxBufferedEvents,
    required this.now,
    this.initialSeq = 0,
    this.appId,
    this.chunkBytes = targetChunkBytes,
    Random? random,
    this.debug = false,
  }) : random = random ?? Random();

  final String ingestUrl;
  final String projectKey;
  final String sessionId;
  final String visitorId;
  final int maxEventsPerChunk;
  final int maxBufferedEvents;

  /// The clock the events are stamped with; also `sentAt` and the backoff's.
  final int Function() now;
  final int initialSeq;
  final String? appId;
  final int chunkBytes;
  final Random random;
  final bool debug;
}

class TransportHooks {
  const TransportHooks({this.onStopped, this.onSent, this.onSeqReserved, this.onDropped});

  final void Function(String reason)? onStopped;
  final void Function(int seq, int events)? onSent;

  /// The next free chunk number, before a request using the current one leaves.
  final void Function(int nextSeq)? onSeqReserved;

  /// Events the replayed tree depends on were dropped; the recorder answers
  /// with a fresh Meta and full snapshot.
  final void Function(int count)? onDropped;
}

class _Buffered {
  _Buffered(this.event, this.bytes);
  final RecordedEvent event;
  final int bytes;
}

enum _Outcome { sent, again, failed }

/// UTF-8 length of [text], which is what ingest's 512 KB counts.
int utf8Length(String text) {
  var bytes = 0;
  for (var i = 0; i < text.length; i += 1) {
    final code = text.codeUnitAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      final next = text.codeUnitAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/// Whether the replayed screen depends on this event: a snapshot, a mutation
/// or a Meta. Taps and custom events stand on their own.
bool isTreeEvent(RecordedEvent event) {
  final type = event['type'];
  if (type == fullSnapshotEvent || type == metaEvent) return true;
  final data = event['data'];
  return type == incrementalEvent && data is Map && data['source'] == mutationSource;
}

/// `Retry-After` in milliseconds — seconds or an HTTP date — or null.
int? retryAfterMs(Map<String, String> headers, int now) {
  final raw = headers['retry-after'] ?? headers['Retry-After'];
  if (raw == null) return null;
  final value = raw.trim();
  if (RegExp(r'^[0-9]+(\.[0-9]+)?$').hasMatch(value)) return (double.parse(value) * 1000).round();
  try {
    final at = HttpDate.parse(value);
    return max(0, at.millisecondsSinceEpoch - now);
  } catch (_) {
    return null;
  }
}

class Transport {
  Transport(this.options, this.hooks, this.client)
      : _seq = options.initialSeq,
        _chunkBytes = options.chunkBytes,
        _chunkEvents = options.maxEventsPerChunk;

  final TransportOptions options;
  final TransportHooks hooks;
  final http.Client client;

  List<_Buffered> _buffer = [];
  int _seq;
  int _consecutiveFailures = 0;
  bool _stopped = false;
  bool _inFlight = false;
  int _lastAttemptedSeq = -1;
  int _staleRecoveries = 0;
  Map<String, Object?>? _pendingMeta;
  final ChunkFlags flags = ChunkFlags();
  int _retryAt = 0;
  int _serverRetryAt = 0;
  int _chunkBytes;
  int _chunkEvents;
  bool _delivered = false;
  bool _openingLost = false;
  int _invalidInARow = 0;

  bool get isStopped => _stopped;
  int get bufferedCount => _buffer.length;
  int get seq => _seq;
  int get nextAttemptAt => _retryAt;
  bool get hasDelivered => _delivered;

  /// The opening Meta was dropped unsent: the next Meta the recorder sends
  /// opens the recording.
  bool get lostOpening => _openingLost && !_delivered;

  void setMeta(Map<String, Object?> meta) => _pendingMeta = meta;

  void push(RecordedEvent event) {
    if (_stopped) return;
    int bytes;
    try {
      bytes = utf8Length(jsonEncode(event));
    } catch (_) {
      return;
    }
    _buffer.add(_Buffered(event, bytes));
    _bound();
    if (_buffer.length >= options.maxEventsPerChunk) unawaited(flush());
  }

  void stop(String reason) {
    if (_stopped) return;
    _stopped = true;
    _buffer = [];
    hooks.onStopped?.call(reason);
  }

  /// The next flush may go now instead of waiting out a backoff — the app is
  /// back in the foreground. A wait the server asked for still stands.
  void retryNow() {
    _retryAt = _serverRetryAt > options.now() ? _serverRetryAt : 0;
  }

  String _body(List<RecordedEvent> events) => jsonEncode({
        'projectKey': options.projectKey,
        'sessionId': options.sessionId,
        'visitorId': options.visitorId,
        'seq': _seq,
        'events': events,
        if (options.appId != null) 'appId': options.appId,
        if (_pendingMeta != null) 'meta': _pendingMeta,
        if (!flags.isEmpty) 'flags': flags.toJson(),
        // Stamped as the body is built, so a retry carries when it was sent.
        'sentAt': options.now(),
      });

  /// Sends what was buffered when it began, as as many chunks as it takes.
  /// [force] is the background flush: it goes even inside a backoff, but not
  /// inside a wait the server asked for.
  Future<void> flush({bool force = false}) async {
    if (_stopped || _inFlight || _buffer.isEmpty) return;
    final now = options.now();
    if (now < _retryAt && !(force && now >= _serverRetryAt)) return;

    _inFlight = true;
    try {
      var budget = _buffer.length;
      while (!_stopped && _buffer.isNotEmpty && budget > 0) {
        final before = _buffer.length;
        final outcome = await _sendOne();
        if (outcome == _Outcome.failed) break;
        budget -= max(0, before - _buffer.length);
        if (outcome == _Outcome.sent && _buffer.isEmpty) {
          _chunkBytes = options.chunkBytes;
          _chunkEvents = options.maxEventsPerChunk;
        }
      }
    } finally {
      _inFlight = false;
    }
  }

  Future<_Outcome> _sendOne() async {
    final batch = _takeBatch();
    if (batch.isEmpty) return _Outcome.sent;
    final events = [for (final b in batch) b.event];

    final retry = _lastAttemptedSeq == _seq;
    _lastAttemptedSeq = _seq;
    // Reserved before the request leaves: an app killed mid-flight must not
    // hand this number to its next launch.
    hooks.onSeqReserved?.call(_seq + 1);

    http.Response response;
    try {
      response = await client
          .post(
            Uri.parse('${options.ingestUrl}/v1/ingest/events'),
            headers: const {'Content-Type': 'application/json'},
            body: _body(events),
          )
          .timeout(requestTimeout);
    } catch (_) {
      // Offline, almost always: keep it and wait.
      _requeue(batch);
      _registerFailure();
      return _Outcome.failed;
    }
    if (_stopped) return _Outcome.failed;

    final status = response.statusCode;
    if (status >= 200 && status < 300) {
      final nextSeq = retry ? null : _staleSeqHint(response.body, _seq);
      if (nextSeq != null && _staleRecoveries < _maxStaleRecoveries) {
        // New events the server discarded as a repeat of an earlier launch's
        // number: send them again under the first number it has not seen.
        _staleRecoveries += 1;
        _seq = nextSeq;
        _requeue(batch);
        return _Outcome.again;
      }
      _staleRecoveries = 0;
      _invalidInARow = 0;
      _delivered = true;
      _seq += 1;
      _pendingMeta = null;
      _consecutiveFailures = 0;
      _retryAt = 0;
      _serverRetryAt = 0;
      hooks.onSent?.call(_seq - 1, events.length);
      return _Outcome.sent;
    }

    if (status == 413) {
      // Nothing was stored. Send less, under the next number: one number sent
      // twice with different events reads as SEQ-005 to the checker.
      _lastAttemptedSeq = -1;
      _seq += 1;
      if (batch.length > 1) {
        final sent = batch.fold<int>(0, (sum, b) => sum + b.bytes);
        _chunkBytes = max(_minChunkBytes, min(_chunkBytes, sent) ~/ 2);
        _chunkEvents = max(1, batch.length ~/ 2);
        _requeue(batch);
        return _Outcome.again;
      }
      _warn('dropped an event of ${batch.first.bytes} bytes that ingest would not take');
      _dropped([batch.first.event]);
      return _Outcome.again;
    }

    if (status == 429 || status == 408 || status >= 500) {
      _requeue(batch);
      _registerFailure(status == 429 || status == 503 ? retryAfterMs(response.headers, options.now()) : null);
      return _Outcome.failed;
    }

    if (status == 400 || status == 422) {
      // The contents were refused; the same bytes cannot help. Drop this
      // chunk and carry on, unless every chunk is being refused.
      _invalidInARow += 1;
      if (_invalidInARow >= 3) {
        stop('rejected_$status');
        return _Outcome.failed;
      }
      _lastAttemptedSeq = -1;
      _seq += 1;
      _warn('ingest refused a chunk ($status); dropped it');
      _dropped(events);
      return _Outcome.again;
    }

    // A verdict about this app: a wrong key, a project switched off, an app
    // not allowed, a quota (402). Retrying cannot change it.
    stop('rejected_$status');
    return _Outcome.failed;
  }

  int? _staleSeqHint(String body, int sent) {
    try {
      final reply = jsonDecode(body);
      if (reply is! Map || reply['duplicate'] != true) return null;
      final next = reply['nextSeq'];
      return next is int && next > sent ? next : null;
    } catch (_) {
      return null;
    }
  }

  List<_Buffered> _takeBatch() {
    final batch = <_Buffered>[];
    var bytes = 0;
    final limit = min(options.maxEventsPerChunk, _chunkEvents);
    while (_buffer.isNotEmpty && batch.length < limit) {
      final next = _buffer.first;
      if (next.bytes > maxEventBytes) {
        _buffer.removeAt(0);
        _warn('dropped an event of ${next.bytes} bytes; one chunk carries at most $maxBodyBytes');
        _dropped([next.event]);
        continue;
      }
      if (batch.isNotEmpty && bytes + next.bytes + 1 > _chunkBytes) break;
      batch.add(_buffer.removeAt(0));
      bytes += next.bytes + 1;
    }
    return batch;
  }

  void _requeue(List<_Buffered> batch) {
    _buffer = [...batch, ..._buffer];
    _bound();
  }

  void _bound() {
    final over = _buffer.length - options.maxBufferedEvents;
    if (over <= 0) return;
    final gone = [for (final b in _buffer.sublist(0, over)) b.event];
    _buffer = _buffer.sublist(over);
    _warn('offline buffer full; dropped the oldest $over events');
    _dropped(gone);
  }

  /// Accounts for events that will never be sent. A lost tree event makes
  /// every later tree event still buffered meaningless (MUT-001), so they go
  /// too and the recorder sends a whole new tree.
  void _dropped(List<RecordedEvent> events) {
    if (!events.any(isTreeEvent)) return;
    final before = _buffer.length;
    if (!_delivered) {
      _openingLost = true;
      _buffer = [];
    } else {
      _buffer = _buffer.where((b) => !isTreeEvent(b.event)).toList();
    }
    try {
      hooks.onDropped?.call(events.length + before - _buffer.length);
    } catch (_) {/* never break on bookkeeping */}
  }

  void _registerFailure([int? serverWaitMs]) {
    _consecutiveFailures += 1;
    final now = options.now();
    final ceiling = min(backoffMaxMs, backoffBaseMs * pow(2, min(_consecutiveFailures - 1, 16)).toInt());
    var wait = ceiling / 2 + options.random.nextDouble() * (ceiling / 2);
    if (serverWaitMs != null) {
      final asked = min(serverWaitMs, _retryAfterMaxMs);
      _serverRetryAt = now + asked;
      wait = max(wait, asked.toDouble());
    }
    _retryAt = now + wait.round();
  }

  void _warn(String message) {
    if (options.debug) debugPrint('[anyreplay] $message');
  }
}
