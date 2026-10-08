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
traffic in a debug build); on the iOS simulator use `http://localhost:4000`.
