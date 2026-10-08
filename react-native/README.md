# @anyreplay/react-native

Session replay for React Native apps.

```bash
npm install @anyreplay/react-native
```

```tsx
import { AnyReplay, init, trackNavigation } from '@anyreplay/react-native';

init({ projectKey: 'ar_pk_live_…' });

export default function Root() {
  return (
    <AnyReplay>
      <NavigationContainer ref={(ref) => { if (ref) trackNavigation(ref); }}>
        <App />
      </NavigationContainer>
    </AnyReplay>
  );
}
```

No native module and no rebuild, so it works in Expo Go.

## What it records, and why not screenshots

Every other mobile replay tool records the screen as images — PostHog and Sentry
both do on React Native specifically, because the JavaScript side cannot reach
the native view tree without a native module.

This one records structure and words instead. A screenshot is pixels, and
pixels cannot be translated; a tool whose reason to exist is showing a session
in a language the reviewer reads cannot throw the words away on the way in.

So the recorder reads the layer JavaScript *can* reach: the elements React is
asked to create. It wraps `React.createElement` while a recording is running and
remembers, for each host element, what it is and what it says — then adds an
`onLayout` handler to learn where it ended up. React knows what is on screen;
the layout pass knows where it is; neither alone is enough.

The result is a wireframe, not a photograph. That is honest about what was
captured, and it is what makes a Turkish session watchable in English.

It is also what makes it cheap. Smartlook reports 0.5 MB per minute at two
screenshots a second, UXCam 50–500 KB. Here the first frame of a screen is a
few kilobytes and every frame after it carries only what changed — often a
handful of numbers — and an idle screen sends nothing at all.

## Privacy

A recording contains what a person types into a `TextInput`, the same as the
browser SDK, because a replay of a checkout nobody could finish is worth
watching only if you can see what they were trying to enter. Masking is a
switch you turn on:

- `maskAllInputs: true` — every `TextInput` value is replaced on the device.
- `maskAllTyping: true` — the same, and not weakened by `maskAllInputs: false`
  set elsewhere in your configuration.
- `testID` containing `ar-mask` — one view, or everything below it.
- `maskImages: true` — no image URLs at all.

Some fields are masked in every mode and no option records them:

| Masked without being asked | Read from |
|---|---|
| A secure field | `secureTextEntry` |
| A password, new password or one-time code | `textContentType`, `autoComplete`, `keyboardType: 'visible-password'` |
| A card number, security code, expiry or cardholder name | `textContentType: 'creditCard…'`, `autoComplete: 'cc-…'` |
| A field whose label, placeholder or `testID` names one of the above | `placeholder`, `accessibilityLabel`, `testID`, `nativeID` |
| A value of 13–19 digits that passes the card-number check | the value itself |
| A card number still being typed: digits only, starting 2–6, grouped like a card, more than six digits | the value itself — at most the first six digits are ever recorded |

A masked element keeps its box and loses its words: the reviewer sees that
something was typed, and where, and never what. The value is replaced on the
device — it is not sent and then hidden.

### Where a phone knows less than a browser

A browser field carries `type`,
`autocomplete` and a `name` the framework wrote, so the floor almost always has
something to read. In React Native a `<TextInput />` with no props says nothing
about itself at all, and there is no `name` attribute to fall back on. Such a
field is **recorded**, consistently with the web, and only the card-number check
on its value can catch it.

Two more differences worth knowing:

- A post code is not payment data here, and neither is an email address or a
  phone number — `textContentType: 'postalCode'`, `'emailAddress'` and
  `'telephoneNumber'` are recorded. The browser SDK treats them the same way.
- There is no `contenteditable` on a phone, so `maskAllTyping` covers exactly
  what `maskAllInputs` covers. What it adds is that it cannot be weakened.

If your screens carry anything you would not want a teammate to read, set
`maskAllInputs: true` or give the field a `textContentType`, an `autoComplete`
or a `testID` that says what it is.

