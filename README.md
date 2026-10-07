# AnyReplay SDKs

Session replay in any language — [anyreplay.com](https://anyreplay.com).

This repository holds the packages that run inside your product, so you
can read exactly what they record before you install them.

| Package | For | Install |
|---|---|---|
| [`@anyreplay/browser`](./browser) | Web apps (rrweb-based DOM recording, ~26 KB gzipped) | `npm install @anyreplay/browser` |
| [`@anyreplay/react-native`](./react-native) | React Native and Expo apps (records the element tree, not pixels) | `npm install @anyreplay/react-native` |
| [`@anyreplay/electron`](./electron) | Electron apps (each window recorded with the browser SDK) | `npm install @anyreplay/electron` |
| [`@anyreplay/tauri`](./tauri) | Tauri v2 apps (the JavaScript side; no Rust plugin) | `npm install @anyreplay/tauri` |
| [`@anyreplay/capacitor`](./capacitor) | Capacitor and Ionic apps (the browser SDK plus a small native plugin) | `npm install @anyreplay/capacitor` |
| [`@anyreplay/cordova`](./cordova) | Cordova apps (the same, as a Cordova plugin) | `cordova plugin add @anyreplay/cordova` |

## Developing

```bash
pnpm install
pnpm build
pnpm test
pnpm size   # the browser bundle has a 45 KB gzip budget
```

## About this repository

It is generated from AnyReplay's private monorepo by `scripts/mirror-sdk.mjs`
and force-pushed on every SDK change (this snapshot: `137e942cac4f`).
Pull requests are welcome, but they are applied upstream and land here on the
next sync rather than being merged directly. Issues are read here.

MIT © Baem Tech
