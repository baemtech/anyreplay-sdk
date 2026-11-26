# Changelog

## 0.4.0

- **Crashes.** An error that reaches `PlatformDispatcher.onError`, or one
  you pass to `AnyReplay.trackError(error, stack, true)`, is sent as a fatal
  error and listed under **Crashes** in the dashboard and the app, with the
  moment it happened in the recording.
- **Native crashes.** The package is now a Flutter plugin with Android and
  iOS code. An uncaught Java/Kotlin exception on Android, and an uncaught
  NSException or a fatal signal (SIGABRT, SIGSEGV, SIGBUS, SIGILL, SIGFPE,
  SIGTRAP) on iOS, is written to a file as the app dies and sent on the next
  launch into the recording it ended. Native C/C++ crashes on Android are not
  captured yet.
- **Crash clips.** When the project's crash clip switch is on, a visitor who
  is not being recorded (sampled out) still gets the last ~30 seconds kept in
  memory; nothing leaves the device unless the app crashes, and then the
  clip is sent as its own short recording. Consent is required as for any
  recording. Clips do not count against the monthly session quota.

## 0.3.0

- **Heatmaps of app screens.** Scroll views now say how far their content
  goes (`cw`, `ch`), so the dashboard can show how far down a list people
  got; an endless list sends nothing. A widget's `ValueKey<String>` is sent
  as the test id (`tid`) of the element recorded at or below it, so taps on
  that element are grouped under its name. A key that carries a record's id
  (`ValueKey('order-829461')`) is left out.

## 0.2.0

- **Breaking: what people type is masked by default.** `maskAllInputs` now
  defaults to `true`, as in every AnyReplay SDK: a text field's value is
  recorded as asterisks. Set `maskAllInputs: false` in `AnyReplay.init` to
  keep recording typed values. Secure, credential, one-time-code and payment
  fields and card numbers stay masked either way.
- Children that change order, or a child inserted between its siblings, are
  now sent in their new order. 0.1.0 kept a moved child where it first
  stood, so a replay could show a list in its old order.
- An open dropdown menu is drawn on its own surface, above the page.

## 0.1.0

The first release.

- Records a Flutter app as a tree of boxes and words — the recording format
  the React Native SDK sends — read from the element and render trees every
  500 ms, between frames. No screenshots.
- Text with its style; fields with their value, hint and label; buttons,
  switches, checkboxes, radios, sliders, progress, pickers; icons by name;
  network images by address and bundled images by content hash; scroll views
  with their offset; dialogs, menus and sheets as layers; the keyboard and the
  system bars as frames; web views, maps, videos and custom painting as opaque
  boxes.
- Masking: secure, credential, one-time-code and payment fields and
  card numbers — whole, still being typed, or written inside longer text —
  always; `maskAllInputs`, `maskAllTyping`, `maskImages`
  and `AnyReplayMask` on request.
- Consent (`requireConsent`, `consent(true/false)`), sampling, 30-minute
  sessions resumed across launches, taps at touch-up with rage-tap detection,
  `AnyReplayNavigatorObserver` for screen names, uncaught errors from
  `FlutterError.onError` and `PlatformDispatcher.onError`, `track`,
  `trackError`, `identify`.
- `identify` follows the SDK contract §8.2 as the web and React Native SDKs
  do from 0.2.3: called before the session's first chunk has been accepted
  (right after `init`, the usual place), it waits for that chunk and is sent
  once, two calls while waiting going as one request; after that it goes at
  once. An `applied: false` answer after the first chunk is tried once more
  after the next one, unless newer traits came meanwhile. A new session —
  after 30 idle minutes, in the background or the foreground, or resumed at
  launch — waits for its own first chunk, and is linked again to the latest
  traits.
- Delivery in chunks of at most 200 events and about 256 KB, with backoff,
  `Retry-After`, an offline buffer and a flush when the app goes to the
  background.
- Passes the AnyReplay SDK contract's conformance scenario with no errors and
  no warnings.
