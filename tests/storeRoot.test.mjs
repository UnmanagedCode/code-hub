import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { storeRoot, registryFile } from '../src/projects.js';
import { appSettingsFile } from '../src/appSettings.js';
import { hubSettingsFile } from '../src/hubSettings.js';
import { logFile } from '../src/appLog.js';
import { relayDir } from '../src/relayStore.js';
import * as state from '../src/state.js';
import { REPO_ROOT } from './helpers.mjs';

const VAR = 'CONDUCTOR_PLUGIN_DATA_DIR';
const saved = { dir: process.env[VAR], root: process.env.PROJECTS_ROOT };
test.afterEach(() => {
  for (const [k, v] of [[VAR, saved.dir], ['PROJECTS_ROOT', saved.root]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

// Invariant: the store comes only from CONDUCTOR_PLUGIN_DATA_DIR; PROJECTS_ROOT is not its base.
test('storeRoot() is the variable verbatim, whatever PROJECTS_ROOT says', () => {
  process.env.PROJECTS_ROOT = path.resolve('/nonexistent-projects-root');
  process.env[VAR] = path.resolve('/nonexistent-data-dir');
  assert.equal(storeRoot(), process.env[VAR]);
});

// Invariant: no implicit fallback location exists.
test('storeRoot() throws ENODATADIR when the variable is unset, empty or relative', () => {
  process.env.PROJECTS_ROOT = path.resolve('/nonexistent-projects-root');
  for (const v of [undefined, '', 'relative/dir']) {
    if (v === undefined) delete process.env[VAR]; else process.env[VAR] = v;
    assert.throws(() => storeRoot(), (e) => e.code === 'ENODATADIR' && e.message.includes(VAR), String(v));
  }
});

// Invariant: every store file routes through the one resolver.
test('every store path sits under the variable', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codehub-storeroot-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  process.env[VAR] = dir;
  process.env.PROJECTS_ROOT = path.resolve('/nonexistent-projects-root');
  const under = (p) => p.startsWith(dir + path.sep);
  for (const p of [registryFile(), appSettingsFile(), hubSettingsFile(), logFile('x'), relayDir()]) assert.ok(under(p), p);
  await state.save({ apps: {} });
  assert.deepEqual(await fs.readdir(dir), ['state.json']);
});

// Invariant: the migration is the only code naming the legacy path.
const LEGACY = '.code-hub';
const SCANNED = ['src', 'relay', 'server.js', path.join('frontend', 'src')];
const ALLOWED = path.join('src', 'migrateStore.js');
async function files(p) {
  const stat = await fs.stat(p);
  if (!stat.isDirectory()) return [p];
  const out = [];
  for (const e of await fs.readdir(p)) out.push(...(await files(path.join(p, e))));
  return out;
}
const hits = (name, text) => (name !== ALLOWED && text.includes(LEGACY) ? [name] : []);

test('no shipped code but src/migrateStore.js names the legacy store directory', async () => {
  assert.deepEqual(hits('planted.js', `const d = '${LEGACY}';`), ['planted.js']);
  assert.deepEqual(hits(ALLOWED, `const d = '${LEGACY}';`), []);
  const all = (await Promise.all(SCANNED.map((p) => files(path.join(REPO_ROOT, p))))).flat();
  assert.ok(all.length > 20, 'the scan covers the tree');
  const found = [];
  for (const f of all) found.push(...hits(path.relative(REPO_ROOT, f), await fs.readFile(f, 'utf8')));
  assert.deepEqual(found, []);
});