## Options

| | Default | |
|---|---|---|
| `projectKey` | — | From the dashboard. Required. |
| `ingestUrl` | `https://in.anyreplay.com` | Self-hosted deployments only. |
| `sampleRate` | `1` | Decided once per visitor, so a recorded person stays recorded. |
| `snapshotIntervalMs` | `500` | The main cost lever. Slower is cheaper and coarser. |
| `maskAllInputs` | `false` | Mask every `TextInput`. The floor above applies either way. |
| `maskAllTyping` | `false` | The same, and `maskAllInputs: false` no longer weakens it. |
| `maskTestID` | `ar-mask` | Views whose `testID` contains this are masked. |
| `maskImages` | `false` | Record no image URLs at all. |
| `requireConsent` | `false` | Record nothing until `consent(true)`. |
| `storage` | in memory | Give it AsyncStorage to recognise a returning visitor. |
| `appId` | — | Your bundle id / package name. Needed once the project lists allowed domains; add it under **Allowed apps** too. |
| `appVersion` | — | Your app's version, shown with each session. React Native cannot read it without a native module. |

```ts
import AsyncStorage from '@react-native-async-storage/async-storage';
init({ projectKey: '…', storage: AsyncStorage });
```

An app sends no web origin, so a project that lists allowed domains refuses it
until the app is listed under **Allowed apps** in the project's settings and
`appId` names it. The id is a filter, not a secret — anyone with the public
key can send one — so keep relying on quotas and rate limits, not on it.

```ts
import * as Application from 'expo-application';
init({
  projectKey: '…',
  appId: Application.applicationId ?? undefined,          // com.example.shop
  appVersion: Application.nativeApplicationVersion ?? undefined,
});
```

Each session reports `platform: 'react-native'`, this package's name and
version, and on Android the device model.

## API

| | |
|---|---|
| `init(options)` | Starts recording. Safe to call twice; the second is ignored. |
| `stop()` | Stops, and detaches everything. |
| `consent(granted)` | Grants or withdraws consent. |
| `identify({ userId, email })` | Attaches an identity to the session. |
| `screen(name)` | A screen change, if you are not using `trackNavigation`. |
| `trackNavigation(ref)` | Follows a react-navigation container. |
| `flush()` | Sends what is buffered. |
| `getSessionId()` | The current session id, for correlating with your own logs. |

## Taps, delivery and sessions

- **A tap is recorded once, when the finger lifts**, and only if it moved less
  than 10 points — a scroll, a swipe or a drag is not a tap. `<AnyReplay>`
  listens to touches in the capture phase (`onTouchStartCapture` and friends);
  it never takes part in the responder system, so it cannot claim a gesture.
- **Outages are waited out, not given up on.** A failed delivery (no network,
  a 5xx, a 429) is retried after 2 s, then 4 s, 8 s … at most a minute, with
  jitter, and at least as long as `Retry-After` asks; coming back to the
  foreground tries again at once. Up to `maxBufferedEvents` are kept, and
  after an outage they leave as several chunks of at most 200 events and
  about 256 KB each. If the oldest have to be dropped, the next thing sent is
  a fresh screen size, screen name and full snapshot.
- **A refusal stops the recording for the launch**: 402, 403 and other 4xx.
  After a 402 (a quota or a session cap) the app does not try again for two
  minutes, across launches.
- **Back after 30 idle minutes is a new session**, as a relaunch would be.
- **Rotation** sends the new screen size and a whole screen.
- **iPads and Android tablets** report themselves as tablets.

## What it does not do yet

- **Lists are recorded as what is on screen.** A `FlatList` reports the rows it
  has rendered, so scrolling back through a replay shows the rows that existed
  at that moment, not the whole list.
- **No image contents.** An `Image` is a box; the picture is not uploaded.
- **Custom native components** are recorded as `Unknown` — a box in the right
  place with no text, because there is nothing readable to capture.
