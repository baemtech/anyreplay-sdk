import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  // As in tsup.config.ts, so the tests see the version a build would report.
  define: { __ANYREPLAY_SDK_VERSION__: JSON.stringify(version) },
  test: {
    environment: 'jsdom',
    // Where cordova-android (10+) serves the app. cordova-ios's app://localhost
    // is an opaque origin to jsdom, with no localStorage; WKWebView gives it
    // storage like any other.
    environmentOptions: { jsdom: { url: 'https://localhost/' } },
    globals: true,
    include: ['test/**/*.spec.ts'],
  },
});
