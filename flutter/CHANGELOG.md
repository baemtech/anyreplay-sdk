# Changelog

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
  card-shaped values always; `maskAllInputs`, `maskAllTyping`, `maskImages`
  and `AnyReplayMask` on request.
- Consent (`requireConsent`, `consent(true/false)`), sampling, 30-minute
  sessions resumed across launches, taps at touch-up with rage-tap detection,
  `AnyReplayNavigatorObserver` for screen names, uncaught errors from
  `FlutterError.onError` and `PlatformDispatcher.onError`, `track`,
  `trackError`, `identify`.
- Delivery in chunks of at most 200 events and about 256 KB, with backoff,
  `Retry-After`, an offline buffer and a flush when the app goes to the
  background.
- Passes the AnyReplay SDK contract's conformance scenario with no errors and
  no warnings.
