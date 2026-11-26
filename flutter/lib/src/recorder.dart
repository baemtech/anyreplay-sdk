import 'dart:async';
import 'dart:convert';
import 'dart:ui' show Size;

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import 'crash.dart';
import 'device.dart';
import 'diagnostics.dart';
import 'events.dart';
import 'native_crash.dart';
import 'options.dart';
import 'session.dart';
import 'transport.dart';
import 'tree.dart';
import 'version.dart';

/// Where the recorder is in its life (contract §3.5, §3.6).
enum RecorderStatus { idle, awaitingConsent, recording, sampledOut, stopped }

/// Everything the recorder needs from the platform, in one place — the React
/// Native SDK's `Host`. The real one is `FlutterHost`; tests drive the whole
/// recorder through a fake clock, store, timers and HTTP client.
abstract class RecorderHost {
  int now();

  /// The view's size in logical pixels.
  Size screenSize();
  DeviceDescription device();

  /// The device's preferred language as a BCP 47 tag.
  String? locale();

  /// The screen as a `Screen` tree of [size], or null while there is none.
  MobileNode? capture(Size size);

  Object setInterval(void Function() callback, Duration every);
  void clearInterval(Object handle);
  http.Client get client;

  /// Starts and stops listening to taps. Nothing is heard before recording.
  void attachTaps(void Function(double x, double y) onTap);
  void detachTaps();
  ErrorHooks get errorHooks;
}

/// Identify traits; at least one of the two.
class IdentifyTraits {
  const IdentifyTraits({this.userId, this.email});
  final String? userId;
  final String? email;
  bool get isEmpty => (userId == null || userId!.isEmpty) && (email == null || email!.isEmpty);

  /// What this and [later] said together, [later] winning where both say something.
  IdentifyTraits mergedWith(IdentifyTraits later) => IdentifyTraits(
        userId: later.userId != null && later.userId!.isNotEmpty ? later.userId : userId,
        email: later.email != null && later.email!.isNotEmpty ? later.email : email,
      );
}

const int _maxPendingEvents = 32;
const int _rageCount = 3;
const int _rageWindowMs = 1000;
const int _rageRadius = 30;

/// Records one launch: the port of the React Native SDK's `createRecorder`.
class Recorder {
  Recorder._(this.options, this.host, this.store, this.nativeCrash);

  /// Creates the recorder and, unless it waits for consent, starts it.
  /// [beforeStart] runs first: calls the app made while `init` was still
  /// reading the platform land as if made before recording started (a screen
  /// named then opens the recording; a tracked event waits for it).
  static Future<Recorder> create(
    ResolvedOptions options,
    RecorderHost host,
    AnyReplayStore store, {
    void Function(Recorder recorder)? beforeStart,
    NativeCrashSource nativeCrash = const NoNativeCrashSource(),
  }) async {
    final recorder = Recorder._(options, host, store, nativeCrash);
    beforeStart?.call(recorder);
    if (recorder._status == RecorderStatus.stopped) return recorder;
    if (options.requireConsent) {
      recorder._status = RecorderStatus.awaitingConsent;
    } else {
      await recorder._begin();
    }
    return recorder;
  }

  final ResolvedOptions options;
  final RecorderHost host;
  final AnyReplayStore store;

  /// The plugin's native side: crashes in the app's Kotlin, Java, Swift or
  /// Objective-C code, kept for the next launch (native_crash.dart).
  final NativeCrashSource nativeCrash;

  RecorderStatus _status = RecorderStatus.idle;
  Identity? _identity;
  Transport? _transport;
  bool _starting = false;
  int _refusals = 0;
  bool _regrant = false;
  MobileNode? _previous;
  Object? _ticker;
  Object? _flusher;
  bool _background = false;
  int _screenCount = 1;
  String? _currentScreen;
  bool _firstScreenNamed = false;
  Size? _lastSize;
  bool _resync = false;
  int _lastActivity = 0;
  Map<String, Object?>? _sessionMeta;
  IdentifyTraits? _pendingTraits;
  IdentifyTraits? _knownTraits;
  Diagnostics? _diagnostics;
  final List<(String, Object)> _pending = [];
  final List<({int x, int y, int t})> _recentTaps = [];

