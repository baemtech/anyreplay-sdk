import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  // Metro and Hermes. Not es2015: Hermes has had async/await and spread for
  // years, and downlevelling them makes the bundle larger and slower for no
  // device that anyone still ships to.
  target: 'es2020',
  external: ['react', 'react-native'],
});
