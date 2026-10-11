import { gzipSync, brotliCompressSync } from 'node:zlib';
import { readFileSync, existsSync } from 'node:fs';

/** Budget from the architecture document. CI fails the build if exceeded. */
const BUDGET_GZIP_BYTES = 45 * 1024;
const FILE = 'dist/cdn/ar.min.js';

if (!existsSync(FILE)) {
  console.error(`size: ${FILE} not found — run \`pnpm build\` first.`);
  process.exit(1);
}

const raw = readFileSync(FILE);
const gzip = gzipSync(raw, { level: 9 });
const brotli = brotliCompressSync(raw);
const kb = (n) => (n / 1024).toFixed(1) + ' KB';

console.log(`  raw     ${kb(raw.byteLength)}`);
console.log(`  gzip    ${kb(gzip.byteLength)}   (budget ${kb(BUDGET_GZIP_BYTES)})`);
console.log(`  brotli  ${kb(brotli.byteLength)}`);

if (gzip.byteLength > BUDGET_GZIP_BYTES) {
  console.error(`\n  FAIL: gzip bundle is ${kb(gzip.byteLength - BUDGET_GZIP_BYTES)} over budget.`);
  process.exit(1);
}
const headroom = BUDGET_GZIP_BYTES - gzip.byteLength;
console.log(`\n  OK: ${kb(headroom)} of headroom.`);