  /// Crash clip mode: sampled out, consented, and the project wants clips.
  /// The screen is read into this ring instead of a transport; see crash.dart.
  ClipRing? _clip;

  /// A clip being finished: what it holds so far, while the aftermath is recorded.
  ({String sessionId, List<RecordedEvent> events})? _aftermath;
  Object? _clipTimer;

  /// When this visitor's last clip was made (also kept in the store).
  int _lastClipAt = 0;
  bool get _clipping => _status == RecorderStatus.sampledOut && _clip != null;

  /// Time spent reading the screen on the last tick, for the debug log.
  Duration lastTickTime = Duration.zero;

  RecorderStatus get status => _status;
  String? get sessionId => _identity?.sessionId;
  String? get visitorId => _identity?.visitorId;

  void _warn(String message) {
    if (options.debug) debugPrint('[anyreplay] $message');
  }

  int _ticksSinceReport = 0;
  Duration _tickTotal = Duration.zero;
  Duration _tickSlowest = Duration.zero;

  /// With `debug`, how long reading the screen takes: one line per 20 ticks,
  /// the average and the slowest.
  void _reportTickTime(Duration took) {
    _ticksSinceReport += 1;
    _tickTotal += took;
    if (took > _tickSlowest) _tickSlowest = took;
    if (_ticksSinceReport < 20) return;
    final average = _tickTotal.inMicroseconds / _ticksSinceReport / 1000;
    debugPrint('[anyreplay] read the screen in ${average.toStringAsFixed(1)} ms on average, '
        'slowest ${(_tickSlowest.inMicroseconds / 1000).toStringAsFixed(1)} ms, over the last $_ticksSinceReport ticks');
    _ticksSinceReport = 0;
    _tickTotal = Duration.zero;
    _tickSlowest = Duration.zero;
  }

  /// Traits for the current session that wait for its first accepted chunk.
  ///
  /// Ingest attaches traits to a session that exists and answers `202
  /// { applied: false }` to one that does not, keeping nothing (contract
  /// §8.2). An app that identifies a signed-in person right after `init` —
  /// the usual place — sent it seconds before the first chunk, so the session
  /// was never linked to anyone (found on an iOS simulator). The traits now
  /// wait for the first chunk ingest accepts; two calls while waiting go as
  /// one request. Reset with every session, so the session after a long
  /// absence, or one resumed at launch, waits for its own.
  IdentifyTraits? _traitsAwaitingSession;

  /// Traits ingest answered `applied: false` to after the session existed:
  /// tried once more after the next accepted chunk.
  IdentifyTraits? _traitsToRetry;

  /// Whether a chunk of the current session has been accepted, so the session exists.
  bool _sessionDelivered = false;

  /// Counts identify calls, so an answer to an older one cannot schedule a
  /// retry over traits given since.
  int _identifyCalls = 0;

  void _sendIdentity(Identity who, IdentifyTraits traits) {
    _identifyCalls += 1;
    _traitsToRetry = null;
    if (!_sessionDelivered) {
      _traitsAwaitingSession = _traitsAwaitingSession?.mergedWith(traits) ?? traits;
      return;
    }
    _postIdentity(who, traits, retryIfUnapplied: true);
  }

  /// A chunk of the current session was accepted: it exists, and what waited for it goes.
  void _noteDelivered() {
    final who = _identity;
    if (who == null) return;
    _sessionDelivered = true;
    final waiting = _traitsAwaitingSession;
    final retry = _traitsToRetry;
    _traitsAwaitingSession = null;
    _traitsToRetry = null;
    if (waiting != null) {
      _postIdentity(who, waiting, retryIfUnapplied: true);
    } else if (retry != null) {
      _postIdentity(who, retry, retryIfUnapplied: false);
    }
  }

