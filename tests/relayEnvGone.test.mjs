import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { REPO_ROOT } from './helpers.mjs';

// The relay needs no environment: no configuration variable is read, set,
// scrubbed or documented anywhere code-hub ships.
const GONE = ['CODEHUB_RELAY_URL', 'CODEHUB_RELAY_SECRET', 'UNSET_RELAY_ENV'];
const SCANNED = ['src', 'relay', 'server.js', path.join('frontend', 'src'), 'README.md', 'docs'];

async function files(p) {
  const stat = await fs.stat(p);
  if (!stat.isDirectory()) return [p];
  const out = [];
  for (const e of await fs.readdir(p)) out.push(...(await files(path.join(p, e))));
  return out;
}

const hits = (name, text) => GONE.filter((g) => text.includes(g)).map((g) => `${name}: ${g}`);

// Invariant (S8): no shipped file names a removed relay variable — and the
// scanner does flag one when it is there.
test('E1: no file in src, relay, server.js, frontend/src, README.md or docs names a relay env variable', async () => {
  assert.deepEqual(hits('planted.js', 'const u = process.env.CODEHUB_RELAY_URL;'), ['planted.js: CODEHUB_RELAY_URL']);
  const all = (await Promise.all(SCANNED.map((p) => files(path.join(REPO_ROOT, p))))).flat();
  assert.ok(all.length > 20, 'the scan covers the tree');
  const found = [];
  for (const f of all) found.push(...hits(path.relative(REPO_ROOT, f), await fs.readFile(f, 'utf8')));
  assert.deepEqual(found, []);
});
