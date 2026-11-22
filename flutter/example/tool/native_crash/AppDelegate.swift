// Copy over ios/Runner/AppDelegate.swift (as `flutter create` writes it for
// Flutter 3.38 and later, with the implicit engine) for the example's
// "Native crash (debug)" screen, whose button exists in debug builds only.
// For local testing; never ship this. (No `#if DEBUG`: the Runner target of
// the template does not define DEBUG.)
import Flutter
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
    guard let registrar = engineBridge.pluginRegistry.registrar(forPlugin: "ExampleNativeCrash") else { return }
    FlutterMethodChannel(name: "anyreplay_example/crash", binaryMessenger: registrar.messenger())
      .setMethodCallHandler { call, result in
        result(nil)
        DispatchQueue.main.async {
          if call.method == "signal" {
            fatalError("Example native crash: the oven caught fire")  // SIGTRAP
          }
          NSException(name: .internalInconsistencyException, reason: "Example native crash: the oven caught fire")
            .raise()
        }
      }
  }
}