  void _postIdentity(Identity who, IdentifyTraits traits, {required bool retryIfUnapplied}) {
    final call = _identifyCalls;
    final body = jsonEncode({
      'projectKey': options.projectKey,
      'sessionId': who.sessionId,
      if (traits.userId != null && traits.userId!.isNotEmpty) 'userId': traits.userId,
      if (traits.email != null && traits.email!.isNotEmpty) 'email': traits.email,
      if (options.appId != null) 'appId': options.appId,
    });
    unawaited(host.client
        .post(Uri.parse('${options.ingestUrl}/v1/ingest/identify'),
            headers: const {'Content-Type': 'application/json'}, body: body)
        .timeout(requestTimeout)
        .then<void>((response) {
      if (!retryIfUnapplied || response.statusCode != 202) return;
      final reply = jsonDecode(response.body);
      // The row was not there after all (a server that lost a race): one more
      // try after the next accepted chunk — unless newer traits have been
      // given since, or the session has changed.
      if (reply is Map &&
          reply['applied'] == false &&
          identical(_identity, who) &&
          call == _identifyCalls &&
          _traitsAwaitingSession == null) {
        _traitsToRetry = traits;
      }
    }).catchError((Object _) {/* best-effort, never surfaces */}));
  }

  void _emit(RecordedEvent event) {
    if (_clipping) {
      _clip!.push(event);
      _aftermath?.events.add(event);
      return;
    }
    _lastActivity = event['timestamp'] as int;
    _transport?.push(event);
    unawaited(touchSession(store, _lastActivity).catchError((Object _) {}));
  }

  Size _screenSize() {
    final size = host.screenSize();
    return Size(size.width.roundToDouble(), size.height.roundToDouble());
  }

  void _emitSize(Size size) {
    _lastSize = size;
    _emit({
      'type': metaEvent,
      'timestamp': host.now(),
      'data': {'width': size.width.round(), 'height': size.height.round()}
    });
  }

  void _emitCustom(String tag, Object payload) {
    if (_clipping) {
      _emit({
        'type': customEvent,
        'timestamp': host.now(),
        'data': {'tag': tag, 'payload': payload}
      });
      return;
    }
    if (_status == RecorderStatus.stopped || _status == RecorderStatus.sampledOut) return;
    if (_status == RecorderStatus.recording && _transport != null) {
      _rollIfIdle();
      _emit({
        'type': customEvent,
        'timestamp': host.now(),
        'data': {'tag': tag, 'payload': payload}
      });
      return;
    }
    if (_pending.length >= _maxPendingEvents) {
      _warn('dropped $tag: too many events before recording started');
      return;
    }
    _pending.add((tag, payload));
  }

  /// Sends what was tagged before recording started, stamped now: an event
  /// stamped before the recording's first would replay off the timeline.
  void _drainPending() {
    if (_pending.isEmpty || _status != RecorderStatus.recording || _transport == null) return;
    final items = List.of(_pending);
    _pending.clear();
    for (final (tag, payload) in items) {
      if (tag == errorTag) _transport!.flags.hasError = true;
      _emit({
        'type': customEvent,
        'timestamp': host.now(),
        'data': {'tag': tag, 'payload': payload}
      });
    }
  }

  /// Reads the screen and sends what changed: a whole snapshot first and
  /// after a navigation or a resize, a diff otherwise, nothing when nothing
  /// changed.
  void tick() {
    if ((_status != RecorderStatus.recording && !_clipping) || _background) return;
    if (_rollIfIdle()) return;
    // A crash clip is kept in segments that each open with a whole screen,
    // so the oldest can be dropped without breaking what follows it.
    final clip = _clip;
    if (clip != null && _clipping && clip.needsSegment(host.now())) {
      _keepRing();
      clip.startSegment(host.now());
      _resync = true;
    }
    final size = _screenSize();
    final last = _lastSize;
    if (_resync || last == null || size != last) {
      final transport = _transport;
      if (_resync && transport != null && transport.lostOpening && _sessionMeta != null) {
        _sessionMeta = {..._sessionMeta!, 'startedAt': host.now()};
        transport.setMeta(_sessionMeta!);
      }
      _emitSize(size);
      _previous = null;
      if (_resync && _currentScreen != null) {
        _emit({
          'type': metaEvent,
          'timestamp': host.now(),
          'data': {'href': _currentScreen}
        });
      }
      _resync = false;
    }

    final watch = Stopwatch()..start();
    MobileNode? tree;
    try {
      tree = host.capture(size);
    } catch (error) {
      _warn('could not read the screen: $error');
    }
    lastTickTime = watch.elapsed;
    if (options.debug) _reportTickTime(lastTickTime);
    if (tree == null) return;

    final previous = _previous;
    if (previous == null) {
      _emit({
        'type': fullSnapshotEvent,
        'timestamp': host.now(),
        'data': {'node': tree.toJson()}
      });
      _previous = tree;
      return;
    }
    final mutation = diffTrees(previous, tree);
    _previous = tree;
    if (mutation.isEmpty) return;
    _emit({'type': incrementalEvent, 'timestamp': host.now(), 'data': mutation.toJson()});
  }

