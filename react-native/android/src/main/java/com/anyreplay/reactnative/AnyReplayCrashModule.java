package com.anyreplay.reactnative;

import androidx.annotation.NonNull;

import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;

/**
 * `AnyReplayCrash`: what @anyreplay/react-native asks the native side about
 * crashes in the app's own Kotlin or Java code (see AnyReplayCrashKeeper).
 *
 * A classic native module, so it works on the old architecture and, through
 * React Native's interop layer, on the new one. The package creates it when
 * the React instance starts — before the JavaScript bundle runs — and that is
 * when the handler is installed. A crash earlier than that (in the
 * Application's onCreate, say) is not seen.
 */
public class AnyReplayCrashModule extends ReactContextBaseJavaModule {
    public static final String NAME = "AnyReplayCrash";

    public AnyReplayCrashModule(ReactApplicationContext context) {
        super(context);
        AnyReplayCrashKeeper.install(context);
    }

    @NonNull
    @Override
    public String getName() {
        return NAME;
    }

    /** The crash the previous launch wrote down (the file's text), or null. Deleted once read. */
    @ReactMethod
    public void takeNativeCrash(Promise promise) {
        try {
            promise.resolve(AnyReplayCrashKeeper.take(getReactApplicationContext()));
        } catch (Throwable error) {
            promise.resolve(null);
        }
    }

    /** Switches the handler on again after `uninstall` (the recorder was started again). */
    @ReactMethod
    public void install() {
        AnyReplayCrashKeeper.install(getReactApplicationContext());
    }

    /** The recorder was stopped: crashes are no longer written down. */
    @ReactMethod
    public void uninstall() {
        AnyReplayCrashKeeper.uninstall();
    }
}
