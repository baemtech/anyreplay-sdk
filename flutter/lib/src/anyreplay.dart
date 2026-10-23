import 'dart:async';
import 'dart:io' show Platform;

import 'package:device_info_plus/device_info_plus.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:http/http.dart' as http;
import 'package:package_info_plus/package_info_plus.dart';

import 'assets.dart';
import 'capture.dart';
import 'device.dart';
import 'diagnostics.dart';
import 'host.dart';
import 'options.dart';
import 'recorder.dart';
import 'session.dart';

/// What [AnyReplay.init] would otherwise ask the platform for. Tests pass
/// one to record a real widget tree against a fake network and clock.
@visibleForTesting
class AnyReplayEnvironment {
  const AnyReplayEnvironment({
    this.client,
    this.store,
    this.clock,
    this.device,
    this.platformAppId,
    this.platformAppVersion,
    this.locale,
    this.errorHooks,
    this.manualTimers = false,
    this.readAsset,
  });

  final http.Client? client;
  final AnyReplayStore? store;
  final int Function()? clock;
  final DeviceDescription? device;
  final String? platformAppId;
  final String? platformAppVersion;
  final String? locale;
  final ErrorHooks? errorHooks;

  /// The recorder never ticks or flushes on its own; the test does.
  final bool manualTimers;
  final Future<Uint8List> Function(String key)? readAsset;
}

/// AnyReplay session replay for Flutter.
///
/// ```dart
/// void main() {
///   AnyReplay.init(const AnyReplayOptions(projectKey: 'ar_pk_live_…'));
///   runApp(const MyApp());
/// }
/// ```
///
/// Every method is safe to call at any time — before `init` has finished
/// (the call is applied as soon as it has), after `stop`, with recording
/// sampled out — and none of them ever throws into the app.
abstract final class AnyReplay {
  static Recorder? _recorder;
  static Future<void>? _starting;
  static final List<void Function(Recorder)> _queued = [];
  static _Lifecycle? _lifecycle;
  static AssetUploader? _uploader;
  static bool _failed = false;

  /// Starts AnyReplay. Without `requireConsent` recording begins now (the
  /// screen is read from the first frame on); with it, at `consent(true)`.
  /// A second call is ignored.
  static Future<void> init(AnyReplayOptions options, {@visibleForTesting AnyReplayEnvironment? environment}) {
    final running = _starting;
    if (running != null) {
      if (options.debug) debugPrint('[anyreplay] init() called twice; the second call is ignored');
      return running;
    }
    return _starting = _init(options, environment ?? const AnyReplayEnvironment());
  }

  static Future<void> _init(AnyReplayOptions options, AnyReplayEnvironment env) async {
    try {
      WidgetsFlutterBinding.ensureInitialized();
      final platform = await _platformInfo(env, options.debug);
      final resolved = ResolvedOptions.resolve(
        options,
        platformAppId: platform.appId,
        platformAppVersion: platform.appVersion,
      );
      final store = options.storage ?? env.store ?? SharedPreferencesStore();
      final client = env.client ?? http.Client();

      AssetUploader? uploader;
      final capture = TreeCapture(CaptureSettings(
        maskAllInputs: resolved.maskAllInputs,
        maskAllTyping: resolved.maskAllTyping,
        maskImages: resolved.maskImages,
        assetHash: resolved.maskImages
            ? null
            : (key) => (uploader ??= _uploader = AssetUploader(
                  ingestUrl: resolved.ingestUrl,
                  projectKey: resolved.projectKey,
                  appId: resolved.appId,
                  client: client,
                  store: store,
                  debug: resolved.debug,
                  readBytes: env.readAsset ?? (key) async => (await rootBundle.load(key)).buffer.asUint8List(),
                ))
                    .hashFor(key),
      ));
      final host = FlutterHost(
        treeCapture: capture,
        client: client,
        device: platform.device,
        clock: env.clock,
        locale: env.locale,
        errorHooks: env.errorHooks,
        manualTimers: env.manualTimers,
      );
      final recorder = await Recorder.create(resolved, host, store, beforeStart: (recorder) {
        for (final call in List.of(_queued)) {
          _safely(() => call(recorder));
        }
        _queued.clear();
      });
      _recorder = recorder;
      final lifecycle = _Lifecycle(recorder);
      _lifecycle = lifecycle;
      WidgetsBinding.instance.addObserver(lifecycle);
      // Anything called while the recorder was starting.
      for (final call in List.of(_queued)) {
        _safely(() => call(recorder));
      }
      _queued.clear();
    } on AnyReplayConfigError catch (error) {
      _failed = true;
      _queued.clear();
      debugPrint('[anyreplay] not recording: ${error.message}');
    } catch (error) {
      _failed = true;
      _queued.clear();
      if (options.debug) debugPrint('[anyreplay] not recording: $error');
    }
  }

  static Future<({String? appId, String? appVersion, DeviceDescription device})> _platformInfo(
    AnyReplayEnvironment env,
    bool debug,
  ) async {
    String? appId = env.platformAppId;
    String? appVersion = env.platformAppVersion;
    if (appId == null || appVersion == null) {
      try {
        final info = await PackageInfo.fromPlatform();
        appId ??= info.packageName;
        appVersion ??= info.version;
      } catch (error) {
        if (debug) debugPrint('[anyreplay] could not read the app id: $error');
      }
    }
    var device = env.device;
    if (device == null) {
      try {
        device = await _readDevice();
      } catch (error) {
        if (debug) debugPrint('[anyreplay] could not read the device: $error');
      }
    }
    device ??= DeviceDescription(
      os: defaultTargetPlatform == TargetPlatform.iOS ? 'ios' : 'android',
      osVersion: plainVersion(_safe(() => Platform.operatingSystemVersion) ?? '0'),
    );
    return (appId: appId, appVersion: appVersion, device: device);
  }

