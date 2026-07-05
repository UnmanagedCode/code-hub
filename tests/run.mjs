// Programmatic test runner — this device's node wrapper hoists leading
// `--flags` into NODE_OPTIONS (which rejects `--test`), so we drive the
// node:test runner via its public API instead. (Same rationale as
// code-conductor's runner.)
import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveConcurrency() {
  const env = process.env.TEST_CONCURRENCY;
  if (env !== undefined) {
    const n = Number(env);
    if (Number.isInteger(n) && n >= 1) return n;
  }
  const cores = os.availableParallelism ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(4, Math.floor(cores / 2)));
}

async function discover() {
  const want = process.argv.slice(2);
  if (want.length > 0) {
    return want.map((a) => (path.isAbsolute(a) ? a : path.resolve(process.cwd(), a)));
  }
  const entries = await fs.readdir(__dirname);
  return entries
    .filter((n) => n.endsWith('.test.mjs'))
    .map((n) => path.join(__dirname, n))
    .sort();
}

const files = await discover();
if (files.length === 0) {
  console.error('no test files found');
  process.exit(1);
}

const stream = run({ files, concurrency: resolveConcurrency(), timeout: 60_000 });
let failed = 0;
stream.on('test:fail', (data) => {
  if (data.details?.type === 'suite') return;
  failed++;
});
const reporter = stream.compose(new spec());
reporter.pipe(process.stdout);
await new Promise((resolve) => reporter.on('end', resolve));
process.exit(failed === 0 ? 0 : 1);
