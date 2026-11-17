package com.anyreplay.capacitor

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * The native half of `@anyreplay/capacitor`.
 *
 * The recording happens in the web view, in JavaScript. This only answers
 * what a web view cannot know or keep (docs/SDK-CONTRACT.md §9.2):
 *
 * - `getInfo`: the package name (sent as `appId`), `versionName`,
 *   `versionCode` and the device model.
 * - `readState` / `writeState`: one string in a private SharedPreferences
 *   file, a copy of the recorder's `anyreplay.*` keys, so the visitor id and a
 *   resumable session survive the web view's storage being cleared.
 * - `pause` / `resume` events from the activity's lifecycle, so the recorder
 *   flushes when the app goes to the background.
 */
@CapacitorPlugin(name = "AnyReplay")
class AnyReplayPlugin : Plugin() {

    private val prefs by lazy { context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE) }

    @PluginMethod
    fun getInfo(call: PluginCall) {
        val info = JSObject()
        info.put("appId", context.packageName)
        info.put("deviceModel", deviceModel())
        try {
            val pkg = context.packageManager.getPackageInfo(context.packageName, 0)
            pkg.versionName?.let { info.put("appVersion", it) }
            val code = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) pkg.longVersionCode else {
                @Suppress("DEPRECATION")
                pkg.versionCode.toLong()
            }
            info.put("build", code.toString())
        } catch (_: PackageManager.NameNotFoundException) {
            // Our own package is always there; nothing to add if it somehow is not.
        }
        call.resolve(info)
    }

    @PluginMethod
    fun readState(call: PluginCall) {
        val result = JSObject()
        // JSObject.put(name, null) drops the key; JSONObject.NULL keeps it as null.
        result.put("value", prefs.getString(STATE_KEY, null) ?: org.json.JSONObject.NULL)
        call.resolve(result)
    }

    @PluginMethod
    fun writeState(call: PluginCall) {
        // A missing or null value removes the mirror (a refusal of consent).
        val value = call.getString("value")
        prefs.edit().apply {
            if (value == null) remove(STATE_KEY) else putString(STATE_KEY, value)
        }.apply()
        call.resolve()
    }

    /** Nothing to end on Android: the flush runs while the activity is paused, not suspended. */
    @PluginMethod
    fun pauseHandled(call: PluginCall) {
        call.resolve()
    }

    override fun handleOnPause() {
        super.handleOnPause()
        notifyListeners("pause", JSObject())
    }

    override fun handleOnResume() {
        super.handleOnResume()
        notifyListeners("resume", JSObject())
    }

    private fun deviceModel(): String {
        val manufacturer = Build.MANUFACTURER.orEmpty()
        val model = Build.MODEL.orEmpty()
        // "Google Pixel 8", but "SM-S918B" stays as Samsung writes it after "samsung".
        val full = if (model.startsWith(manufacturer, ignoreCase = true)) model else "$manufacturer $model"
        return full.trim().take(64)
    }

    private companion object {
        const val PREFS_NAME = "anyreplay"
        const val STATE_KEY = "anyreplay.state"
    }
}
