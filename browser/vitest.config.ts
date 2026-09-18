import { defineConfig } from 'vitest/config';
export default defineConfig({
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
