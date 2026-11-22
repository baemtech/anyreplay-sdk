import Flutter
import Foundation
#if canImport(anyreplay_flutter_c)
// Swift Package Manager: the C handlers are a target of their own. Under
// CocoaPods they are in this module already.
import anyreplay_flutter_c
#endif

/// The native side of anyreplay_flutter: keeps a crash in the app's Swift or
/// Objective-C code — an uncaught exception or a fatal signal — for the next
/// launch, where the Dart side (lib/src/native_crash.dart) takes it over
/// `anyreplay_flutter/crash` and sends it.
///
/// The handlers go in when the plugin registers, at app start, so a crash
/// before `AnyReplay.init` is kept too.
public class AnyReplayFlutterPlugin: NSObject, FlutterPlugin {
  public static func register(with registrar: FlutterPluginRegistrar) {
    CrashKeeper.install()
    let channel = FlutterMethodChannel(name: "anyreplay_flutter/crash", binaryMessenger: registrar.messenger())
    registrar.addMethodCallDelegate(AnyReplayFlutterPlugin(), channel: channel)
  }

  public func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    switch call.method {
    case "takeNativeCrash":
      result(CrashKeeper.take())
    case "install":
      CrashKeeper.install()
      result(nil)
    case "uninstall":
      CrashKeeper.uninstall()
      result(nil)
    default:
      result(FlutterMethodNotImplemented)
    }
  }
}

/// Where the crash file lives, and the last launch's crash.
///
/// The C side opens `anyreplay-native-crash.json` at install time and empties
/// it (its signal handler may not open files), so the last launch's crash is
/// moved aside to `anyreplay-native-crash.prev.json` first, where `take()`
/// finds it. A file that is still empty is no crash.
enum CrashKeeper {
  static let fileName = "anyreplay-native-crash.json"
  static let keptName = "anyreplay-native-crash.prev.json"

  private static let lock = NSLock()
  private static var prepared = false

  /// Application Support/anyreplay, created when missing.
  private static var directory: URL? {
    guard let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
      return nil
    }
    let dir = base.appendingPathComponent("anyreplay", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }

  static func install() {
    lock.lock()
    defer { lock.unlock() }
    guard let dir = directory else { return }
    let current = dir.appendingPathComponent(fileName)
    if !prepared {
      prepared = true
      // The last launch's crash, if it wrote one, before this launch's file is emptied.
      if let data = try? Data(contentsOf: current), !data.isEmpty {
        let kept = dir.appendingPathComponent(keptName)
        try? FileManager.default.removeItem(at: kept)
        try? FileManager.default.moveItem(at: current, to: kept)
      }
    }
    _ = current.path.withCString { anyreplay_crash_install($0) }
  }

  static func uninstall() {
    lock.lock()
    defer { lock.unlock() }
    anyreplay_crash_uninstall()
  }

  /// The last launch's crash as the native side wrote it, deleted as it is read.
  static func take() -> String? {
    lock.lock()
    defer { lock.unlock() }
    guard let dir = directory else { return nil }
    let kept = dir.appendingPathComponent(keptName)
    guard let data = try? Data(contentsOf: kept) else { return nil }
    try? FileManager.default.removeItem(at: kept)
    guard let text = String(data: data, encoding: .utf8),
          !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
    return text
  }
}
