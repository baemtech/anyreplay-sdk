/// AnyReplay session replay for Flutter: records the screen as a tree of
/// words and boxes — never screenshots — so every replay can be read,
/// searched and translated.
library;

export 'src/anyreplay.dart' show AnyReplay;
export 'src/mask_widget.dart' show AnyReplayMask;
export 'src/navigation.dart' show AnyReplayNavigatorObserver;
export 'src/options.dart' show AnyReplayOptions, AnyReplayConfigError;
export 'src/recorder.dart' show RecorderStatus;
export 'src/session.dart' show AnyReplayStore, MemoryStore, SharedPreferencesStore;
export 'src/version.dart' show sdkName, sdkVersion;
