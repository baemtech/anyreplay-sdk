# @anyreplay/cordova

Session replay for **Cordova** apps — [anyreplay.com](https://anyreplay.com).

Your app's screens are a web page, so they are recorded as one, by
[`@anyreplay/browser`](../browser), bundled into this plugin together with the
app-shell core it shares with [`@anyreplay/capacitor`](../capacitor). The
plugin adds the app id (bundle id / package name, sent as `appId`), the app
version and device model, storage that survives the web view clearing its
own, a flush on Cordova's `pause` event, and `assets: 'inline'` so the replay
shows the app's own styles, fonts and images.

cordova-android 10+ and cordova-ios 6+.

> **Not on npm yet.** This plugin is published with the next SDK release.

## Install

```bash
cordova plugin add @anyreplay/cordova
```

## Start recording

The plugin installs a global `AnyReplay`. Call `init` once; it waits for
`deviceready` by itself.

```js
document.addEventListener('deviceready', () => {
  AnyReplay.init({
    projectKey: 'ar_pk_live_…',
    // Everything @anyreplay/browser accepts, for example:
    // maskAllInputs: true,
    // requireConsent: true,
  });
});
```

```js
AnyReplay.consent(true);                       // with requireConsent: true
AnyReplay.identify({ userId: 'u_1842' });
AnyReplay.track('checkout_started', { cart: 3 });
AnyReplay.flush();
AnyReplay.stop();
```

TypeScript: add `@anyreplay/cordova` to `compilerOptions.types` (or
`/// <reference types="@anyreplay/cordova" />`) for the global's types.

## Allowed apps

A Cordova app has no web origin a project can list — iOS sends
`app://localhost`, Android `https://localhost` — so add the app's bundle id /
package name under the project's **Allowed apps** if the project restricts
where it records from.

## Native code

Two small classes, no permissions, no network access of their own:

| | iOS (`native/ios/CDVAnyReplay.m`) | Android (`native/android/…/AnyReplay.java`) |
|---|---|---|
| App id | `bundleIdentifier` | `getPackageName()` |
| Version | `CFBundleShortVersionString` | `versionName` |
| Device | `utsname.machine` | `Build.MANUFACTURER` + `Build.MODEL` |
| Storage | `NSUserDefaults`, key `anyreplay.state` | `SharedPreferences` `anyreplay` |

Pause and resume come from Cordova's own document events.

## Limits

The same as the Capacitor plugin's: images up to 3 MB (PNG, JPEG, GIF, WebP),
fonts up to 160 KB, SVGs up to 48 KB, 1 MB of inline files per page; the
device-file bridge (`/__cdvfile_…`) is never read; unsent events are kept in
memory while offline. Unlike Capacitor's, the iOS side does not hold a
background task during the pause flush, so the very last seconds before a
suspend can be lost.

MIT © Baem Tech
