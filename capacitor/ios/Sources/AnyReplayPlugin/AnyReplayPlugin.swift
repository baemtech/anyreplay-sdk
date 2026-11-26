import Capacitor
import Foundation
import UIKit
#if canImport(AnyReplayCrashKeeper)
// Swift Package Manager: the crash keeper is a C target of its own. With
// CocoaPods it is part of this module and needs no import.
import AnyReplayCrashKeeper
#endif

/// The native half of `@anyreplay/capacitor`.
///
/// The recording happens in the web view, in JavaScript. This only answers
/// what a web view cannot know or keep (docs/SDK-CONTRACT.md §9.2):
///
/// - `getInfo`: the bundle id (sent as `appId`), the user-visible version,
///   the build number and the hardware model.
/// - `readState` / `writeState`: one string in `UserDefaults`, a copy of the
///   recorder's `anyreplay.*` keys. WKWebView may purge `localStorage` under
///   storage pressure; the visitor id must not go with it.
/// - `pause` / `resume` events, and a background task around the pause so the
///   last chunk can leave before iOS suspends the app. The JavaScript side
///   calls `pauseHandled` when it is done; the task ends then, or after ten
///   seconds, whichever comes first.
/// - Native crashes (contract §8.3): `AnyReplayCrashKeeper` writes down an
///   uncaught NSException or a fatal signal (installed when the binary loads,
///   and again here); `takeNativeCrash` hands it to the next launch. With
///   crash clips, `writeClipRing` / `takeClipRing` keep the clip's ring in a
///   file for that launch (§8.6).
@objc(AnyReplayPlugin)
public class AnyReplayPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AnyReplayPlugin"
    public let jsName = "AnyReplay"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getInfo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pauseHandled", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "takeNativeCrash", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "takeClipRing", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeClipRing", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopCrashKeeper", returnType: CAPPluginReturnPromise)
    ]

    /// The `UserDefaults` key the mirror lives under.
    static let stateKey = "anyreplay.state"
    /// The longest the app is kept awake for the pause flush.
    static let pauseBudget: TimeInterval = 10

    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid

    override public func load() {
        AnyReplayCrashKeeperInstall()
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(didEnterBackground),
                           name: UIApplication.didEnterBackgroundNotification, object: nil)
        center.addObserver(self, selector: #selector(willEnterForeground),
                           name: UIApplication.willEnterForegroundNotification, object: nil)
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    @objc func getInfo(_ call: CAPPluginCall) {
        let bundle = Bundle.main
        var info: [String: Any] = ["deviceModel": AnyReplayPlugin.hardwareModel()]
        if let appId = bundle.bundleIdentifier { info["appId"] = appId }
        if let version = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String {
            info["appVersion"] = version
        }
        if let build = bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String { info["build"] = build }
        call.resolve(info)
    }

    @objc func readState(_ call: CAPPluginCall) {
        if let value = UserDefaults.standard.string(forKey: AnyReplayPlugin.stateKey) {
            call.resolve(["value": value])
        } else {
            call.resolve(["value": NSNull()])
        }
    }

    @objc func writeState(_ call: CAPPluginCall) {
        // A missing or null value removes the mirror (a refusal of consent).
        if let value = call.getString("value") {
            UserDefaults.standard.set(value, forKey: AnyReplayPlugin.stateKey)
        } else {
            UserDefaults.standard.removeObject(forKey: AnyReplayPlugin.stateKey)
        }
        call.resolve()
    }

    @objc func pauseHandled(_ call: CAPPluginCall) {
        DispatchQueue.main.async { self.endBackgroundTask() }
        call.resolve()
    }

    /// The crash the previous launch wrote down (the file's text), or null. Deleted once read.
    @objc func takeNativeCrash(_ call: CAPPluginCall) {
        if let value = AnyReplayCrashKeeperTake() {
            call.resolve(["value": value])
        } else {
            call.resolve(["value": NSNull()])
        }
    }

    /// The crash clip ring the previous launch kept, or null. Deleted once read.
    @objc func takeClipRing(_ call: CAPPluginCall) {
        if let value = AnyReplayCrashKeeperTakeRing() {
            call.resolve(["value": value])
        } else {
            call.resolve(["value": NSNull()])
        }
    }

    /// Replaces the kept ring; a missing or null value removes it.
    @objc func writeClipRing(_ call: CAPPluginCall) {
        AnyReplayCrashKeeperWriteRing(call.getString("value"))
        call.resolve()
    }

    /// The recorder was stopped: crashes are no longer written down.
    @objc func stopCrashKeeper(_ call: CAPPluginCall) {
        AnyReplayCrashKeeperUninstall()
        call.resolve()
    }

    @objc private func didEnterBackground() {
        DispatchQueue.main.async {
            self.endBackgroundTask()
            self.backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "AnyReplayFlush") { [weak self] in
                self?.endBackgroundTask()
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + AnyReplayPlugin.pauseBudget) { [weak self] in
                self?.endBackgroundTask()
            }
            self.notifyListeners("pause", data: [:])
        }
    }

    @objc private func willEnterForeground() {
        notifyListeners("resume", data: [:])
    }

    /// Main thread only.
    private func endBackgroundTask() {
        guard backgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTask)
        backgroundTask = .invalid
    }

    /// `iPhone15,2`, not "iPhone": the marketing name is not on the device, and
    /// the identifier is what tells two iPhones apart. A simulator reports the
    /// model it simulates.
    static func hardwareModel() -> String {
        #if targetEnvironment(simulator)
        if let simulated = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] { return simulated }
        #endif
        var system = utsname()
        uname(&system)
        let machine = withUnsafeBytes(of: &system.machine) { buffer in
            String(decoding: buffer.prefix(while: { $0 != 0 }), as: UTF8.self)
        }
        return machine.isEmpty ? UIDevice.current.model : machine
    }
}
