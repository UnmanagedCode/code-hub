import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as appSettings from '../src/appSettings.js';
import { storeRoot } from '../src/projects.js';
import { mkRoot, rmRoot, mkProject } from './helpers.mjs';

const file = () => path.join(storeRoot(), 'app-settings.json');
const legacyFile = () => path.join(storeRoot(), 'share-defaults.json');
const OFF = { autoStart: false, autoShare: null, port: null };

test('update/get round-trips through the file (survives a restart)', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await appSettings.update('app', { username: 'alice', password: 's3cret' });
  // No in-memory cache: the file alone is what a fresh process would read.
  assert.deepEqual(JSON.parse(await fs.readFile(file(), 'utf8')), { app: { username: 'alice', password: 's3cret' } });
  assert.deepEqual(await appSettings.get('app'), { username: 'alice', password: 's3cret', ...OFF });
  assert.deepEqual(await appSettings.get('other'), { username: null, password: null, ...OFF });
});

test('app-settings.json is written 0600 even over a pre-existing 0644 file', { skip: process.platform === 'win32' }, async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await fs.mkdir(storeRoot(), { recursive: true });
  await fs.writeFile(file(), '{}', { mode: 0o644 });
  await fs.chmod(file(), 0o644);
  await appSettings.update('app', { password: 'pw' });
  assert.equal((await fs.stat(file())).mode & 0o777, 0o600);
});

test('lives under storeRoot, never in a project tree', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const dir = await mkProject(root, 'app', { start: 'true' });
  const before = (await fs.readdir(dir)).sort();
  await appSettings.update('app', { username: 'u', password: 'p' });
  assert.deepEqual((await fs.readdir(dir)).sort(), before);
  assert.equal(appSettings.appSettingsFile(), path.join(storeRoot(), 'app-settings.json'));
  await fs.access(appSettings.appSettingsFile());
});

test('fields are independent: absent keeps, null clears, both cleared deletes the entry', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  // Username-only entry.
  assert.deepEqual(await appSettings.update('app', { username: '  alice  ' }), { username: 'alice', hasPassword: false, ...OFF });
  assert.deepEqual(await appSettings.get('app'), { username: 'alice', password: null, ...OFF });
  // Adding a password keeps the username (absent key → keep).
  assert.deepEqual(await appSettings.update('app', { password: 'pw' }), { username: 'alice', hasPassword: true, ...OFF });
  // null clears just that field → password-only entry.
  assert.deepEqual(await appSettings.update('app', { username: null }), { username: null, hasPassword: true, ...OFF });
  assert.deepEqual(await appSettings.get('app'), { username: null, password: 'pw', ...OFF });
  // Clearing the last field deletes the entry outright.
  assert.deepEqual(await appSettings.update('app', { password: null }), { username: null, hasPassword: false, ...OFF });
  assert.deepEqual({ ...(await appSettings.readAll()) }, {});
});

test('empty/whitespace/non-string values are rejected with 400', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await appSettings.update('app', { username: 'alice', password: 'pw' });
  const before = await fs.readFile(file(), 'utf8');
  for (const body of [
    { username: '' }, { password: '   ' }, { username: 42 }, { password: true }, { password: {} },
    {}, { other: 'x' }, null, 'str', [],
  ]) {
    await assert.rejects(appSettings.update('app', body), (e) => e.statusCode === 400, JSON.stringify(body));
  }
  // One bad field fails the whole update — the good one isn't applied either.
  await assert.rejects(appSettings.update('app', { username: 'bob', password: '' }), (e) => e.statusCode === 400);
  assert.equal(await fs.readFile(file(), 'utf8'), before);
});

test('describe never exposes the password', () => {
  assert.deepEqual(appSettings.describe({ username: 'u', password: 'p' }), { username: 'u', hasPassword: true, ...OFF });
  assert.deepEqual(appSettings.describe({ password: 'p' }), { username: null, hasPassword: true, ...OFF });
  assert.deepEqual(appSettings.describe({ username: 'u' }), { username: 'u', hasPassword: false, ...OFF });
  assert.deepEqual(appSettings.describe(undefined), { username: null, hasPassword: false, ...OFF });
  assert.ok(!JSON.stringify(appSettings.describe({ username: 'u', password: 'p' })).includes('"p"'));
});

