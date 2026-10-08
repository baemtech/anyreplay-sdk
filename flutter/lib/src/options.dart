import 'session.dart';

/// How AnyReplay records this app. Only [projectKey] is required.
///
/// The defaults are the browser SDK's and the React Native SDK's: everyone is
/// recorded, what people type is recorded (except the masking floor, which no
/// option lifts — see the README), errors are recorded, nothing waits for
/// consent unless [requireConsent] says so.
class AnyReplayOptions {
  const AnyReplayOptions({
    required this.projectKey,
    this.ingestUrl = defaultIngestUrl,
    this.appId,
    this.appVersion,
    this.sampleRate = 1,
    this.requireConsent = false,
    this.maskAllInputs = false,
    this.maskAllTyping = false,
    this.maskImages = false,
    this.recordErrors = true,
    this.maxSessionsPerMonth,
    this.snapshotInterval = const Duration(milliseconds: 500),
    this.flushInterval = const Duration(seconds: 5),
    this.maxEventsPerChunk = 200,
    this.maxBufferedEvents = 2000,
    this.storage,
    this.debug = false,
  });

  /// The public key from the dashboard: `ar_pk_live_…` or `ar_pk_test_…`.
  final String projectKey;

  /// Ingest's address. Change it only for a self-hosted AnyReplay.
  final String ingestUrl;

  /// The bundle id (iOS) or package name (Android). Read from the app when
  /// left out, which is almost always what you want; ingest matches it
  /// against the project's allowed apps.
  final String? appId;

  /// The version people see (`1.4.2`). Read from the app when left out.
  final String? appVersion;

  /// The share of people recorded, 0 … 1. Decided once per person from their
  /// visitor id, so whoever is recorded stays recorded.
  final double sampleRate;

  /// Record nothing, store nothing and send nothing until [AnyReplay.consent]
  /// is called with `true`.
  final bool requireConsent;

  /// Hide the value of every text field. Off by default: a replay of a form
  /// nobody could finish is only useful if you can see what they typed.
  final bool maskAllInputs;

  /// The same, and it cannot be weakened by a `maskAllInputs: false` set
  /// elsewhere.
  final bool maskAllTyping;

  /// Record no image at all: no address, no uploaded copy.
  final bool maskImages;

  /// Record uncaught errors (`FlutterError.onError` and
  /// `PlatformDispatcher.onError`), always handing them on to the handlers
  /// that were there before.
  final bool recordErrors;

  /// Stop starting new sessions after this many in a calendar month. Ingest
  /// applies the lower of this and the project's own cap.
  final int? maxSessionsPerMonth;

  /// How often the screen is read. Never below 100 ms.
  final Duration snapshotInterval;

  /// How often buffered events are sent when fewer than [maxEventsPerChunk]
  /// are waiting.
  final Duration flushInterval;

  final int maxEventsPerChunk;
  final int maxBufferedEvents;

  /// Where the visitor id and the session live. `shared_preferences` when
  /// left out.
  final AnyReplayStore? storage;

  /// Print what the recorder decides, prefixed `[anyreplay]`.
  final bool debug;

  static const String defaultIngestUrl = 'https://in.anyreplay.com';
}

/// Why [AnyReplay.init] refused to start. Never thrown into the app: `init`
/// reports it with `debugPrint` and records nothing.
class AnyReplayConfigError implements Exception {
  AnyReplayConfigError(this.message);
  final String message;
  @override
  String toString() => 'anyreplay: $message';
}

final RegExp _keyPattern = RegExp(r'^ar_pk_(live|test)_[0-9a-f]{24}$');

/// What ingest reads as an app id (contract §2.2).
final RegExp appIdPattern = RegExp(r'^[A-Za-z0-9][A-Za-z0-9._-]{1,254}$');

/// The options after validation, with the app's own id and version filled in.
class ResolvedOptions {
  ResolvedOptions._(this.source, this.ingestUrl, this.appId, this.appVersion);

  final AnyReplayOptions source;
  final String ingestUrl;
  final String? appId;
  final String? appVersion;

  String get projectKey => source.projectKey;
  double get sampleRate => source.sampleRate;
  bool get requireConsent => source.requireConsent;
  bool get maskAllInputs => source.maskAllInputs;
  bool get maskAllTyping => source.maskAllTyping;
  bool get maskImages => source.maskImages;
  bool get recordErrors => source.recordErrors;
  int? get maxSessionsPerMonth => source.maxSessionsPerMonth;
  Duration get snapshotInterval => source.snapshotInterval;
  Duration get flushInterval => source.flushInterval;
  int get maxEventsPerChunk => source.maxEventsPerChunk;
  int get maxBufferedEvents => source.maxBufferedEvents;
  bool get debug => source.debug;

  /// Validates [options]. [platformAppId] and [platformAppVersion] are what
  /// the app itself reports; an option given explicitly wins over either.
  static ResolvedOptions resolve(
    AnyReplayOptions options, {
    String? platformAppId,
    String? platformAppVersion,
  }) {
    if (!_keyPattern.hasMatch(options.projectKey)) {
      throw AnyReplayConfigError('projectKey looks wrong — copy it from the dashboard');
    }
    if (!(options.sampleRate >= 0 && options.sampleRate <= 1)) {
      throw AnyReplayConfigError('sampleRate must be between 0 and 1');
    }
    if (options.snapshotInterval < const Duration(milliseconds: 100)) {
      throw AnyReplayConfigError('snapshotInterval below 100 ms would compete with the app for frames');
    }
    if (options.maxEventsPerChunk < 1 || options.maxBufferedEvents < options.maxEventsPerChunk) {
      throw AnyReplayConfigError('maxBufferedEvents must hold at least one chunk');
    }
    final cap = options.maxSessionsPerMonth;
    if (cap != null && (cap < 1 || cap > 1000000)) {
      throw AnyReplayConfigError('maxSessionsPerMonth must be between 1 and 1,000,000');
    }
    final ingest = options.ingestUrl.replaceFirst(RegExp(r'/+$'), '');
    final uri = Uri.tryParse(ingest);
    if (uri == null || !(uri.isScheme('https') || uri.isScheme('http')) || uri.host.isEmpty) {
      throw AnyReplayConfigError('ingestUrl must be an http(s) address');
    }

    final explicitId = options.appId?.trim();
    if (options.appId != null && !(explicitId != null && appIdPattern.hasMatch(explicitId))) {
      throw AnyReplayConfigError('appId should be the bundle id or package name, such as com.example.app');
    }
    final readId = platformAppId?.trim();
    final appId = explicitId ?? (readId != null && appIdPattern.hasMatch(readId) ? readId : null);

    final explicitVersion = options.appVersion?.trim();
    if (options.appVersion != null &&
        !(explicitVersion != null && explicitVersion.isNotEmpty && explicitVersion.length <= 40)) {
      throw AnyReplayConfigError("appVersion should be the app's version, at most 40 characters");
    }
    final readVersion = platformAppVersion?.trim();
    final appVersion = explicitVersion ??
        (readVersion != null && readVersion.isNotEmpty
            ? (readVersion.length > 40 ? readVersion.substring(0, 40) : readVersion)
            : null);

    return ResolvedOptions._(options, ingest, appId, appVersion);
  }
}
