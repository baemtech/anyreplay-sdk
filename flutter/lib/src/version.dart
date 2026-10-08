/// Which SDK recorded a session, as it tells ingest on the session's first
/// chunk (docs/SDK-CONTRACT.md §2.4).
///
/// Dart has no build step that could write the package's version in, so the
/// version lives here and `test/version_test.dart` fails the moment it and
/// `pubspec.yaml` disagree; the publish workflow checks the tag against both.
library;

/// The name the SDK is installed by, in pub.dev's spelling.
const String sdkName = 'anyreplay_flutter';

/// This package's version. Kept equal to `version:` in pubspec.yaml by a test.
const String sdkVersion = '0.1.0';

/// What this SDK records on: the framework the app is built with, not the
/// operating system (a Flutter app on Android is `flutter`).
const String sdkPlatform = 'flutter';
