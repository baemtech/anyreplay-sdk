# @anyreplay/browser

Session replay recorder for the browser, made by [AnyReplay](https://anyreplay.com):
watch any user's session, translated into your own language.

- DOM-based recording (built on rrweb), not video — about 28 KB gzipped
- Records what people type; one line masks it, and passwords and payment fields never are
- Tag moments with `track()` and see them on the player's timeline
- Sessions survive reloads and route changes; chunked, retried, and flushed with `sendBeacon` on page close
- Deterministic sampling per visitor, a circuit breaker, and an optional consent gate

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
});

recorder.track('checkout_clicked', { plan: 'growth' });
recorder.identify({ userId: 'u_42', email: 'ada@example.com' });
```

Prefer a script tag? Create a project in the dashboard and copy the snippet
from its setup page; it loads the same code from `cdn.anyreplay.com`.

## API

| Call | What it does |
|---|---|
| `createRecorder(options)` | Starts recording (or waits for consent) and returns a handle |
| `handle.track(name, properties?)` | Tags this moment; `name` is 1–64 chars of `[A-Za-z0-9_.:-]`, properties a JSON object ≤ 4 KB |
| `handle.identify({ userId?, email? })` | Attaches your user id to the session |
| `handle.consent(true)` | Starts recording when `requireConsent: true`; `consent(false)` keeps it off |
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
passes the card-number check. Masking always happens in the page, before
anything is sent.

`type="email"` and `type="tel"` are not on that list. An address and a phone
number are ordinary contact details, so they are recorded like any other field
and masked by `maskAllInputs`, `maskAllTyping` or `class="ar-mask"`.

## License

MIT © Baem Tech. Source: [github.com/baemtech/anyreplay-sdk](https://github.com/baemtech/anyreplay-sdk).
