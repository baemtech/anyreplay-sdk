import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

// The version every session reports as `meta.sdk.version`; see src/version.ts.
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  // `shell` is the part @anyreplay/cordova shares; it is its own entry so
  // that package can bundle it without pulling in @capacitor/core.
  entry: { index: 'src/index.ts', shell: 'src/shell.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  target: 'es2018',
  // A dependency and a peer: the app resolves both, once.
  external: ['@anyreplay/browser', '@capacitor/core'],
  define: { __ANYREPLAY_SDK_VERSION__: JSON.stringify(version) },
});
