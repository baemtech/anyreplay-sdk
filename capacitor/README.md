# @anyreplay/capacitor

Session replay for **Capacitor and Ionic** apps — [anyreplay.com](https://anyreplay.com).

Your app's screens are a web page, so they are recorded as one, by
[`@anyreplay/browser`](../browser): the same masking, the same transport, every
option. This plugin adds what only the native side knows or keeps:

- **The app id** — the bundle id (iOS) or package name (Android) — sent as
  `appId`, so a project that lists allowed apps admits the app. Pass `appId`
  yourself to override it.
- **The app version and device model** on every session.
- **Storage that survives**: the visitor id and the session are mirrored into
  `UserDefaults` / `SharedPreferences`, so WKWebView clearing its storage does
  not turn a returning user into a new one, and a relaunch within 30 minutes
  continues the same session.
- **A flush when the app goes to the background** (on iOS inside a short
  background task), and a retry when it comes back.
- **The app's own styles, fonts and images in the replay** (`assets: 'inline'`
  by default): images the app ships are uploaded once per project by content
  hash, fonts and SVGs travel inside the recording. Without this, a replay of
  `capacitor://localhost` is unstyled HTML.

Capacitor 7 and 8, iOS 14+ and Android 6+ (API 23).

> **Preview.** This package is on npm, but the AnyReplay setup page does not offer
> it until it has been tested on devices. Copy your project key from
> the setup page and follow the steps below.

## Install

```bash
npm install @anyreplay/capacitor
npx cap sync
```

Capacitor 8 links the iOS part with Swift Package Manager; Capacitor 7 projects
on CocoaPods use `AnyreplayCapacitor.podspec`. Nothing to add to
`capacitor.config.ts`.

## Start recording

Once, as early as possible — `main.ts`, or your root component's module:

```ts
import { AnyReplay } from '@anyreplay/capacitor';

AnyReplay.init({
  projectKey: 'ar_pk_live_…',
  // Optional: everything @anyreplay/browser accepts.
  // maskAllInputs: true,
  // requireConsent: true,
});
```

`init` returns a promise (it asks the native side for the app id first), and
everything else may be called before it has finished:

```ts
AnyReplay.consent(true);                       // with requireConsent: true
AnyReplay.identify({ userId: 'u_1842' });
AnyReplay.track('checkout_started', { cart: 3 });
await AnyReplay.flush();
AnyReplay.stop();
```

### Example: an Ionic Angular app

```ts
// src/main.ts
import { bootstrapApplication } from '@angular/platform-browser';
import { AnyReplay } from '@anyreplay/capacitor';
import { AppComponent } from './app/app.component';
import { appConfig } from './app/app.config';

void AnyReplay.init({ projectKey: environment.anyreplayKey });

bootstrapApplication(AppComponent, appConfig);
```

The same line works in an Ionic React or Vue app's `main.tsx` / `main.ts`.
During development in a desktop browser (`ionic serve`) the recorder still
runs, without the native extras.

## Allowed apps

A Capacitor app has no web origin a project can list — iOS sends
`capacitor://localhost`, Android `https://localhost` — so add the app's bundle
id / package name under the project's **Allowed apps** if the project restricts
where it records from.

## What the native side does

| | iOS (`ios/Sources/AnyReplayPlugin`) | Android (`android/src/main/java/com/anyreplay/capacitor`) |
|---|---|---|
| App id | `Bundle.main.bundleIdentifier` | `context.packageName` |
| Version | `CFBundleShortVersionString` | `versionName` |
| Device | `utsname.machine` (`iPhone15,2`) | `Build.MANUFACTURER` + `Build.MODEL` |
| Storage | `UserDefaults`, key `anyreplay.state` | `SharedPreferences` `anyreplay` |
| Background | `didEnterBackground` + a ≤ 10 s background task | `handleOnPause` |

No permissions, no network access of its own, no third-party dependencies.

## Limits

- Images are uploaded only if they are PNG, JPEG, GIF or WebP, at most 3 MB.
  Fonts are carried up to 160 KB each, SVGs up to 48 KB, at most 1 MB per page.
  Files over those limits are missing from the replay; nothing else changes.
- Files the app shows from the device (`Capacitor.convertFileSrc`, the user's
  photos) are never read.
- Unsent events are kept in memory while offline, as in the browser SDK; if
  the app is killed while offline they are lost.

MIT © Baem Tech