test('corrupt file is moved aside and treated as empty', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await fs.mkdir(storeRoot(), { recursive: true });
  await fs.writeFile(file(), '{not json');
  assert.deepEqual({ ...(await appSettings.readAll()) }, {});
  assert.equal(await fs.readFile(file() + '.corrupt', 'utf8'), '{not json');
  await assert.rejects(fs.access(file()));
  // A valid-JSON non-object is ignored too.
  await fs.writeFile(file(), '[1,2]');
  assert.deepEqual({ ...(await appSettings.readAll()) }, {});
});

test('clear is idempotent', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await appSettings.clear('app'); // nothing there: no throw, no file created
  await assert.rejects(fs.access(file()));
  await appSettings.update('app', { password: 'pw' });
  await appSettings.update('keep', { username: 'k' });
  await appSettings.clear('app');
  await appSettings.clear('app');
  assert.deepEqual({ ...(await appSettings.readAll()) }, { keep: { username: 'k' } });
});

test('concurrent updates for two ids both survive (writes are serialised)', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const ids = Array.from({ length: 10 }, (_, i) => `app${i}`);
  await Promise.all([
    ...ids.map((id) => appSettings.update(id, { username: id })),
    appSettings.clear('app0'), // queued after app0's update → app0 gone
  ]);
  const all = await appSettings.readAll();
  assert.deepEqual(Object.keys(all).sort(), ids.slice(1).sort());
  for (const id of ids.slice(1)) assert.equal(all[id].username, id);
});

test('the tmp file is created 0600 before it is chmodded or published', { skip: process.platform === 'win32' }, async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  // umask 0, so the create mode is decided by writeFile's `mode` alone.
  const prevUmask = process.umask(0);
  t.after(() => process.umask(prevUmask));
  // Observe the tmp file's mode at the moment of the chmod call — i.e. what
  // writeFile created it with — then delegate unchanged.
  const realChmod = fs.chmod;
  const seen = [];
  fs.chmod = async (p, mode) => {
    seen.push({ p: String(p), mode: (await fs.stat(p)).mode & 0o777 });
    return realChmod.call(fs, p, mode);
  };
  t.after(() => { fs.chmod = realChmod; });
  await appSettings.update('app', { password: 'pw' });
  const tmpCalls = seen.filter((c) => c.p.endsWith('.app-settings.tmp'));
  assert.equal(tmpCalls.length, 1);
  assert.equal(tmpCalls[0].mode, 0o600);
});

test('the published file is 0600 even under a umask that strips every bit', { skip: process.platform === 'win32' }, async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await fs.mkdir(storeRoot(), { recursive: true }); // before the umask, or the dir itself is unusable
  const prev = process.umask(0o777);
  t.after(() => process.umask(prev));
  await appSettings.update('app', { password: 'pw' });
  process.umask(prev);
  assert.equal((await fs.stat(file())).mode & 0o777, 0o600);
});

test('a corrupt file moved aside is chmodded 0600, and the warning carries none of its content', { skip: process.platform === 'win32' }, async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await fs.mkdir(storeRoot(), { recursive: true });
  // The secret leads the content, so even a logged prefix of the raw input shows.
  await fs.writeFile(file(), 'leaked-secret{"app":{"password":"x"', { mode: 0o644 });
  await fs.chmod(file(), 0o644);
  const realWarn = console.warn;
  const warnings = [];
  console.warn = (...a) => warnings.push(a.join(' '));
  t.after(() => { console.warn = realWarn; });
  assert.deepEqual({ ...(await appSettings.readAll()) }, {});
  console.warn = realWarn;
  assert.equal((await fs.stat(file() + '.corrupt')).mode & 0o777, 0o600);
  assert.equal(warnings.length, 1);
  assert.ok(!warnings[0].includes('leaked'), warnings[0]);
  assert.ok(!/JSON at position|Unexpected/.test(warnings[0]), warnings[0]);
});

test('prototype-named ids (__proto__, constructor) are stored and read as ordinary own keys', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  // Missing: no entry leaks in from Object.prototype.
  assert.deepEqual(await appSettings.get('constructor'), { username: null, password: null, ...OFF });
  assert.deepEqual(await appSettings.get('__proto__'), { username: null, password: null, ...OFF });
  assert.deepEqual(appSettings.describe((await appSettings.readAll()).constructor), appSettings.describe(undefined));
  assert.deepEqual(appSettings.describe((await appSettings.readAll())['__proto__']), appSettings.describe(undefined));

  assert.deepEqual(await appSettings.update('__proto__', { password: 'p1' }), { username: null, hasPassword: true, ...OFF });
  assert.deepEqual(await appSettings.update('constructor', { username: 'c' }), { username: 'c', hasPassword: false, ...OFF });
  const onDisk = JSON.parse(await fs.readFile(file(), 'utf8'));
  assert.ok(Object.hasOwn(onDisk, '__proto__'));
  assert.deepEqual(onDisk.constructor, { username: 'c' });
  assert.deepEqual(await appSettings.get('__proto__'), { username: null, password: 'p1', ...OFF });
  assert.deepEqual(await appSettings.get('constructor'), { username: 'c', password: null, ...OFF });

  await appSettings.clear('__proto__');
  await appSettings.clear('constructor');
  assert.deepEqual(Object.keys(await appSettings.readAll()), []);
});

