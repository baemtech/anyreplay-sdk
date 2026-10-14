# @anyreplay/electron

Session replay for Electron apps. Each window is recorded with
[`@anyreplay/browser`](../browser) — the same masking, transport and rrweb
setup as on the web — and reported as an Electron session with your app's id
and version.

> **Preview.** This package is on npm, but the AnyReplay setup page does not
> offer it until it has been tested on devices. Copy your project key from
> the setup page and follow the steps below.

```bash
npm install @anyreplay/electron
```

Three lines, one per Electron context.

```ts
// main.ts — the main process
import { setupAnyReplay } from '@anyreplay/electron/main';
setupAnyReplay({ appId: 'com.example.notes' });
```

```ts
// preload.ts — bundled with your preload script
import { exposeAnyReplay } from '@anyreplay/electron/preload';
exposeAnyReplay();
```

```ts
// renderer — as early as you can in each window
import { init } from '@anyreplay/electron';
const replay = init({ projectKey: 'ar_pk_live_…' });
replay.track('note_opened');
```

## What each piece does

- **`setupAnyReplay(options)`** (main) answers the windows' request for the app
  id and `app.getVersion()`; holds quitting back until every window has sent
  what it recorded (`quitFlushTimeoutMs`, default 1500, `0` turns it off); and
  forwards uncaught main-process exceptions into the focused window's session
  as an error, recorded exactly as one the window caught itself would be
  (`forwardMainErrors`, default on). It
  observes them with `uncaughtExceptionMonitor`, so how your app handles them
  does not change. Returns `{ dispose }`.
- **`exposeAnyReplay()`** (preload) puts `window.anyreplayElectron` on the page
  through `contextBridge`: the app info, a flush the main process can ask for,
  and the main-process errors. Nothing else — no generic IPC. Works with
  `contextIsolation: true`, `sandbox: true` and no `nodeIntegration`
  (Electron's defaults). A sandboxed preload cannot load `node_modules` at run
  time, so bundle it.
- **`init(options)`** (renderer) takes every option of `@anyreplay/browser`,
  plus `appId` and `appVersion` (normally left to the main process) and
  `flushOnBlur` (default on). It returns at once; recording starts when the
  app info arrives, and calls made before that are queued.

## The app id

Electron has no API for your bundle id, so pass it to `setupAnyReplay` — the
`appId` from electron-builder, or Forge's `appBundleId`. Without it the id is
made from `app.getName()` (`"Acme Notes"` → `acme-notes`). A packaged window
loads from `file://` and has no web origin, so a project that lists allowed
apps admits it by this id.

## Windows and sessions

Each `BrowserWindow` is its own session: the session id lives in the window's
`sessionStorage`. The visitor id lives in `localStorage`, which Electron keeps
across launches and shares between the windows of one session partition, so
one person is one visitor however many windows they open.

## Content Security Policy

If your app sets a CSP, allow the ingest host in `connect-src`:

```
connect-src 'self' https://in.anyreplay.com
```

(or your self-hosted ingest URL).

## Requirements

Electron 28 or later.

MIT © Baem Tech
