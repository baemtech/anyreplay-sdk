package com.anyreplay.cordova;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.os.Build;

import org.apache.cordova.CallbackContext;
import org.apache.cordova.CordovaPlugin;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The native half of @anyreplay/cordova on Android: what the web view cannot
 * know or keep. The recording itself happens in JavaScript.
 *
 * - getInfo: package name (sent as appId), versionName, versionCode, device model.
 * - readState / writeState: one string in a private SharedPreferences file, a
 *   copy of the recorder's anyreplay.* keys, so the visitor id and a
 *   resumable session survive the web view's storage being cleared.
 *
 * Java rather than Kotlin so it builds in any cordova-android project without
 * the Kotlin preference switched on.
 */
public class AnyReplay extends CordovaPlugin {
    private static final String PREFS_NAME = "anyreplay";
    private static final String STATE_KEY = "anyreplay.state";

    @Override
    public boolean execute(String action, JSONArray args, CallbackContext callback) throws JSONException {
        switch (action) {
            case "getInfo":
                callback.success(info());
                return true;
            case "readState": {
                String value = prefs().getString(STATE_KEY, null);
                // No message is `undefined` on the JavaScript side: nothing stored.
                if (value == null) callback.success(); else callback.success(value);
                return true;
            }
            case "writeState": {
                SharedPreferences.Editor editor = prefs().edit();
                // null removes the mirror: that is how a refusal of consent reaches it.
                if (args.isNull(0)) editor.remove(STATE_KEY); else editor.putString(STATE_KEY, args.getString(0));
                editor.apply();
                callback.success();
                return true;
            }
            default:
                return false;
        }
    }

    private SharedPreferences prefs() {
        return cordova.getActivity().getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    private JSONObject info() throws JSONException {
        Context context = cordova.getActivity().getApplicationContext();
        JSONObject info = new JSONObject();
        info.put("appId", context.getPackageName());
        info.put("deviceModel", deviceModel());
        try {
            PackageInfo pkg = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            if (pkg.versionName != null) info.put("appVersion", pkg.versionName);
            long code = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? pkg.getLongVersionCode() : legacyVersionCode(pkg);
            info.put("build", String.valueOf(code));
        } catch (PackageManager.NameNotFoundException ignored) {
            // Our own package is always there; nothing to add if it somehow is not.
        }
        return info;
    }

    @SuppressWarnings("deprecation")
    private static long legacyVersionCode(PackageInfo pkg) {
        return pkg.versionCode;
    }

    /** "Google Pixel 8"; a model that already starts with its maker's name is left as it is. */
    private static String deviceModel() {
        String manufacturer = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER;
        String model = Build.MODEL == null ? "" : Build.MODEL;
        String full = model.toLowerCase().startsWith(manufacturer.toLowerCase()) ? model : manufacturer + " " + model;
        full = full.trim();
        return full.length() > 64 ? full.substring(0, 64) : full;
    }
}
