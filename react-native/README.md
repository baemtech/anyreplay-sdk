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

Masking is on by default and applied before anything leaves the device.

| Masked without being asked | |
|---|---|
| Every `TextInput` | Anything a person types |
| `secureTextEntry` | Whatever the component calls itself |
| `testID` containing `ar-mask` | What you marked |

A masked element keeps its box and loses its words: the reviewer sees that
something was typed, and where, and never what. The value is replaced on the
device — it is not sent and then hidden.

## Options

| | Default | |
|---|---|---|
| `projectKey` | — | From the dashboard. Required. |
| `ingestUrl` | `https://in.anyreplay.com` | Self-hosted deployments only. |
| `sampleRate` | `1` | Decided once per visitor, so a recorded person stays recorded. |
| `snapshotIntervalMs` | `500` | The main cost lever. Slower is cheaper and coarser. |
| `maskAllInputs` | `true` | Leaving this on is the supported configuration. |
| `requireConsent` | `false` | Record nothing until `consent(true)`. |
| `storage` | in memory | Give it AsyncStorage to recognise a returning visitor. |

```ts
import AsyncStorage from '@react-native-async-storage/async-storage';
init({ projectKey: '…', storage: AsyncStorage });
```

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

## What it does not do yet

- **Lists are recorded as what is on screen.** A `FlatList` reports the rows it
  has rendered, so scrolling back through a replay shows the rows that existed
  at that moment, not the whole list.
- **No image contents.** An `Image` is a box; the picture is not uploaded.
- **Custom native components** are recorded as `Unknown` — a box in the right
  place with no text, because there is nothing readable to capture.
