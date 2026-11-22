# anyreplay_flutter example

A small shop that shows what `anyreplay_flutter` records: a list, a coupon
field (recorded), a password and a card field (masked), a masked address, a
consent prompt, a dialog and a second screen.

Only `lib/` is kept in the repository. To run it, create the platform folders
once, then run with a test key from the dashboard:

```bash
cd example
flutter create --platforms=ios,android --org com.anyreplay .
flutter run --dart-define=ANYREPLAY_KEY=ar_pk_test_…
```

Against a local ingest on the Android emulator, add
`--dart-define=ANYREPLAY_INGEST=http://10.0.2.2:4000` (and allow cleartext
traffic in a debug build); on the iOS simulator use `http://localhost:4000`;
on an Android phone over USB, `adb reverse tcp:4000 tcp:4000` and
`http://localhost:4000`.

`lib/device_test.dart` is the device-test app; `tool/ios_drive` drives it on
the iOS simulator and `tool/android_drive.sh` on an Android phone, both with
real taps and keystrokes.

**Native crashes.** In a debug build the cart has a "Native crash (debug)"
button: its screen ends the app with a Kotlin exception (Android), an
`NSException` or a Swift `fatalError` (iOS). The channel behind it lives in
the generated platform folders, so copy `tool/native_crash/MainActivity.kt`
over `android/app/src/main/kotlin/…/MainActivity.kt` (fix the package line)
and `tool/native_crash/AppDelegate.swift` over `ios/Runner/AppDelegate.swift`.
Crash, open the app again, and the crash arrives in the recording it ended
as an `anyreplay.error` with `kind: "fatal"` and `native: true`. (Run it
without the debugger attached on iOS: the debugger stops on the signal
first.)