  /// Writes the ring as it stands (the segments completed so far) to the
  /// store, for a native crash that would take the memory with it. Overwritten
  /// every segment, and skipped when it is over the cap.
  void _keepRing() {
    final clip = _clip;
    if (clip == null || !_clipping) return;
    final events = clip.events();
    if (events.isEmpty) return;
    final text = serialiseRing(events, _describeSession(), host.now());
    unawaited(
        (text == null ? store.removeItem(clipRingKey) : store.setItem(clipRingKey, text)).catchError((Object _) {}));
  }

  void _startTimers() {
    _ticker ??= host.setInterval(tick, options.snapshotInterval);
    _flusher ??= host.setInterval(() => unawaited(_transport?.flush()), options.flushInterval);
  }

  void _stopTimers() {
    if (_ticker != null) host.clearInterval(_ticker!);
    if (_flusher != null) host.clearInterval(_flusher!);
    _ticker = null;
    _flusher = null;
  }

  void _halt() {
    if (_clipTimer != null) host.clearInterval(_clipTimer!);
    _clipTimer = null;
    _clip = null;
    _aftermath = null;
    _stopTimers();
    host.detachTaps();
    _diagnostics?.stop();
    _diagnostics = null;
  }

  bool get _mayStart => _status == RecorderStatus.idle || _status == RecorderStatus.awaitingConsent;

  void _openSession(Identity who) {
    _identity = who;
    _sessionDelivered = false;
    _traitsAwaitingSession = null;
    _traitsToRetry = null;
    late final Transport channel;
    channel = Transport(
      TransportOptions(
        ingestUrl: options.ingestUrl,
        projectKey: options.projectKey,
        sessionId: who.sessionId,
        visitorId: who.visitorId,
        maxEventsPerChunk: options.maxEventsPerChunk,
        maxBufferedEvents: options.maxBufferedEvents,
        initialSeq: who.nextSeq,
        appId: options.appId,
        now: host.now,
        debug: options.debug,
      ),
      TransportHooks(
        // Every hook checks it still belongs to the current session: an
        // ended session sending its tail must not touch the new one.
        onSent: (_, __) {
          if (identical(channel, _transport)) _noteDelivered();
        },
        onSeqReserved: (next) {
          if (identical(channel, _transport)) unawaited(reserveSeq(store, next).catchError((Object _) {}));
        },
        onDropped: (_) {
          if (identical(channel, _transport)) _resync = true;
        },
        onStopped: (reason) {
          if (!identical(channel, _transport)) return;
          _status = RecorderStatus.stopped;
          _halt();
          if (reason == 'rejected_402') unawaited(startCooldown(store, host.now()).catchError((Object _) {}));
          _warn('recording stopped: $reason');
        },
      ),
      host.client,
    );
    _transport = channel;

    final cap = options.maxSessionsPerMonth;
    _sessionMeta = {
      ..._describeSession(),
      // The cap is read when ingest creates the session: on seq 0 only.
      if (cap != null && who.nextSeq == 0) 'sessionCap': cap,
    };
    channel.setMeta(_sessionMeta!);
    channel.flags.pageCount = _screenCount;

    _emitSize(_screenSize());
    if (_currentScreen != null) {
      _emit({
        'type': metaEvent,
        'timestamp': host.now(),
        'data': {'href': _currentScreen}
      });
    }
    _previous = null;
    _resync = false;
  }

