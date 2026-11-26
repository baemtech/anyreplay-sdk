package com.anyreplay.flutter

import android.content.Context
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel

/**
 * The native side of anyreplay_flutter: keeps a crash in the app's Kotlin or
 * Java code for the next launch (see [CrashKeeper] and lib/src/native_crash.dart).
 *
 * The handler goes in when the plugin attaches to the engine — at app start —
 * so a crash before `AnyReplay.init` is kept too. The Dart side takes it over
 * `anyreplay_flutter/crash`.
 */
class AnyReplayFlutterPlugin : FlutterPlugin, MethodChannel.MethodCallHandler {
    private var channel: MethodChannel? = null
    private var context: Context? = null

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        val app = binding.applicationContext
        context = app
        CrashKeeper.install(app)
        channel = MethodChannel(binding.binaryMessenger, CHANNEL).also { it.setMethodCallHandler(this) }
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        channel?.setMethodCallHandler(null)
        channel = null
        context = null
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        val app = context
        when (call.method) {
            "takeNativeCrash" -> result.success(if (app == null) null else CrashKeeper.take(app))
            "install" -> {
                if (app != null) CrashKeeper.install(app)
                result.success(null)
            }
            "uninstall" -> {
                CrashKeeper.uninstall()
                result.success(null)
            }
            else -> result.notImplemented()
        }
    }

    private companion object {
        const val CHANNEL = "anyreplay_flutter/crash"
    }
}
