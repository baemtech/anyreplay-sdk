import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  // As in tsup.config.ts, so the tests see the version a build would report.
  define: { __ANYREPLAY_SDK_VERSION__: JSON.stringify(version) },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['test/**/*.spec.ts'],
    // rrweb's package `main` is a CommonJS build that Vitest cannot load as an
    // ES module; its `module` entry is the real thing. The bundle resolves the
    // same file, so the tests exercise the code that ships.
    alias: { rrweb: 'rrweb/es/rrweb/packages/rrweb/src/entries/all.js' },
  },
});
