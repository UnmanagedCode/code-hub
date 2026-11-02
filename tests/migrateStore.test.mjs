import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { migrateLegacyStore, _setRename } from '../src/migrateStore.js';
import { mkRoot, rmRoot, dataDirIn, snapshotTree } from './helpers.mjs';

test.afterEach(() => _setRename(null));

const FILES = [ // [relPath, mode, content]
  ['app-settings.json', 0o600, '{"a":1}'],
  ['registrations.json', 0o644, '{}'],
  ['state.json', 0o644, '{"apps":{}}'],
  ['hub-settings.json', 0o644, '{"bridgeFallback":false}'],
  ['logs/a.log', 0o600, 'line\n'],
  ['relay/relay.json', 0o600, '{}'],
];

// A scratch dir holding a legacy store with mixed modes, and a target path beside it.
async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'codehub-migrate-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const legacyDir = path.join(base, '.code-hub');
  await fs.mkdir(legacyDir, { mode: 0o755 });
  await fs.chmod(legacyDir, 0o755);
  for (const d of ['logs', 'relay']) { await fs.mkdir(path.join(legacyDir, d)); await fs.chmod(path.join(legacyDir, d), 0o700); }
  for (const [rel, mode, content] of FILES) {
    await fs.writeFile(path.join(legacyDir, rel), content);
    await fs.chmod(path.join(legacyDir, rel), mode);
  }
  return { base, legacyDir, dataDir: path.join(base, 'plugins', 'data', 'code-hub') };
}

const exists = (p) => fs.lstat(p).then(() => true, () => false);

// Invariant: nothing to move is a no-op that creates nothing.
test('M1: absent legacy dir → "absent", data dir not created', async (t) => {
  const { legacyDir, dataDir } = await fixture(t);
  await fs.rm(legacyDir, { recursive: true });
  assert.equal(await migrateLegacyStore({ legacyDir, dataDir }), 'absent');
  assert.equal(await exists(path.dirname(dataDir)), false);
});

// Invariant: the default legacy root comes from projectsRoot(), the default target from storeRoot().
test('M1d: no arguments → moves <PROJECTS_ROOT>/.code-hub into the variable\'s dir', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await fs.rm(dataDirIn(root), { recursive: true }); // mkRoot's hub-settings file
  await fs.mkdir(path.join(root, '.code-hub'));
  await fs.writeFile(path.join(root, '.code-hub', 'registrations.json'), '{}');
  assert.equal(await migrateLegacyStore(), 'moved');
  assert.equal(await fs.readFile(path.join(dataDirIn(root), 'registrations.json'), 'utf8'), '{}');
  assert.equal(await exists(path.join(root, '.code-hub')), false);
});

// Invariant: the default legacy root is <projectsRoot()>/.code-hub whatever the
// data dir's location — a data dir outside PROJECTS_ROOT must not move it, and
// a legacy dir beside the data dir's ancestors is not the one moved.
test('M1d (outside): CONDUCTOR_PLUGIN_DATA_DIR outside PROJECTS_ROOT still moves <PROJECTS_ROOT>/.code-hub', async (t) => {
  const root = await mkRoot();
  const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), 'codehub-elsewhere-'));
  t.after(() => Promise.all([rmRoot(root), fs.rm(elsewhere, { recursive: true, force: true })]));
  const dataDir = path.join(elsewhere, 'data', 'code-hub');
  const prevDataDir = process.env.CONDUCTOR_PLUGIN_DATA_DIR;
  t.after(() => { if (prevDataDir === undefined) delete process.env.CONDUCTOR_PLUGIN_DATA_DIR; else process.env.CONDUCTOR_PLUGIN_DATA_DIR = prevDataDir; });
  process.env.CONDUCTOR_PLUGIN_DATA_DIR = dataDir;
  await fs.mkdir(path.join(root, '.code-hub'));
  await fs.writeFile(path.join(root, '.code-hub', 'registrations.json'), '{"moved":1}');
  await fs.mkdir(path.join(elsewhere, '.code-hub')); // a decoy beside the data dir's ancestors
  assert.equal(await migrateLegacyStore(), 'moved');
  assert.equal(await fs.readFile(path.join(dataDir, 'registrations.json'), 'utf8'), '{"moved":1}');
  assert.equal(await exists(path.join(root, '.code-hub')), false);
  assert.equal(await exists(path.join(elsewhere, '.code-hub')), true);
});

