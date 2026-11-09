import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

// The version every session reports as `meta.sdk.version`; see src/version.ts.
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  target: 'es2020',
  // @anyreplay/browser is a dependency, not bundled: a web-family SDK records
  // with it rather than with a copy (docs/SDK-CONTRACT.md §1). The Tauri API is
  // the app's own copy, so it talks to the app's own runtime.
  external: [/^@tauri-apps\/api/, '@anyreplay/browser'],
  define: { __ANYREPLAY_SDK_VERSION__: JSON.stringify(version) },
});