// Invariant: the empty-body refusal names all five settable keys.
test('an empty body is refused with the full list of keys', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await assert.rejects(
    appSettings.update('app', {}),
    (e) => e.statusCode === 400 && e.message === 'provide at least one of username, password, autoStart, autoShare, port',
  );
});

// Invariant: an entry holding only a login (the shape the file had before the
// toggles existed) reads as both toggles off.
test('an entry with only username/password describes and gets as autoStart off, autoShare null', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await fs.mkdir(storeRoot(), { recursive: true });
  await fs.writeFile(file(), JSON.stringify({ app: { username: 'alice', password: 'pw' } }));
  assert.deepEqual(appSettings.describe((await appSettings.readAll()).app), { username: 'alice', hasPassword: true, ...OFF });
  assert.deepEqual(await appSettings.get('app'), { username: 'alice', password: 'pw', ...OFF });
});

// Invariant: autoStart is stored only while true; an entry holding nothing but
// a toggle is kept, and clearing every field deletes the entry.
test('autoStart: true is stored, false removes the key, and an entry emptied of every field is deleted', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  assert.deepEqual(await appSettings.update('app', { autoStart: true }), { username: null, hasPassword: false, autoStart: true, autoShare: null, port: null });
  assert.deepEqual(JSON.parse(await fs.readFile(file(), 'utf8')), { app: { autoStart: true } });
  await appSettings.update('app', { username: 'alice', autoShare: { mode: 'tunnel' } });
  await appSettings.update('app', { autoStart: false });
  assert.deepEqual(JSON.parse(await fs.readFile(file(), 'utf8')), { app: { username: 'alice', autoShare: { mode: 'tunnel', auth: true } } });
  await appSettings.update('app', { username: null, autoShare: null });
  assert.deepEqual(JSON.parse(await fs.readFile(file(), 'utf8')), {});
});

// Invariant: autoShare is stored in the normalised shape a share is made with
// (auth defaults to true, tls kept only for lan and defaulting to on).
test('autoShare is stored normalised, and null clears it', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  assert.deepEqual((await appSettings.update('app', { autoShare: { mode: 'lan' } })).autoShare, { mode: 'lan', auth: true, tls: true });
  assert.deepEqual((await appSettings.update('app', { autoShare: { mode: 'lan', auth: false, tls: false } })).autoShare, { mode: 'lan', auth: false, tls: false });
  assert.deepEqual((await appSettings.update('app', { autoShare: { mode: 'tailscale', tls: true, extra: 1 } })).autoShare, { mode: 'tailscale', auth: true, funnelPort: 443 });
  assert.deepEqual((await appSettings.get('app')).autoShare, { mode: 'tailscale', auth: true, funnelPort: 443 });
  assert.equal((await appSettings.update('app', { autoShare: null })).autoShare, null);
  assert.deepEqual({ ...(await appSettings.readAll()) }, {});
});

// Invariant: a stored auto-share config is refused with exactly the 400
// message a live share with the same options gets — one validation, two
// surfaces — and a refused update leaves the file untouched.
test('a bad autoShare or autoStart is a 400 carrying share()\'s own message, and writes nothing', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await appSettings.update('app', { username: 'alice' });
  const before = await fs.readFile(file(), 'utf8');
  const { validateShareOptions } = await import('../src/shareOptions.js');
  for (const opts of [{ mode: 'ftp' }, {}, { mode: 'lan', auth: 'yes' }, { mode: 'tunnel', auth: false }, { mode: 'tailscale', auth: false }, { mode: 'lan', tls: 1 }, { mode: 'tailscale', funnelPort: 8080 }]) {
    let expected;
    try { validateShareOptions(opts); } catch (e) { expected = e.message; }
    assert.ok(expected, JSON.stringify(opts));
    await assert.rejects(appSettings.update('app', { autoShare: opts }), (e) => e.statusCode === 400 && e.message === expected, JSON.stringify(opts));
  }
  for (const body of [{ autoShare: 'lan' }, { autoShare: ['lan'] }, { autoStart: 'yes' }, { autoStart: null }, { autoStart: true, autoShare: { mode: 'nope' } }]) {
    await assert.rejects(appSettings.update('app', body), (e) => e.statusCode === 400, JSON.stringify(body));
  }
  assert.equal(await fs.readFile(file(), 'utf8'), before);
});