// Invariant: modes are kept exactly and the move is a rename (inodes survive, so
// a running app's open log fd keeps writing into the moved file).
test('M2: fresh move keeps modes, content and inodes; parent is 0755; an open fd follows the file', async (t) => {
  const { legacyDir, dataDir } = await fixture(t);
  const before = await snapshotTree(legacyDir);
  const inodes = {};
  for (const rel of Object.keys(before)) inodes[rel] = (await fs.lstat(path.join(legacyDir, rel))).ino;
  const fh = await fs.open(path.join(legacyDir, 'logs/a.log'), 'a');
  t.after(() => fh.close());
  // Under umask 0 the default mkdir mode (0777) and the explicit 0755 diverge.
  const oldUmask = process.umask(0);
  try { assert.equal(await migrateLegacyStore({ legacyDir, dataDir }), 'moved'); } finally { process.umask(oldUmask); }
  for (const d of [path.dirname(dataDir), path.dirname(path.dirname(dataDir))]) {
    assert.equal((await fs.stat(d)).mode & 0o777, 0o755, d);
  }
  assert.equal(await exists(legacyDir), false);
  assert.deepEqual(await snapshotTree(dataDir), before);
  for (const rel of Object.keys(before)) assert.equal((await fs.lstat(path.join(dataDir, rel))).ino, inodes[rel], rel);
  await fh.write('after\n');
  assert.equal(await fs.readFile(path.join(dataDir, 'logs/a.log'), 'utf8'), 'line\nafter\n');
});

// Invariant: never merges or overwrites; nothing is lost.
test('M3: a non-empty target is refused with both paths named and both trees unchanged', async (t) => {
  const { legacyDir, dataDir } = await fixture(t);
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, 'registrations.json'), '{"other":1}');
  const before = [await snapshotTree(legacyDir), await snapshotTree(dataDir)];
  await assert.rejects(migrateLegacyStore({ legacyDir, dataDir }), (e) =>
    e.code === 'ESTOREMIGRATE' && e.message.includes(legacyDir) && e.message.includes(dataDir));
  assert.deepEqual([await snapshotTree(legacyDir), await snapshotTree(dataDir)], before);
});

// Invariant: an empty target is replaced, and the legacy root's mode wins.
test('M4: an empty target (0700) is replaced and takes the legacy root\'s 0755', async (t) => {
  const { legacyDir, dataDir } = await fixture(t);
  await fs.mkdir(dataDir, { recursive: true });
  await fs.chmod(dataDir, 0o700);
  assert.equal(await migrateLegacyStore({ legacyDir, dataDir }), 'moved');
  assert.equal((await fs.stat(dataDir)).mode & 0o777, 0o755);
  assert.equal(await exists(path.join(dataDir, 'state.json')), true);
});

// Invariant: idempotent.
test('M5: a second run returns "absent" and changes nothing', async (t) => {
  const { legacyDir, dataDir } = await fixture(t);
  await migrateLegacyStore({ legacyDir, dataDir });
  const before = await snapshotTree(dataDir);
  assert.equal(await migrateLegacyStore({ legacyDir, dataDir }), 'absent');
  assert.deepEqual(await snapshotTree(dataDir), before);
});

