# @anyreplay/browser

Session replay recorder for the browser, made by [AnyReplay](https://anyreplay.com):
watch any user's session, translated into your own language.

- DOM-based recording (built on rrweb), not video — about 26 KB gzipped
- Every input masked by default; opt elements out with `ar-mask` / `ar-block`
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
  // maskAllInputs: true,          // default; turn off deliberately
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

Inputs are masked before they leave the page; `password` fields are never
recorded at all. Add `class="ar-block"` to remove an element's contents from the
recording entirely, or `class="ar-mask"` to keep layout but hide text.

## License

MIT © Baem Tech. Source: [github.com/baemtech/anyreplay-sdk](https://github.com/baemtech/anyreplay-sdk).
