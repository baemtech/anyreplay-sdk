# anyreplay_flutter

Session replay for Flutter apps, by [AnyReplay](https://anyreplay.com).

```bash
flutter pub add anyreplay_flutter
```

```dart
import 'package:anyreplay_flutter/anyreplay_flutter.dart';
import 'package:flutter/material.dart';

void main() {
  AnyReplay.init(const AnyReplayOptions(projectKey: 'ar_pk_live_…'));
  runApp(MaterialApp(
    navigatorObservers: [AnyReplayNavigatorObserver()],
    home: const HomeScreen(),
  ));
}
```

That is the whole install. Taps, screens, errors and the app lifecycle are
picked up on their own; the app id and version are read from the app.

Android and iOS, Flutter 3.27 or later. No native code of its own: it uses
`shared_preferences`, `package_info_plus` and `device_info_plus`.

## What it records, and why not screenshots

Other mobile replay tools record the screen as images. This one records it as
a tree of boxes and words, read from Flutter itself: the element tree says
what each thing is — a `Switch` that is on, a `TextField` that holds a
password, the name of an `Icon`, the address of an `Image` — and each render
object says where it is on screen and how it is drawn.

A screenshot is pixels, and pixels cannot be translated, searched or masked
word by word. A tool whose reason to exist is showing a session in the
reviewer's own language cannot throw the words away on the way in. So there
is **no screenshot fallback**, ever: what cannot be read as words (an app's own
`CustomPainter`, a web view, a map, a video) is recorded as a labelled
placeholder box, with its `Semantics` label if it has one.

It is also cheap. The first frame of a screen is a few kilobytes and every
frame after it carries only what changed; a screen that does not change sends
nothing. The screen is read every 500 ms, between frames, never during one.

| Flutter | Recorded as |
|---|---|
| `Text`, `RichText`, `SelectableText` | Text, with size, weight, italics, alignment, colour and line count |
| `TextField`, `TextFormField`, `CupertinoTextField` | A field, its value (masked per the rules below), its hint and label |
| `ElevatedButton` & co., `IconButton`, `FloatingActionButton`, `CupertinoButton`, `InkWell`, `GestureDetector`, `ListTile` with `onTap` | A button, with its label inside, disabled when it has no handler |
| `Switch`, `Checkbox`, `Radio`, `Slider`, progress indicators, their Cupertino twins | The control, with its state |
| `DropdownButton`, `SegmentedButton`, Cupertino pickers | A picker, with its choice |
| `Icon` | The icon's name (`shopping_cart`), never its code point |
| `Image.network` / `Image.asset` | The image's address, or the bundled file uploaded once by content hash |
| `ListView`, `GridView`, `PageView`, `CustomScrollView`, `SingleChildScrollView` | A scroll view and its scroll offset |
| `Container` colours, corners, borders, linear gradients; `Card`, `Material` | Boxes |
| Dialogs, menus, bottom sheets | Layers over the screen |
| The keyboard, the status bar, the home indicator | Their frames — never their contents |
| `CustomPaint` (yours), platform views, `Texture` | An opaque box with its `Semantics` label |
| `webview_flutter`, `google_maps_flutter`, `flutter_map`, `video_player` and others | An opaque web view, map or video box — never the page, the address or the frames |

## Privacy

A recording contains what a person types into a text field, the same as the
browser and React Native SDKs, because a replay of a checkout nobody could
finish is worth watching only if you can see what they were trying to enter.
Masking is a switch you turn on:

- `maskAllInputs: true` — every field's value is replaced on the device.
- `maskAllTyping: true` — the same, and not weakened by `maskAllInputs: false`
  set elsewhere in your configuration.
- `AnyReplayMask(child: …)` — one widget, and everything inside it.
- `maskImages: true` — no image addresses or uploads at all.

```dart
AnyReplayMask(child: Text(order.deliveryAddress))
```

Some fields are masked in every mode and no option records them:

| Masked without being asked | Read from |
|---|---|
| A secure field | `obscureText: true` |
| A password, new password or one-time code | `autofillHints` (`AutofillHints.password`, `.newPassword`, `.oneTimeCode`), `keyboardType: TextInputType.visiblePassword` |
| A card number, security code, expiry or cardholder name | `autofillHints` (`AutofillHints.creditCard…`) |
| A field whose hint, label, `Semantics` label, `restorationId` or string `Key` names one of the above | `hintText`, `labelText`, `Key('cvv-input')` |
| A value of 13–19 digits that passes the card-number check, or more than six digits of one still being typed | the value itself |
| A card number written inside longer text ("my card is 4242 4242 …") — only its digits are starred | the value itself |

A masked element keeps its box and loses its words: the reviewer sees that
something was typed, and where, and never what. The value is replaced on the
device — it is not sent and then hidden. A field's hint is kept: it is the
app's copy, not the person's input.

### Where a phone knows less than a browser

A browser field carries `type`, `autocomplete` and a `name` the framework
wrote. A Flutter `TextField()` with no hints says nothing about itself, so such
a field is **recorded**, consistently with the web, and only the card-number
check on its value can catch it. A post code, an e-mail address or a phone
number is not payment data and is recorded. If your screens carry anything you
would not want a teammate to read, set `maskAllInputs: true`, give the field
`autofillHints`, or wrap it in `AnyReplayMask`.

### Error messages

Error messages and stack traces have e-mail addresses, card numbers and long
tokens replaced with `[redacted]` on the device before they are sent.

## Consent

```dart
AnyReplay.init(const AnyReplayOptions(projectKey: 'ar_pk_live_…', requireConsent: true));

// When the person answers:
AnyReplay.consent(true);   // starts recording
AnyReplay.consent(false);  // stops, and deletes everything AnyReplay stored
```

With `requireConsent: true` nothing is stored, sent or read — no visitor id, no
request, no error hook, no look at the screen — until `consent(true)`.
`track`, `trackError` and `identify` calls made before then wait in memory and
are sent when recording starts. `consent(false)` at any time stops recording
and removes every `anyreplay.*` key from the device; a later `consent(true)` is
a new visitor.

## Screens

`AnyReplayNavigatorObserver` names each screen after its route
(`RouteSettings.name`), for `Navigator` and for `go_router`:

```dart
MaterialApp(navigatorObservers: [AnyReplayNavigatorObserver()]);
GoRouter(observers: [AnyReplayNavigatorObserver()], routes: [...]);
```

A query string or fragment is cut off; name routes by what they are
(`/orders/:id`), never by who is looking (`/orders/829461`). Dialogs, sheets
and menus are layers of the screen they open over, not screens. Routes without
a name change nothing; pass `nameOf:` to name them yourself, or call
`AnyReplay.screen('Checkout')` from your own navigation code.

## Errors, events, people

```dart
AnyReplay.track('checkout_started', {'cart': 3});
AnyReplay.identify(userId: 'u_1842', email: 'ayse@example.com');

try {
  await pay();
} catch (error, stack) {
  AnyReplay.trackError(error, stack);
}
```

Uncaught errors are recorded on their own (`recordErrors: true`, the default):
AnyReplay installs `FlutterError.onError` and `PlatformDispatcher.onError`
when recording starts, always calls the handlers that were there before — your
crash reporter, Flutter's console output and red screen keep working — and
puts them back on `stop()`. Install your own handlers before or after
`AnyReplay.init`; either order works.

`identify` links the session to a person in your system. It is sent once and
never stored on the device. Calling it makes the session personal data: see
the store answers below.

Flutter has no console with levels, so nothing is read from `print` or
`debugPrint`.

## Options

| Option | Default | |
|---|---|---|
| `projectKey` | — | The public key from the dashboard. |
| `ingestUrl` | `https://in.anyreplay.com` | Only for self-hosting. |
| `appId`, `appVersion` | read from the app | Override what `package_info_plus` reports. |
| `sampleRate` | `1` | Share of people recorded, decided once per person. |
| `requireConsent` | `false` | Wait for `consent(true)`. |
| `maskAllInputs`, `maskAllTyping`, `maskImages` | `false` | See Privacy. |
| `recordErrors` | `true` | Uncaught errors. |
| `maxSessionsPerMonth` | — | Stop starting sessions after this many in a month. |
| `snapshotInterval` | 500 ms | How often the screen is read; never below 100 ms. |
| `storage` | `shared_preferences` | Where the visitor id lives; any `AnyReplayStore`. |
| `debug` | `false` | Print decisions, prefixed `[anyreplay]`. |

`AnyReplay.flush()` sends what is buffered; `AnyReplay.stop()` ends recording
for the launch. Every method is safe to call at any time, before `init` has
finished included, and none ever throws into your app.

## Sessions, taps and delivery

- A session ends after 30 minutes without activity; an app that comes back
  after that starts a new one.
- A tap is recorded when the finger lifts, where it went down, if it moved
  less than the touch slop. Scrolls and drags are not taps. Three taps within
  a second in the same spot flag the session as a rage tap.
- Going to the background (`AppLifecycleState.hidden`/`paused`) sends what is
  buffered at once, then reading and timers stop until the app returns.
- Offline, events wait in memory (at most 2000) and are retried with backoff;
  a refusal from the server (a full quota, an app not on the project's allowed
  list) stops recording for the launch.

## Store requirements

**App Store.** This package uses no required-reason API itself and ships no
`PrivacyInfo.xcprivacy`; the plugins it depends on ship their own
(`shared_preferences`: UserDefaults, `CA92.1`; `package_info_plus` and
`device_info_plus` declare theirs). In your App Store privacy answers, AnyReplay
collects — not linked to the user, not used for tracking, for analytics:
Product Interaction, Other User Content (the words on screen), Crash Data,
Other Diagnostic Data, and a Device ID (the install's visitor id). If you call
`identify`, also declare User ID and/or Email Address as linked to the user.

**Google Play.** Data safety: collected, not shared, encrypted in transit,
deletable on request — App activity (App interactions; Other user-generated
content), App info and performance (Crash logs; Diagnostics), Device or other
IDs. Personal info (User IDs, Email address) only if you call `identify`. Only
`INTERNET` is needed. Exclude the `shared_preferences` file from Auto Backup
so a restored phone is a new visitor:

```xml
<!-- res/xml/data_extraction_rules.xml -->
<data-extraction-rules>
  <cloud-backup>
    <exclude domain="sharedpref" path="FlutterSharedPreferences.xml"/>
    <exclude domain="file" path="datastore/"/>
  </cloud-backup>
</data-extraction-rules>
```

## Performance

On a screen of 300 recorded boxes, reading the tree takes about 2 ms in a debug
test run on a laptop (`test/capture_test.dart` prints it). Release-build
numbers on mid-range phones are published here before 1.0.

## Known limits

- One view: multi-window and multi-view apps are recorded from their first
  view.
- A `CustomPainter`, a chart library that paints, a game: an opaque box with
  its `Semantics` label. Wrap one in `Semantics(label: …)` to give it a name.
- Web views are opaque; their pages are not recorded (planned).
- Icons from your own icon fonts are recorded as "an icon was here".
- An `--obfuscate` build cannot recognise web views, maps, video players or
  your own painters by name; they fall back to opaque boxes, and your
  `CustomPaint` drawings are not marked as drawings.
- Images inside decorations (`DecorationImage`, `CircleAvatar.backgroundImage`)
  are recorded as their box.

## Development

```bash
flutter test
dart run tool/generate_tables.dart   # after a Flutter upgrade: icon names, framework painters
```

`flutter test` writes the contract's conformance scenario to
`build/anyreplay-conformance/`; in the AnyReplay monorepo,

```bash
pnpm --filter @anyreplay/shared conformance packages/recorder-flutter/build/anyreplay-conformance/*.ndjson
```

checks it against the SDK contract.

MIT © Baem Tech