// Invariant: a cross-device move refuses without loss and names the manual fix.
test('M6: EXDEV is refused naming both paths and an mv command; legacy data unchanged, no data in the target', async (t) => {
  const { legacyDir, dataDir } = await fixture(t);
  const before = await snapshotTree(legacyDir);
  _setRename(async () => { throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' }); });
  await assert.rejects(migrateLegacyStore({ legacyDir, dataDir }), (e) =>
    e.code === 'ESTOREMIGRATE' && e.message.includes(legacyDir) && e.message.includes(dataDir)
    && e.message.includes(`mv '${legacyDir}' '${dataDir}'`));
  assert.deepEqual(await snapshotTree(legacyDir), before);
  assert.equal(await exists(dataDir), false);
});

// Invariant: only a real directory is migrated.
test('M7: a legacy path that is a file or a symlink is refused, trees unchanged', async (t) => {
  const { base, legacyDir, dataDir } = await fixture(t);
  const real = path.join(base, 'real');
  await fs.rename(legacyDir, real);
  await fs.writeFile(legacyDir, 'x');
  await assert.rejects(migrateLegacyStore({ legacyDir, dataDir }), { code: 'ESTOREMIGRATE' });
  await fs.rm(legacyDir);
  await fs.symlink(real, legacyDir);
  const before = await snapshotTree(real);
  await assert.rejects(migrateLegacyStore({ legacyDir, dataDir }), { code: 'ESTOREMIGRATE' });
  assert.equal((await fs.lstat(legacyDir)).isSymbolicLink(), true);
  assert.deepEqual(await snapshotTree(real), before);
  assert.equal(await exists(dataDir), false);
});

// Invariant: pointing the variable at the old dir — however spelled — is not a conflict.
test('M8: legacyDir equal to dataDir → "same", tree unchanged', async (t) => {
  const { legacyDir } = await fixture(t);
  const before = await snapshotTree(legacyDir);
  assert.equal(await migrateLegacyStore({ legacyDir, dataDir: legacyDir }), 'same');
  // "same" is the resolved path, not the string: the variable is returned verbatim.
  assert.equal(await migrateLegacyStore({ legacyDir, dataDir: legacyDir + path.sep }), 'same');
  assert.equal(await migrateLegacyStore({ legacyDir, dataDir: path.join(legacyDir, '..', path.basename(legacyDir)) }), 'same');
  assert.deepEqual(await snapshotTree(legacyDir), before);
});

// Invariant: a regular file at the data-dir path is refused, both paths named, trees unchanged.
test('M10: a regular file at the data dir path is refused, trees unchanged', async (t) => {
  const { base, legacyDir, dataDir } = await fixture(t);
  await fs.mkdir(path.dirname(dataDir), { recursive: true });
  await fs.writeFile(dataDir, 'not a dir');
  const before = await snapshotTree(base);
  await assert.rejects(migrateLegacyStore({ legacyDir, dataDir }), (e) =>
    e.code === 'ESTOREMIGRATE' && e.message.includes(legacyDir) && e.message.includes(dataDir));
  assert.deepEqual(await snapshotTree(base), before);
});

// Invariant: a failed rename never modifies the legacy tree and puts no data in
// the target; the target path does not exist afterwards (an emptied target stays
// removed, nothing is recreated), with the target absent or an empty directory; a re-run once the cause is gone succeeds.
test('M11: a failed rename leaves the legacy tree identical and no data in the target', async (t) => {
  const { legacyDir, dataDir } = await fixture(t);
  const before = await snapshotTree(legacyDir);
  _setRename(async () => { throw Object.assign(new Error('boom'), { code: 'EIO' }); });
  await assert.rejects(migrateLegacyStore({ legacyDir, dataDir }), (e) =>
    e.code === 'ESTOREMIGRATE' && e.message.includes(legacyDir) && e.message.includes(dataDir));
  assert.deepEqual(await snapshotTree(legacyDir), before);
  assert.equal(await exists(dataDir), false);
  await fs.mkdir(dataDir, { recursive: true }); // the empty-target case
  await assert.rejects(migrateLegacyStore({ legacyDir, dataDir }), (e) =>
    e.code === 'ESTOREMIGRATE' && e.message.includes(legacyDir) && e.message.includes(dataDir));
  assert.deepEqual(await snapshotTree(legacyDir), before);
  assert.equal(await exists(dataDir), false, 'the emptied target stays removed, nothing is recreated');
  _setRename(null);
  assert.equal(await migrateLegacyStore({ legacyDir, dataDir }), 'moved');
  assert.deepEqual(await snapshotTree(dataDir), before);
});

// Invariant: an unreadable target or unwritable parent is a refusal too (ESTOREMIGRATE, both paths).
test('M12: an unwritable parent is refused as ESTOREMIGRATE with nothing created', { skip: process.getuid?.() === 0 ? 'root ignores permissions' : false }, async (t) => {
  const { base, legacyDir } = await fixture(t);
  const ro = path.join(base, 'ro');
  await fs.mkdir(ro, { mode: 0o500 });
  t.after(() => fs.chmod(ro, 0o700).catch(() => {}));
  const dataDir = path.join(ro, 'a', 'code-hub');
  const before = await snapshotTree(legacyDir);
  await assert.rejects(migrateLegacyStore({ legacyDir, dataDir }), (e) =>
    e.code === 'ESTOREMIGRATE' && e.message.includes(legacyDir) && e.message.includes(dataDir));
  assert.deepEqual(await snapshotTree(legacyDir), before);
  assert.deepEqual(await fs.readdir(ro), []);
});

// Invariant: an unreadable (empty, mode 0300) target is refused as ESTOREMIGRATE
// naming both paths, and the legacy tree is unchanged.
test('M13: an unreadable target is refused', { skip: process.getuid?.() === 0 ? 'root ignores permissions' : false }, async (t) => {
  const { legacyDir, dataDir } = await fixture(t);
  await fs.mkdir(dataDir, { recursive: true });
  await fs.chmod(dataDir, 0o300);
  t.after(() => fs.chmod(dataDir, 0o700).catch(() => {}));
  const before = await snapshotTree(legacyDir);
  await assert.rejects(migrateLegacyStore({ legacyDir, dataDir }), (e) =>
    e.code === 'ESTOREMIGRATE' && e.message.includes(legacyDir) && e.message.includes(dataDir));
  assert.deepEqual(await snapshotTree(legacyDir), before);
});

// Invariant: an lstat that fails (EACCES) on the data dir or on the legacy dir is
// a refusal — ESTOREMIGRATE, both paths named — and the legacy data is unchanged.
const posixOnly = { skip: process.getuid?.() === 0 ? 'root ignores permissions' : false };
test('M14: an unsearchable parent of the data dir is refused', posixOnly, async (t) => {
  const { base, legacyDir } = await fixture(t);
  const locked = path.join(base, 'locked');
  await fs.mkdir(locked);
  const dataDir = path.join(locked, 'code-hub');
  const before = await snapshotTree(legacyDir);
  await fs.chmod(locked, 0o600);
  t.after(() => fs.chmod(locked, 0o700).catch(() => {}));
  await assert.rejects(migrateLegacyStore({ legacyDir, dataDir }), (e) =>
    e.code === 'ESTOREMIGRATE' && e.message.includes(legacyDir) && e.message.includes(dataDir));
  await fs.chmod(locked, 0o700);
  assert.deepEqual(await snapshotTree(legacyDir), before);
  assert.deepEqual(await fs.readdir(locked), []);
});

test('M15: an unsearchable parent of the legacy dir is refused', posixOnly, async (t) => {
  const { base, legacyDir: orig, dataDir } = await fixture(t);
  const locked = path.join(base, 'lp');
  await fs.mkdir(locked);
  const legacyDir = path.join(locked, '.code-hub');
  await fs.rename(orig, legacyDir);
  const before = await snapshotTree(legacyDir);
  await fs.chmod(locked, 0o600);
  t.after(() => fs.chmod(locked, 0o700).catch(() => {}));
  await assert.rejects(migrateLegacyStore({ legacyDir, dataDir }), (e) =>
    e.code === 'ESTOREMIGRATE' && e.message.includes(legacyDir) && e.message.includes(dataDir));
  await fs.chmod(locked, 0o700);
  assert.deepEqual(await snapshotTree(legacyDir), before);
  assert.equal(await exists(dataDir), false);
});

// Invariant: the variable is resolved before anything is touched.
test('M9: an unset variable rejects ENODATADIR with the legacy dir unchanged', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codehub-migrate-unset-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.code-hub'));
  await fs.writeFile(path.join(root, '.code-hub', 'state.json'), '{}');
  const saved = { dir: process.env.CONDUCTOR_PLUGIN_DATA_DIR, root: process.env.PROJECTS_ROOT };
  t.after(() => {
    for (const [k, v] of [['CONDUCTOR_PLUGIN_DATA_DIR', saved.dir], ['PROJECTS_ROOT', saved.root]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
  delete process.env.CONDUCTOR_PLUGIN_DATA_DIR;
  process.env.PROJECTS_ROOT = root;
  const before = await snapshotTree(root);
  await assert.rejects(migrateLegacyStore(), { code: 'ENODATADIR' });
  assert.deepEqual(await snapshotTree(root), before);
});
