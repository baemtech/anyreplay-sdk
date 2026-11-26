package com.anyreplay.reactnative;

import androidx.annotation.NonNull;

import com.facebook.react.ReactPackage;
import com.facebook.react.bridge.NativeModule;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.uimanager.ViewManager;

import java.util.Collections;
import java.util.List;

/**
 * Linked by autolinking. A plain ReactPackage on purpose: its modules are
 * created when the React instance is, on both architectures, so the crash
 * handler is in place before the JavaScript bundle starts to run.
 */
public class AnyReplayPackage implements ReactPackage {
    @NonNull
    @Override
    public List<NativeModule> createNativeModules(@NonNull ReactApplicationContext context) {
        return Collections.<NativeModule>singletonList(new AnyReplayCrashModule(context));
    }

    @NonNull
    @Override
    @SuppressWarnings({"rawtypes", "unchecked"})
    public List<ViewManager> createViewManagers(@NonNull ReactApplicationContext context) {
        return Collections.emptyList();
    }
}
