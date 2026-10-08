# @anyreplay/browser

Session replay recorder for the browser, made by [AnyReplay](https://anyreplay.com):
watch any user's session, translated into your own language.

- DOM-based recording (built on rrweb), not video — about 35 KB gzipped
- Records what people type; one line masks it, and passwords and payment fields never are
- Tag moments with `track()` and see them on the player's timeline
- Sessions survive reloads and route changes; chunked, retried, and flushed with `sendBeacon` on page close
- Deterministic sampling per visitor, retries that wait out an outage instead of giving up, and an optional consent gate

## Install

```bash
npm install @anyreplay/browser
```

```ts
import { createRecorder } from '@anyreplay/browser';

const recorder = createRecorder({
  projectKey: 'ar_pk_live_…',      // from your AnyReplay project
  // ingestUrl: 'https://in.anyreplay.com',  // default; set for self-hosted
  // sampleRate: 1,                // 0..1, decided per visitor
  // maskAllInputs: true,          // off by default: field values are recorded
  // maskAllTyping: true,          // the stricter switch: fields and rich-text editors
  // maxSessionsPerMonth: 5000,    // optional cap for this project
  // appId: 'com.example.shop',    // only inside an app shell; see below
});

recorder.track('checkout_clicked', { plan: 'growth' });
recorder.identify({ userId: 'u_42', email: 'ada@example.com' });
```

### Inside an app

A page running inside a Capacitor, Cordova, Electron or Tauri app has no real
web origin — its web view reports `capacitor://localhost`, `https://localhost`
or `file://` — so a project that lists allowed domains refuses it. Add the app's
bundle id or package name under **Allowed apps** in the project's settings,
and pass the same value as `appId`. Leave `appId` out on a website: from a
real web origin it is ignored, so it cannot open a web project's domain list.
It is a filter, not a secret. The `@anyreplay/capacitor`, `@anyreplay/cordova`,
`@anyreplay/electron` and `@anyreplay/tauri` packages (a preview) wrap this SDK
and read the app id for you.

Every session also reports `platform: 'web'` and this package's name and
version, so the dashboard can say what recorded it.

Prefer a script tag? Create a project in the dashboard and copy the snippet
from its setup page; it loads the same code from `cdn.anyreplay.com`.

## API

| Call | What it does |
|---|---|
| `createRecorder(options)` | Starts recording (or waits for consent) and returns a handle |
| `handle.track(name, properties?)` | Tags this moment; `name` is 1–64 chars of `[A-Za-z0-9_.:-]`, properties a JSON object ≤ 4 KB |
| `handle.trackError(error)` | Records an error you caught yourself, redacted, and marks the session as having one |
| `handle.identify({ userId?, email? })` | Attaches your user id to the session; held until the session's first chunk is accepted, then sent once |
| `handle.consent(true)` | Starts recording when `requireConsent: true`; `consent(false)` removes what was stored and stops (before recording started, a later `consent(true)` still starts it) |
| `handle.status()` | `idle`, `awaiting-consent`, `recording`, `sampled-out` or `stopped` |
| `handle.flush()` | Sends what is buffered now; resolves when delivered |
| `handle.stop()` | Stops for this page |
| `handle.sessionId()` | The current session id, for your own logs |

## Privacy

A recording contains what visitors type into forms, because a replay of a form
nobody could finish is worth watching only if you can see what they were trying
to enter. Masking is a switch you turn on:

- `maskAllInputs: true` — every form field value becomes asterisks of the same length.
- `maskAllTyping: true` — the same, plus the text of every `contenteditable` editor.
- `class="ar-mask"` — one element, or one field, masked while the rest records.
- `class="ar-block"` — the element's contents are not recorded at all.

Some fields are masked in every mode and no option records them: passwords and
one-time codes; card numbers, security codes, expiry dates and cardholder names
(from `autocomplete="cc-…"` or from a name, label or placeholder that reads like
one); IBANs, routing numbers and sort codes; any value of 13–19 digits that
passes the card-number check — and, because a number is typed one key at a
time, any value that could still become one: digits only, starting 2–6,
grouped like a card, more than six digits long. A card number written inside
longer text ("my card is 4242 4242 …" in a note) has its digits starred and the
rest of the text kept. At most the first six digits of a card number are ever
recorded. Masking always happens in the page, before
anything is sent.

`type="email"` and `type="tel"` are not on that list. An address and a phone
number are ordinary contact details, so they are recorded like any other field
and masked by `maskAllInputs`, `maskAllTyping` or `class="ar-mask"`.

## License

MIT © Baem Tech. Source: [github.com/baemtech/anyreplay-sdk](https://github.com/baemtech/anyreplay-sdk).
