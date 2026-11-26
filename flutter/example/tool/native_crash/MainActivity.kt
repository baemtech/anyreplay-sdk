// Copy over android/app/src/main/kotlin/com/anyreplay/anyreplay_flutter_example/MainActivity.kt
// (adjust the package to the one `flutter create` chose) for the example's
// "Native crash (debug)" screen. Debug builds only; never ship this.
package com.anyreplay.anyreplay_flutter_example

import android.content.pm.ApplicationInfo
import android.os.Handler
import android.os.Looper
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "anyreplay_example/crash").setMethodCallHandler { call, result ->
            // BuildConfig is off by default in new Android Gradle plugins.
            val debuggable = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
            if (!debuggable) return@setMethodCallHandler result.notImplemented()
            result.success(null)
            // Thrown on the main thread after the reply, outside the channel:
            // an exception inside a method-call handler is caught by Flutter
            // and turned into a PlatformException, which is no crash.
            Handler(Looper.getMainLooper()).post {
                when (call.method) {
                    "signal" -> throw IllegalStateException("Example native crash (no signals on Android)")
                    else -> throw IllegalStateException("Example native crash: the oven caught fire")
                }
            }
        }
    }
}
