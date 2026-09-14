import { defineConfig } from 'tsup';

export default defineConfig([
  // npm consumers
  { entry: { index: 'src/index.ts' }, format: ['esm', 'cjs'], dts: true, sourcemap: true, clean: true,
    outDir: 'dist', target: 'es2018' },
  // The CDN bundle: a single self-executing script the snippet loads.
  { entry: { ar: 'src/cdn.ts' }, format: ['iife'], globalName: 'AnyReplayBundle',
    minify: true, sourcemap: true, outDir: 'dist/cdn', target: 'es2018',
    outExtension: () => ({ js: '.min.js' }) },
]);