  /// What a session's first chunk tells ingest about the device, the app and the screen it starts on.
  Map<String, Object?> _describeSession() {
    final device = host.device();
    final size = _screenSize();
    return {
      'startedAt': host.now(),
      if (host.locale() case final lang?) 'lang': lang,
      'userAgent': flutterUserAgent(device, sdkVersion),
      'screenWidth': size.width.round(),
      'screenHeight': size.height.round(),
      'platform': sdkPlatform,
      'sdk': {'name': sdkName, 'version': sdkVersion},
      if (options.appVersion != null) 'appVersion': options.appVersion,
      if (device.model != null && device.model!.isNotEmpty)
        'deviceModel': device.model!.length > 64 ? device.model!.substring(0, 64) : device.model,
      if (_currentScreen != null) 'url': _currentScreen,
    };
  }

  /// A hook heard an error, or the app reported a fatal one. A fatal error
  /// in a recorded session is sent at once; for a visitor who is not
  /// recorded, any error nobody handled makes a crash clip.
  void _onCaught(ErrorKind kind) {
    if (_status == RecorderStatus.recording) {
      if (kind == ErrorKind.fatal) unawaited(_transport?.flush(force: true).catchError((Object _) {}));
      return;
    }
    if (_clipping) _triggerClip();
  }

  /// Makes a crash clip of what the ring holds, keeps recording for two
  /// seconds of aftermath, then sends it as a new session. A Flutter app
  /// almost always outlives an uncaught error, so it is sent directly.
  void _triggerClip() {
    final clip = _clip;
    final who = _identity;
    final now = host.now();
    if (clip == null || who == null || _aftermath != null) return;
    if (_lastClipAt > 0 && now - _lastClipAt < clipCooldownMs) return;
    final events = clip.events();
    if (events.isEmpty) return;
    _lastClipAt = now;
    unawaited(store.setItem(clipAtKey, '$now').catchError((Object _) {}));
    final sessionId = uuidV4();
    final meta = _describeSession();
    _aftermath = (sessionId: sessionId, events: [...events]);
    _clipTimer = host.setInterval(() {
      if (_clipTimer != null) host.clearInterval(_clipTimer!);
      _clipTimer = null;
      final done = _aftermath;
      _aftermath = null;
      if (done == null || done.sessionId != sessionId) return;
      final chunks = clipChunks(done.events, meta, options.maxEventsPerChunk);
      if (chunks.isEmpty) return;
      unawaited(uploadChunks(
        host.client,
        ingestUrl: options.ingestUrl,
        projectKey: options.projectKey,
        sessionId: sessionId,
        visitorId: who.visitorId,
        appId: options.appId,
        now: host.now,
        chunks: chunks,
      ).catchError((Object _) => false));
    }, clipAftermath);
  }

  /// A sampled-out visitor who has consented: start keeping a crash clip
  /// when the app's option or, failing that, the project's setting says so.
  Future<void> _startClipMode(int epoch) async {
    if (options.crashClip == false || !options.recordErrors) return;
    final enabled = options.crashClip == true ||
        await remoteCrashClip(store, host.client,
                ingestUrl: options.ingestUrl, projectKey: options.projectKey, appId: options.appId, now: host.now())
            .catchError((Object _) => false);
    if (!enabled || _refusals != epoch || _status != RecorderStatus.sampledOut || _clip != null) return;
    final stored = int.tryParse(await store.getItem(clipAtKey).catchError((Object _) => null) ?? '');
    if (_refusals != epoch || _status != RecorderStatus.sampledOut || _clip != null) return;
    _lastClipAt = stored ?? 0;
    _clip = ClipRing();
    _previous = null;
    _lastSize = null;
    _diagnostics = Diagnostics(
      hooks: host.errorHooks,
      install: options.recordErrors,
      emit: _emitCustom,
      onError: () {},
      onCaught: _onCaught,
    );
    host.attachTaps(touch);
    tick();
    if (!_background) _ticker ??= host.setInterval(tick, options.snapshotInterval);
  }

  void _startNextSession() {
    final identity = _identity;
    final old = _transport;
    if (identity == null || old == null) return;
    unawaited(old.flush(force: true).catchError((Object _) {}));
    _recentTaps.clear();
    _screenCount = 1;
    _firstScreenNamed = _currentScreen != null;
    final next = beginNewSession(store, identity.visitorId, host.now());
    _openSession(next);
    tick();
    if (_knownTraits != null) _sendIdentity(next, _knownTraits!);
  }

