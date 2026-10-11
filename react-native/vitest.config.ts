import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  // As in tsup.config.ts, so the tests see the version a build would report.
  define: { __ANYREPLAY_SDK_VERSION__: JSON.stringify(version) },
  test: { environment: 'node', include: ['test/**/*.test.ts'] },
});
