/// The device, as the session's meta and agent string describe it
/// (docs/SDK-CONTRACT.md §2.5, §2.6).
library;

class DeviceDescription {
  const DeviceDescription({required this.os, required this.osVersion, this.model, this.tablet = false});

  /// `ios`, `android`, `macos`, `windows` or `linux`.
  final String os;
  final String osVersion;

  /// The hardware model: `iPhone15,2` (never the marketing name), `Pixel 8`.
  final String? model;

  /// An iPad, or a device whose shortest logical side is at least 600.
  final bool tablet;
}

/// Words that change ingest's reading of an agent string wherever they
/// appear; a model containing one is left out of it.
final RegExp _classifierWords =
    RegExp(r'windows|android|iphone|ipad|mobile|macintosh|mac os|linux', caseSensitive: false);
final RegExp _appleModel = RegExp(r'^(iPhone|iPad|iPod)[0-9]+,[0-9]+$');

/// `AnyReplayFlutter/<major>.<minor> (<device>[; <model>]) <Mobile|Tablet|Desktop>`,
/// exactly as `nativeUserAgent` in packages/shared/src/conformance/user-agent.ts
/// builds it, so ingest's classifier reads the right OS and device class.
String flutterUserAgent(DeviceDescription device, String sdkVersion) {
  final parts = sdkVersion.split(RegExp(r'[.-]'));
  final major = parts.isNotEmpty && parts[0].isNotEmpty ? parts[0] : '0';
  final minor = parts.length > 1 && parts[1].isNotEmpty ? parts[1] : '0';
  final version = device.osVersion.replaceAll(RegExp(r'[;()]'), '').trim();
  final rawModel = device.model;
  String? model;
  if (device.os == 'ios') {
    model = rawModel != null && _appleModel.hasMatch(rawModel) ? rawModel : null;
  } else if (rawModel != null && !_classifierWords.hasMatch(rawModel)) {
    final cleaned = rawModel.replaceAll(RegExp(r'[;()]'), '').trim();
    model = cleaned.isEmpty ? null : cleaned;
  }
  final desktop = device.os == 'macos' || device.os == 'windows' || device.os == 'linux';
  final segments = <String>[
    ...switch (device.os) {
      'ios' => [device.tablet ? 'iPad' : 'iPhone', 'iOS $version'],
      'android' => ['Android $version'],
      'macos' => ['Macintosh', 'Mac OS $version'],
      'windows' => ['Windows NT $version'],
      _ => ['Linux $version'],
    },
    if (model != null) model,
  ];
  final cls = desktop ? 'Desktop' : (device.tablet ? 'Tablet' : 'Mobile');
  return 'AnyReplayFlutter/$major.$minor (${segments.join('; ')}) $cls';
}

/// The version number out of iOS's `Version 17.4 (Build 21E213)`, or the
/// string itself when it has none.
String plainVersion(String raw) {
  final match = RegExp(r'[0-9]+(\.[0-9]+)*').firstMatch(raw);
  return match?.group(0) ?? raw;
}