  /// After 30 minutes without an event the session has ended, even with the
  /// app open the whole time (a phone left on a desk): whatever happens next
  /// opens a new one rather than appending to the old (contract §3.2).
  /// True when it did.
  bool _rollIfIdle() {
    if (_status != RecorderStatus.recording || _transport == null || _lastActivity == 0) return false;
    if (host.now() - _lastActivity < sessionIdleMs) return false;
    _startNextSession();
    return true;
  }

  /// Everything that leaves a trace happens here, and nothing before it:
  /// the visitor id written, the transport opened, the hooks installed, the
  /// screen read.
  Future<void> _begin() async {
    if (_starting || !_mayStart) return;
    _starting = true;
    final epoch = _refusals;
    try {
      // The last launch's native crash goes first, into the recording it
      // ended (or as a crash clip), before this launch resumes or replaces
      // that session.
      await deliverNativeCrash(
        source: nativeCrash,
        store: store,
        client: host.client,
        options: options,
        now: host.now,
        stillAllowed: () => _refusals == epoch,
        warn: _warn,
      ).catchError((Object _) {});
      unawaited(nativeCrash.install().catchError((Object _) {}));
      if (_refusals != epoch || !_mayStart) {
        if (_refusals != epoch) await forgetVisitor(store);
        return;
      }
      final who = await resolveIdentity(store, host.now());
      if (_refusals != epoch || !_mayStart) {
        if (_refusals != epoch || _status == RecorderStatus.stopped) await forgetVisitor(store);
        return;
      }
      _identity = who;

      if (!isSampledIn(who.visitorId, options.sampleRate)) {
        _status = RecorderStatus.sampledOut;
        unawaited(_startClipMode(epoch).catchError((Object _) {}));
        return;
      }
      if (await inCooldown(store, host.now()).catchError((Object _) => false)) {
        _status = RecorderStatus.stopped;
        _warn('not recording: ingest refused a new session recently');
        return;
      }
      if (_refusals != epoch) {
        _identity = null;
        await forgetVisitor(store);
        return;
      }
      if (!_mayStart) return;

      _status = RecorderStatus.recording;
      _openSession(who);
      _diagnostics = Diagnostics(
        hooks: host.errorHooks,
        install: options.recordErrors,
        emit: _emitCustom,
        onError: () => _transport?.flags.hasError = true,
        onCaught: _onCaught,
      );
      host.attachTaps(touch);
      tick();
      _drainPending();
      if (!_background) _startTimers();
      if (_pendingTraits != null) {
        _sendIdentity(who, _pendingTraits!);
        _knownTraits = _pendingTraits;
        _pendingTraits = null;
      }
    } finally {
      _starting = false;
      if (_regrant) {
        _regrant = false;
        if (_mayStart) unawaited(_begin().catchError((Object _) {}));
      }
    }
  }

  // ------------------------------------------------------------ public API --

  void consent(bool granted) {
    if (granted) {
      if (_starting) _regrant = true;
      unawaited(_begin().catchError((Object _) {}));
      return;
    }
    _refusals += 1;
    _regrant = false;
    _halt();
    _transport?.stop('consent_withdrawn');
    if (_mayStart || _status == RecorderStatus.sampledOut) {
      _status = RecorderStatus.awaitingConsent;
      _identity = null;
    }
    _pendingTraits = null;
    _traitsAwaitingSession = null;
    _traitsToRetry = null;
    _knownTraits = null;
    _pending.clear();
    unawaited(forgetVisitor(store).catchError((Object _) {}));
    // A native crash kept from an earlier launch goes unsent.
    unawaited(nativeCrash.take().catchError((Object _) => null));
  }

  void identify(IdentifyTraits traits) {
    if (traits.isEmpty) return;
    final userId = traits.userId;
    final email = traits.email;
    if (userId != null && userId.length > 190) return _warn('identify() ignored: userId longer than 190');
    if (email != null && (email.length > 255 || !RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]+$').hasMatch(email))) {
      return _warn('identify() ignored: email is not an address');
    }
    final identity = _identity;
    if (identity != null && _transport != null && _status == RecorderStatus.recording) {
      _sendIdentity(identity, traits);
      _knownTraits = traits;
      return;
    }
    // Two calls before recording starts send what both said, once.
    if (_mayStart) _pendingTraits = _pendingTraits?.mergedWith(traits) ?? traits;
  }

