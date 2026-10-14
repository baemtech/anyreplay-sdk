import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

// The version every session reports as `meta.sdk.version`; see src/version.ts.
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

/**
 * One file, everything inside it.
 *
 * Cordova loads a plugin's JavaScript as a module of its own little module
 * system (plugin.xml's <js-module>, wrapped in `cordova.define`), with no
 * bundler and no node_modules: whatever the file needs has to be in it. So
 * the browser SDK, rrweb and the shared app-shell core are bundled in, and
 * the result is CommonJS — `module.exports` is what `<clobbers>` hangs on
 * `window.AnyReplay`.
 */
export default defineConfig({
  entry: { anyreplay: 'src/index.ts' },
  format: ['cjs'],
  outExtension: () => ({ js: '.js' }),
  platform: 'browser',
  target: 'es2018',
  noExternal: [/.*/],
  minify: true,
  sourcemap: false,
  clean: true,
  outDir: 'dist',
  define: { __ANYREPLAY_SDK_VERSION__: JSON.stringify(version) },
});
