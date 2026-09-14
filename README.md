# AnyReplay SDKs

Session replay in any language — [anyreplay.com](https://anyreplay.com).

This repository holds the two packages that run inside your product, so you
can read exactly what they record before you install them.

| Package | For | Install |
|---|---|---|
| [`@anyreplay/browser`](./browser) | Web apps (rrweb-based DOM recording, ~26 KB gzipped) | `npm install @anyreplay/browser` |
| [`@anyreplay/react-native`](./react-native) | React Native and Expo apps (records the element tree, not pixels) | `npm install @anyreplay/react-native` |

## Developing

```bash
pnpm install
pnpm build
pnpm test
pnpm size   # the browser bundle has a 45 KB gzip budget
```

## About this repository

It is generated from AnyReplay's private monorepo by `scripts/mirror-sdk.mjs`
and force-pushed on every SDK change (this snapshot: `c3fdb9ee5846`).
Pull requests are welcome, but they are applied upstream and land here on the
next sync rather than being merged directly. Issues are read here.

MIT © Baem Tech
