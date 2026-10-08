# @anyreplay/tauri

Session replay for Tauri v2 apps. The window is recorded with
[`@anyreplay/browser`](../browser) — the same masking, transport and rrweb
setup as on the web — and reported as a Tauri session with your app's
identifier and version. JavaScript only: no Rust plugin.

```bash
npm install @anyreplay/tauri @tauri-apps/api
```

```ts
// your frontend's entry point
import { init } from '@anyreplay/tauri';
const replay = init({ projectKey: 'ar_pk_live_…' });
replay.track('note_opened');
```

`init` takes every option of `@anyreplay/browser`, plus:

| Option | Default | |
|---|---|---|
| `appId` | `identifier` from `tauri.conf.json` | Read with `getIdentifier()` (Tauri 2.4+). |
| `appVersion` | `getVersion()` | |
| `flushOnBlur` | `true` | Send what was recorded when the window loses focus. |
| `flushOnClose` | `false` | Send it before the window closes. Needs `core:window:allow-destroy`. |

It returns at once; recording starts when the app info arrives, and calls made
before that are queued.

## Capabilities

`core:default` covers what the SDK reads (`core:app:default` for the
identifier, name and version; `core:event:default` for the focus event). With
`flushOnClose: true`, add `core:window:allow-destroy` to the window's
capability: listening for the close request means the window is closed from
JavaScript afterwards, and without that permission it would not close.

## Content Security Policy

Tauri injects a CSP when `app.security.csp` is set. Allow the ingest host:

```json
{
  "app": {
    "security": {
      "csp": "default-src 'self'; connect-src 'self' ipc: http://ipc.localhost https://in.anyreplay.com"
    }
  }
}
```

## Windows and sessions

Each window is its own session. The visitor id lives in `localStorage`, which
Tauri keeps across launches. The page is served from `tauri://localhost`
(macOS, Linux) or `http://tauri.localhost` (Windows); neither is a website, so
a project that lists allowed apps admits it by its identifier.

MIT © Baem Tech