  /// A screen change: a Meta `href`, and a whole snapshot on the next tick.
  void screen(String name) {
    if (name.isEmpty) return;
    _rollIfIdle();
    _currentScreen = name.length > 2048 ? name.substring(0, 2048) : name;
    if (!_firstScreenNamed) {
      _firstScreenNamed = true;
    } else if (_status == RecorderStatus.recording) {
      _screenCount += 1;
    }
    if (_clipping) {
      _previous = null;
      _emit({
        'type': metaEvent,
        'timestamp': host.now(),
        'data': {'href': _currentScreen}
      });
      return;
    }
    if (_status != RecorderStatus.recording) return;
    _previous = null;
    _transport?.flags.pageCount = _screenCount;
    _emit({
      'type': metaEvent,
      'timestamp': host.now(),
      'data': {'href': _currentScreen}
    });
  }

  /// A tap, in logical pixels, when the finger lifted.
  void touch(double x, double y) {
    if (_status != RecorderStatus.recording && !_clipping) return;
    _rollIfIdle();
    final t = host.now();
    final tap = (x: x.round(), y: y.round(), t: t);
    _emit({
      'type': incrementalEvent,
      'timestamp': t,
      'data': {'source': mouseInteractionSource, 'type': 2, 'x': tap.x, 'y': tap.y}
    });
    _recentTaps.add(tap);
    while (_recentTaps.isNotEmpty && t - _recentTaps.first.t > _rageWindowMs) {
      _recentTaps.removeAt(0);
    }
    // Counted around the tap that just landed, on the numbers the wire carries.
    final near =
        _recentTaps.where((o) => (o.x - tap.x).abs() < _rageRadius && (o.y - tap.y).abs() < _rageRadius).length;
    if (near >= _rageCount && !_clipping) _transport?.flags.hasRageClick = true;
  }

  /// The app went to the background: send the tail now, and stop reading
  /// the screen until it comes back.
  Future<void> background() async {
    if (_background) return;
    _background = true;
    _stopTimers();
    _keepRing();
    if (_status != RecorderStatus.recording) return;
    await _transport?.flush(force: true);
  }

  /// The app is back. After 30 idle minutes that is a new session; otherwise
  /// the next tick sends a whole screen and anything held back is retried.
  void foreground() {
    final wasBackground = _background;
    _background = false;
    if (_clipping) {
      _previous = null;
      _ticker ??= host.setInterval(tick, options.snapshotInterval);
      return;
    }
    if (_status != RecorderStatus.recording || _transport == null) return;
    if (wasBackground || _ticker == null) _startTimers();
    if (host.now() - _lastActivity >= sessionIdleMs) {
      _startNextSession();
      return;
    }
    _previous = null;
    _transport!.retryNow();
    unawaited(_transport!.flush().catchError((Object _) {}));
  }

  void track(String name, [Map<String, Object?>? properties]) {
    final payload = validateTrack(name, properties);
    if (payload is String) return _warn('track() ignored: $payload');
    _emitCustom(trackTag, (payload as TrackPayload).toJson());
  }

  /// An error the app caught itself. [fatal] says it ends what the person
  /// was doing — the app's own crash path, or a zone handler that catches
  /// everything — and records it as a crash, which also makes a crash clip.
  void trackError(Object error, [StackTrace? stack, bool fatal = false]) {
    if (!options.recordErrors) return;
    final kind = fatal ? ErrorKind.fatal : ErrorKind.error;
    final diagnostics = _diagnostics;
    if (diagnostics != null) {
      diagnostics.record(kind, error, stack: stack);
      if (fatal) _onCaught(kind);
      return;
    }
    _emitCustom(errorTag, errorPayload(kind, error, stack: stack));
  }

  void stop() {
    _halt();
    unawaited(nativeCrash.uninstall().catchError((Object _) {}));
    _transport?.stop('stopped_by_app');
    if (_mayStart) _status = RecorderStatus.stopped;
    _pendingTraits = null;
    _traitsAwaitingSession = null;
    _traitsToRetry = null;
  }

  Future<void> flush({bool force = false}) => _transport?.flush(force: force) ?? Future.value();

  /// For tests and the debug log.
  @visibleForTesting
  Transport? get transport => _transport;
}