  static Future<DeviceDescription> _readDevice() async {
    final plugin = DeviceInfoPlugin();
    switch (defaultTargetPlatform) {
      case TargetPlatform.iOS:
        final info = await plugin.iosInfo;
        final machine = info.utsname.machine;
        return DeviceDescription(
          os: 'ios',
          osVersion: info.systemVersion,
          // The hardware identifier, never the marketing name; a simulator says `arm64`.
          model: RegExp(r'^(iPhone|iPad|iPod)[0-9]+,[0-9]+$').hasMatch(machine) ? machine : null,
          tablet: machine.startsWith('iPad') || info.model.startsWith('iPad'),
        );
      case TargetPlatform.android:
        final info = await plugin.androidInfo;
        return DeviceDescription(os: 'android', osVersion: info.version.release, model: info.model);
      case TargetPlatform.macOS:
        final info = await plugin.macOsInfo;
        return DeviceDescription(
            os: 'macos', osVersion: '${info.majorVersion}.${info.minorVersion}', model: info.model);
      case TargetPlatform.windows:
        final info = await plugin.windowsInfo;
        return DeviceDescription(
            os: 'windows', osVersion: '${info.majorVersion}.${info.minorVersion}.${info.buildNumber}');
      case TargetPlatform.linux:
      case TargetPlatform.fuchsia:
        return DeviceDescription(os: 'linux', osVersion: plainVersion(Platform.operatingSystemVersion));
    }
  }

  static T? _safe<T>(T Function() read) {
    try {
      return read();
    } catch (_) {
      return null;
    }
  }

  static void _safely(void Function() call) {
    try {
      call();
    } catch (error) {
      assert(() {
        debugPrint('[anyreplay] $error');
        return true;
      }());
    }
  }

  /// Runs [call] now if the recorder exists, or as soon as it does.
  static void _apply(void Function(Recorder recorder) call) {
    final recorder = _recorder;
    if (recorder != null) return _safely(() => call(recorder));
    if (_failed) return;
    if (_queued.length < 64) _queued.add(call);
  }

  /// The person's answer, with `requireConsent: true`. `true` starts
  /// recording; `false` — at any time — stops it and deletes everything
  /// AnyReplay stored on the device. A later `true` starts again.
  static void consent(bool granted) => _apply((r) => r.consent(granted));

  /// Links this session to someone in your own system. Sent once, never
  /// stored on the device.
  static void identify({String? userId, String? email}) =>
      _apply((r) => r.identify(IdentifyTraits(userId: userId, email: email)));

  /// Tags this moment: 1–64 characters of `[A-Za-z0-9_.:-]`, and properties
  /// of at most 4 KB as JSON.
  static void track(String name, [Map<String, Object?>? properties]) {
    // Copied now: a later change to the app's map must not change what was tracked.
    final copy = properties == null ? null : Map<String, Object?>.of(properties);
    _apply((r) => r.track(name, copy));
  }

  /// Records an error the app caught itself.
  static void trackError(Object error, [StackTrace? stack]) => _apply((r) => r.trackError(error, stack));

  /// Names the screen now shown. [AnyReplayNavigatorObserver] calls it for you.
  static void screen(String name) => _apply((r) => r.screen(name));

  /// Sends what is buffered now.
  static Future<void> flush() async {
    final recorder = _recorder;
    if (recorder == null) return;
    try {
      await recorder.flush(force: true);
    } catch (_) {/* never surfaces */}
  }

  /// Stops recording for the rest of this launch.
  static void stop() => _apply((r) => r.stop());

  /// `idle`, `awaitingConsent`, `recording`, `sampledOut` or `stopped`.
  static RecorderStatus get status => _recorder?.status ?? RecorderStatus.idle;

  /// The current session's id, while recording.
  static String? get sessionId => _recorder?.status == RecorderStatus.recording ? _recorder?.sessionId : null;

  @visibleForTesting
  static Recorder? get recorder => _recorder;

  /// Forgets the recorder entirely, so a test can start another.
  @visibleForTesting
  static void reset() {
    _recorder?.stop();
    final lifecycle = _lifecycle;
    if (lifecycle != null) WidgetsBinding.instance.removeObserver(lifecycle);
    _uploader?.close();
    _uploader = null;
    _lifecycle = null;
    _recorder = null;
    _starting = null;
    _failed = false;
    _queued.clear();
  }
}

/// Flushes when the app leaves the foreground, and resumes when it returns
/// (contract §5.7). `inactive` — the app switcher, a call, the notification
/// shade — is a moment, not a departure, and changes nothing.
class _Lifecycle with WidgetsBindingObserver {
  _Lifecycle(this.recorder);
  final Recorder recorder;

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    switch (state) {
      case AppLifecycleState.hidden:
      case AppLifecycleState.paused:
      case AppLifecycleState.detached:
        unawaited(recorder.background().catchError((Object _) {}));
      case AppLifecycleState.resumed:
        recorder.foreground();
      case AppLifecycleState.inactive:
        break;
    }
  }
}
