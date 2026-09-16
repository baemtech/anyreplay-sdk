import { defineConfig } from 'tsup';

export default defineConfig([
  // npm consumers. rrweb is bundled in rather than declared as a dependency:
  // its package entry points do not resolve as ES modules under Node's own
  // loader, so a plain `import { createRecorder }` failed anywhere but inside
  // a bundler. Carrying it here costs nothing a bundler would not have paid
  // and removes the one way the package could fail to import.
  { entry: { index: 'src/index.ts' }, format: ['esm', 'cjs'], dts: true, sourcemap: true, clean: true,
    outDir: 'dist', target: 'es2018', noExternal: ['rrweb'] },
  // The CDN bundle: a single self-executing script the snippet loads.
  { entry: { ar: 'src/cdn.ts' }, format: ['iife'], globalName: 'AnyReplayBundle',
    minify: true, sourcemap: true, outDir: 'dist/cdn', target: 'es2018',
    outExtension: () => ({ js: '.min.js' }) },
]);
