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
  assert.deepEqual({ ...(await shareDefaults.readAll()) }, {});
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
  assert.deepEqual({ ...(await shareDefaults.readAll()) }, {});
  assert.equal(await fs.readFile(file() + '.corrupt', 'utf8'), '{not json');
  await assert.rejects(fs.access(file()));
  // A valid-JSON non-object is ignored too.
  await fs.writeFile(file(), '[1,2]');
  assert.deepEqual({ ...(await shareDefaults.readAll()) }, {});
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
  assert.deepEqual({ ...(await shareDefaults.readAll()) }, { keep: { username: 'k' } });
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

test('the tmp file is created 0600 before it is chmodded or published', { skip: process.platform === 'win32' }, async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  // Observe the tmp file's mode at the moment of the chmod call — i.e. what
  // writeFile created it with — then delegate unchanged.
  const realChmod = fs.chmod;
  const seen = [];
  fs.chmod = async (p, mode) => {
    seen.push({ p: String(p), mode: (await fs.stat(p)).mode & 0o777 });
    return realChmod.call(fs, p, mode);
  };
  t.after(() => { fs.chmod = realChmod; });
  await shareDefaults.update('app', { password: 'pw' });
  const tmpCalls = seen.filter((c) => c.p.endsWith('.share-defaults.tmp'));
  assert.equal(tmpCalls.length, 1);
  assert.equal(tmpCalls[0].mode, 0o600);
});

test('the published file is 0600 even under a umask that strips every bit', { skip: process.platform === 'win32' }, async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await fs.mkdir(storeRoot(), { recursive: true }); // before the umask, or the dir itself is unusable
  const prev = process.umask(0o777);
  t.after(() => process.umask(prev));
  await shareDefaults.update('app', { password: 'pw' });
  process.umask(prev);
  assert.equal((await fs.stat(file())).mode & 0o777, 0o600);
});

test('a corrupt file moved aside is chmodded 0600, and the warning carries none of its content', { skip: process.platform === 'win32' }, async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await fs.mkdir(storeRoot(), { recursive: true });
  await fs.writeFile(file(), '{"app":{"password":"leaked-secret"', { mode: 0o644 });
  await fs.chmod(file(), 0o644);
  const realWarn = console.warn;
  const warnings = [];
  console.warn = (...a) => warnings.push(a.join(' '));
  t.after(() => { console.warn = realWarn; });
  assert.deepEqual({ ...(await shareDefaults.readAll()) }, {});
  console.warn = realWarn;
  assert.equal((await fs.stat(file() + '.corrupt')).mode & 0o777, 0o600);
  assert.equal(warnings.length, 1);
  assert.ok(!warnings[0].includes('leaked-secret'), warnings[0]);
  assert.ok(!/JSON at position|Unexpected/.test(warnings[0]), warnings[0]);
});

test('prototype-named ids (__proto__, constructor) are stored and read as ordinary own keys', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  // Missing: no entry leaks in from Object.prototype.
  assert.deepEqual(await shareDefaults.get('constructor'), { username: null, password: null });
  assert.deepEqual(await shareDefaults.get('__proto__'), { username: null, password: null });
  assert.equal(shareDefaults.describe((await shareDefaults.readAll()).constructor), null);
  assert.equal(shareDefaults.describe((await shareDefaults.readAll())['__proto__']), null);

  assert.deepEqual(await shareDefaults.update('__proto__', { password: 'p1' }), { username: null, hasPassword: true });
  assert.deepEqual(await shareDefaults.update('constructor', { username: 'c' }), { username: 'c', hasPassword: false });
  const onDisk = JSON.parse(await fs.readFile(file(), 'utf8'));
  assert.ok(Object.hasOwn(onDisk, '__proto__'));
  assert.deepEqual(onDisk.constructor, { username: 'c' });
  assert.deepEqual(await shareDefaults.get('__proto__'), { username: null, password: 'p1' });
  assert.deepEqual(await shareDefaults.get('constructor'), { username: 'c', password: null });

  await shareDefaults.clear('__proto__');
  await shareDefaults.clear('constructor');
  assert.deepEqual(Object.keys(await shareDefaults.readAll()), []);
});