// Invariant: the startup migration renames the old file without changing a
// byte of it, is a no-op once applied, and never destroys either file.
test('migrateLegacyFile: renames share-defaults.json byte-identical at 0600, then no-ops', { skip: process.platform === 'win32' }, async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await fs.mkdir(storeRoot(), { recursive: true });
  const raw = JSON.stringify({ app: { username: 'alice', password: 'pw' } }, null, 2);
  await fs.writeFile(legacyFile(), raw, { mode: 0o644 });
  await fs.chmod(legacyFile(), 0o644);
  await appSettings.migrateLegacyFile();
  assert.equal(await fs.readFile(file(), 'utf8'), raw);
  assert.equal((await fs.stat(file())).mode & 0o777, 0o600);
  await assert.rejects(fs.access(legacyFile()));
  await appSettings.migrateLegacyFile();
  assert.equal(await fs.readFile(file(), 'utf8'), raw);
  assert.deepEqual(await appSettings.get('app'), { username: 'alice', password: 'pw', ...OFF });
});

test('migrateLegacyFile: with both files present touches neither and warns naming both', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await fs.mkdir(storeRoot(), { recursive: true });
  await fs.writeFile(legacyFile(), '{"old":{"username":"o"}}');
  await fs.writeFile(file(), '{"new":{"username":"n"}}');
  const realWarn = console.warn;
  const warnings = [];
  console.warn = (...a) => warnings.push(a.join(' '));
  t.after(() => { console.warn = realWarn; });
  await appSettings.migrateLegacyFile();
  console.warn = realWarn;
  assert.equal(await fs.readFile(legacyFile(), 'utf8'), '{"old":{"username":"o"}}');
  assert.equal(await fs.readFile(file(), 'utf8'), '{"new":{"username":"n"}}');
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes(legacyFile()) && warnings[0].includes(file()), warnings[0]);
});

test('migrateLegacyFile: with neither file present creates nothing', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await appSettings.migrateLegacyFile();
  await assert.rejects(fs.access(file()));
  await assert.rejects(fs.access(legacyFile()));
});

// Invariant: a port is stored in the file, reported by get/describe, and
// clearing a port-only entry deletes it.
test('port round-trips through the file; clearing a port-only entry deletes it', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  assert.deepEqual(await appSettings.update('app', { port: 4100 }), { username: null, hasPassword: false, ...OFF, port: 4100 });
  assert.deepEqual(JSON.parse(await fs.readFile(file(), 'utf8')), { app: { port: 4100 } });
  assert.equal((await appSettings.get('app')).port, 4100);
  assert.deepEqual(await appSettings.update('app', { port: null }), { username: null, hasPassword: false, ...OFF });
  assert.deepEqual({ ...(await appSettings.readAll()) }, {});
});

// Invariant: an entry holding only a port counts as non-empty, so clearing
// another key keeps it, and only clearing its last key deletes the entry.
test('an entry holding only a port is kept; clearing its last key deletes it', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await appSettings.update('app', { username: 'alice' });
  await appSettings.update('app', { port: 4100 });
  await appSettings.update('app', { username: null });
  assert.deepEqual({ ...(await appSettings.readAll()) }, { app: { port: 4100 } });
  await appSettings.update('app', { port: null });
  assert.deepEqual({ ...(await appSettings.readAll()) }, {});
});

// Invariant: an invalid port is refused with a 400 naming the rule, before any
// write.
test('invalid ports are refused before any write', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await appSettings.update('app', { username: 'alice' });
  const before = await fs.readFile(file(), 'utf8');
  for (const port of [1023, 65536, 3000.5, '3000', true, {}]) {
    await assert.rejects(
      appSettings.update('app', { username: 'bob', port }),
      (e) => e.statusCode === 400 && e.message === "'port' must be an integer between 1024 and 65535, or null to clear",
      JSON.stringify(port),
    );
  }
  assert.equal(await fs.readFile(file(), 'utf8'), before);
});
