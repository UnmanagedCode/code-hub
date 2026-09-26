import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as shareDefaults from '../src/shareDefaults.js';
import { storeRoot } from '../src/projects.js';
import { mkRoot, rmRoot, mkProject } from './helpers.mjs';

const file = () => path.join(storeRoot(), 'share-defaults.json');

test('update/get round-trips through the file (survives a restart)', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await shareDefaults.update('app', { username: 'alice', password: 's3cret' });
  // No in-memory cache: the file alone is what a fresh process would read.
  assert.deepEqual(JSON.parse(await fs.readFile(file(), 'utf8')), { app: { username: 'alice', password: 's3cret' } });
  assert.deepEqual(await shareDefaults.get('app'), { username: 'alice', password: 's3cret' });
  assert.deepEqual(await shareDefaults.get('other'), { username: null, password: null });
});

test('share-defaults.json is written 0600 even over a pre-existing 0644 file', { skip: process.platform === 'win32' }, async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await fs.mkdir(storeRoot(), { recursive: true });
  await fs.writeFile(file(), '{}', { mode: 0o644 });
  await fs.chmod(file(), 0o644);
  await shareDefaults.update('app', { password: 'pw' });
  assert.equal((await fs.stat(file())).mode & 0o777, 0o600);
});

test('lives under storeRoot, never in a project tree', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const dir = await mkProject(root, 'app', { start: 'true' });
  const before = (await fs.readdir(dir)).sort();
  await shareDefaults.update('app', { username: 'u', password: 'p' });
  assert.deepEqual((await fs.readdir(dir)).sort(), before);
  assert.equal(shareDefaults.shareDefaultsFile(), path.join(storeRoot(), 'share-defaults.json'));
  await fs.access(shareDefaults.shareDefaultsFile());
});

test('fields are independent: absent keeps, null clears, both cleared deletes the entry', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  // Username-only entry.
  assert.deepEqual(await shareDefaults.update('app', { username: '  alice  ' }), { username: 'alice', hasPassword: false });
  assert.deepEqual(await shareDefaults.get('app'), { username: 'alice', password: null });
  // Adding a password keeps the username (absent key → keep).
  assert.deepEqual(await shareDefaults.update('app', { password: 'pw' }), { username: 'alice', hasPassword: true });
  // null clears just that field → password-only entry.
  assert.deepEqual(await shareDefaults.update('app', { username: null }), { username: null, hasPassword: true });
  assert.deepEqual(await shareDefaults.get('app'), { username: null, password: 'pw' });
  // Clearing the last field deletes the entry outright.
  assert.equal(await shareDefaults.update('app', { password: null }), null);
  assert.deepEqual(await shareDefaults.readAll(), {});
});

test('empty/whitespace/non-string values are rejected with 400', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await shareDefaults.update('app', { username: 'alice', password: 'pw' });
  const before = await fs.readFile(file(), 'utf8');
  for (const body of [
    { username: '' }, { password: '   ' }, { username: 42 }, { password: true }, { password: {} },
    {}, { other: 'x' }, null, 'str', [],
  ]) {
    await assert.rejects(shareDefaults.update('app', body), (e) => e.statusCode === 400, JSON.stringify(body));
  }
  // One bad field fails the whole update — the good one isn't applied either.
  await assert.rejects(shareDefaults.update('app', { username: 'bob', password: '' }), (e) => e.statusCode === 400);
  assert.equal(await fs.readFile(file(), 'utf8'), before);
});

test('describe never exposes the password', () => {
  assert.deepEqual(shareDefaults.describe({ username: 'u', password: 'p' }), { username: 'u', hasPassword: true });
  assert.deepEqual(shareDefaults.describe({ password: 'p' }), { username: null, hasPassword: true });
  assert.deepEqual(shareDefaults.describe({ username: 'u' }), { username: 'u', hasPassword: false });
  assert.equal(shareDefaults.describe(undefined), null);
  assert.ok(!JSON.stringify(shareDefaults.describe({ username: 'u', password: 'p' })).includes('"p"'));
});

test('corrupt file is moved aside and treated as empty', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await fs.mkdir(storeRoot(), { recursive: true });
  await fs.writeFile(file(), '{not json');
  assert.deepEqual(await shareDefaults.readAll(), {});
  assert.equal(await fs.readFile(file() + '.corrupt', 'utf8'), '{not json');
  await assert.rejects(fs.access(file()));
  // A valid-JSON non-object is ignored too.
  await fs.writeFile(file(), '[1,2]');
  assert.deepEqual(await shareDefaults.readAll(), {});
});

test('clear is idempotent', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await shareDefaults.clear('app'); // nothing there: no throw, no file created
  await assert.rejects(fs.access(file()));
  await shareDefaults.update('app', { password: 'pw' });
  await shareDefaults.update('keep', { username: 'k' });
  await shareDefaults.clear('app');
  await shareDefaults.clear('app');
  assert.deepEqual(await shareDefaults.readAll(), { keep: { username: 'k' } });
});

test('concurrent updates for two ids both survive (writes are serialised)', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const ids = Array.from({ length: 10 }, (_, i) => `app${i}`);
  await Promise.all([
    ...ids.map((id) => shareDefaults.update(id, { username: id })),
    shareDefaults.clear('app0'), // queued after app0's update → app0 gone
  ]);
  const all = await shareDefaults.readAll();
  assert.deepEqual(Object.keys(all).sort(), ids.slice(1).sort());
  for (const id of ids.slice(1)) assert.equal(all[id].username, id);
});
