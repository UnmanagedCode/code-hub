import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { promises as fs } from 'node:fs';
import { createServer } from '../server.js';
import * as appManager from '../src/appManager.js';
import * as shareDefaults from '../src/shareDefaults.js';
import { mkRoot, rmRoot, mkProject, mkWorktree, waitFor, fakeAppCmd, fakeCloudflaredBin, fakeTailscaleBin } from './helpers.mjs';

const basicAuth = (user, pass) => 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

const httpsGet = (port, path, headers = {}) => new Promise((resolve, reject) => {
  const req = https.request({ host: '127.0.0.1', port, path, headers, rejectUnauthorized: false }, (res) => {
    res.resume();
    res.on('end', () => resolve({ status: res.statusCode }));
  });
  req.on('error', reject);
  req.end();
});

async function boot() {
  process.env.CODEHUB_CLOUDFLARED_BIN = fakeCloudflaredBin;
  process.env.CODEHUB_TAILSCALE_BIN = fakeTailscaleBin;
  await appManager.init();
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

const j = async (base, method, path, body) => {
  const r = await fetch(base + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json() };
};

const getApp = async (base, id = 'app') => (await j(base, 'GET', '/api/apps')).body.apps.find((a) => a.id === id);

// Boot a fresh root with one servable project `app`; `running` also starts it.
async function setup(t, { running = true } = {}) {
  const root = await mkRoot();
  await mkProject(root, 'app', { start: fakeAppCmd() }, { git: true });
  const { server, base } = await boot();
  t.after(async () => {
    await appManager.unshare('app').catch(() => {});
    await appManager.stop('app').catch(() => {});
    server.close();
    await rmRoot(root);
  });
  if (running) {
    await j(base, 'POST', '/api/apps/app/start');
    await waitFor(async () => ['ready', 'running'].includes((await getApp(base)).status));
  }
  return { root, server, base };
}

const status = async (port, user, pass) =>
  (await fetch(`http://127.0.0.1:${port}/`, { headers: user ? { authorization: basicAuth(user, pass) } : {} })).status;

test('PUT/GET/DELETE share defaults; GET never returns the password; unknown id → 404; DELETE of unknown id → 200', async (t) => {
  const { base } = await setup(t, { running: false });

  let res = await j(base, 'GET', '/api/apps/app/share/defaults');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { id: 'app', username: null, hasPassword: false });

  res = await j(base, 'PUT', '/api/apps/app/share/defaults', { username: 'alice', password: 'pw-1' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { id: 'app', username: 'alice', hasPassword: true });

  res = await j(base, 'GET', '/api/apps/app/share/defaults');
  assert.deepEqual(res.body, { id: 'app', username: 'alice', hasPassword: true });
  assert.ok(!JSON.stringify(res.body).includes('pw-1'));
  // Nor does the app list leak it.
  const listed = await j(base, 'GET', '/api/apps');
  assert.ok(!JSON.stringify(listed.body).includes('pw-1'));
  assert.deepEqual(listed.body.apps.find((a) => a.id === 'app').shareDefaults, { username: 'alice', hasPassword: true });

  assert.equal((await j(base, 'PUT', '/api/apps/app/share/defaults', { password: '' })).status, 400);
  assert.equal((await j(base, 'PUT', '/api/apps/app/share/defaults', {})).status, 400);

  assert.equal((await j(base, 'GET', '/api/apps/nope/share/defaults')).status, 404);
  assert.equal((await j(base, 'PUT', '/api/apps/nope/share/defaults', { username: 'x' })).status, 404);

  res = await j(base, 'DELETE', '/api/apps/app/share/defaults');
  assert.deepEqual(res.body, { id: 'app', username: null, hasPassword: false });
  assert.equal((await getApp(base)).shareDefaults, null);
  res = await j(base, 'DELETE', '/api/apps/nope/share/defaults');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { id: 'nope', username: null, hasPassword: false });
});

test('defaults persist across appManager.init() (restart)', async (t) => {
  const { base } = await setup(t, { running: false });
  await j(base, 'PUT', '/api/apps/app/share/defaults', { username: 'alice', password: 'pw' });
  await appManager.init(); // simulates a fresh code-hub
  assert.deepEqual((await getApp(base)).shareDefaults, { username: 'alice', hasPassword: true });
});

test('a worktree does not inherit its parent project\'s default', async (t) => {
  const { root, base } = await setup(t, { running: false });
  await mkWorktree(root, 'app', 'feat', { start: fakeAppCmd() }, { git: true });
  await j(base, 'PUT', '/api/apps/app/share/defaults', { username: 'alice', password: 'pw' });
  assert.equal((await getApp(base, 'app:feat')).shareDefaults, null);
  assert.deepEqual((await j(base, 'GET', '/api/apps/app%3Afeat/share/defaults')).body, { id: 'app:feat', username: null, hasPassword: false });
});

test('a LAN share of an app with a default is gated with the default creds', async (t) => {
  const { base } = await setup(t);
  await j(base, 'PUT', '/api/apps/app/share/defaults', { username: 'alice', password: 'pw-default' });

  const res = await j(base, 'POST', '/api/apps/app/share', { mode: 'lan', tls: false });
  assert.equal(res.status, 200);
  assert.equal(res.body.username, 'alice');
  assert.equal(res.body.password, 'pw-default');
  assert.equal(res.body.passwordIsDefault, true);

  const app = await getApp(base);
  assert.equal(app.tunnel.passwordIsDefault, true);
  assert.equal(app.tunnel.password, 'pw-default'); // Copy reads the real value from here
  const pp = app.tunnel.proxyPort;
  assert.equal(await status(pp, 'alice', 'pw-default'), 200);
  assert.equal(await status(pp, 'hub', 'pw-default'), 401);
  assert.equal(await status(pp), 401);
});

test('cloudflared shares apply the default too', async (t) => {
  const { base } = await setup(t);
  await j(base, 'PUT', '/api/apps/app/share/defaults', { username: 'alice', password: 'pw-default' });
  const res = await j(base, 'POST', '/api/apps/app/share', { mode: 'tunnel' });
  assert.equal(res.status, 200);
  assert.equal(res.body.passwordIsDefault, true);
  const app = await getApp(base);
  assert.equal(await status(app.tunnel.proxyPort, 'alice', 'pw-default'), 200);
});

test('tailscale shares apply the default too', async (t) => {
  const { base } = await setup(t);
  await j(base, 'PUT', '/api/apps/app/share/defaults', { username: 'alice', password: 'pw-default' });
  const res = await j(base, 'POST', '/api/apps/app/share', { mode: 'tailscale' });
  assert.equal(res.status, 200);
  assert.equal(res.body.passwordIsDefault, true);
  const app = await getApp(base);
  assert.equal(app.tunnel.passwordIsDefault, true);
  assert.equal(await status(app.tunnel.proxyPort, 'alice', 'pw-default'), 200);
});

test('an app without a default keeps hub + random password, passwordIsDefault false', async (t) => {
  const { base } = await setup(t);
  const res = await j(base, 'POST', '/api/apps/app/share', { mode: 'lan', tls: false });
  assert.equal(res.body.username, 'hub');
  assert.ok(res.body.password.length >= 20);
  assert.equal(res.body.passwordIsDefault, false);
  const app = await getApp(base);
  assert.equal(app.shareDefaults, null);
  assert.equal(app.tunnel.passwordIsDefault, false);
});

test('username-only default → custom user + random pw (not masked); password-only → hub + default pw (masked)', async (t) => {
  const { base } = await setup(t);
  await j(base, 'PUT', '/api/apps/app/share/defaults', { username: 'alice' });
  let res = await j(base, 'POST', '/api/apps/app/share', { mode: 'lan', tls: false });
  assert.equal(res.body.username, 'alice');
  assert.ok(res.body.password.length >= 20);
  assert.equal(res.body.passwordIsDefault, false);
  assert.equal(await status((await getApp(base)).tunnel.proxyPort, 'alice', res.body.password), 200);

  await j(base, 'PUT', '/api/apps/app/share/defaults', { username: null, password: 'pw-only' });
  res = await j(base, 'POST', '/api/apps/app/share', { mode: 'lan', tls: false });
  assert.equal(res.body.username, 'hub');
  assert.equal(res.body.password, 'pw-only');
  assert.equal(res.body.passwordIsDefault, true);
  assert.equal(await status((await getApp(base)).tunnel.proxyPort, 'hub', 'pw-only'), 200);
});

test('a share-time password edit clears passwordIsDefault and never touches the stored default', async (t) => {
  const { base } = await setup(t);
  await j(base, 'PUT', '/api/apps/app/share/defaults', { username: 'alice', password: 'pw-default' });
  await j(base, 'POST', '/api/apps/app/share', { mode: 'lan', tls: false });

  // A username-only edit keeps the default password, so it stays masked.
  let res = await j(base, 'PATCH', '/api/apps/app/share/credentials', { username: 'bob' });
  assert.equal(res.body.passwordIsDefault, true);

  res = await j(base, 'PATCH', '/api/apps/app/share/credentials', { password: 'edited' });
  assert.equal(res.status, 200);
  assert.equal(res.body.passwordIsDefault, false);
  assert.equal((await getApp(base)).tunnel.passwordIsDefault, false);
  assert.deepEqual((await j(base, 'GET', '/api/apps/app/share/defaults')).body, { id: 'app', username: 'alice', hasPassword: true });

  await j(base, 'DELETE', '/api/apps/app/share');
  res = await j(base, 'POST', '/api/apps/app/share', { mode: 'lan', tls: false });
  assert.equal(res.body.passwordIsDefault, true);
  assert.equal(await status((await getApp(base)).tunnel.proxyPort, 'alice', 'pw-default'), 200);
});

test('a TLS re-share returns to the default login', async (t) => {
  const { base } = await setup(t);
  await j(base, 'PUT', '/api/apps/app/share/defaults', { username: 'alice', password: 'pw-default' });
  await j(base, 'POST', '/api/apps/app/share', { mode: 'lan', tls: false });
  await j(base, 'PATCH', '/api/apps/app/share/credentials', { password: 'edited' });

  const res = await j(base, 'POST', '/api/apps/app/share', { mode: 'lan', tls: true });
  assert.equal(res.body.tls, true);
  assert.equal(res.body.passwordIsDefault, true);
  const app = await getApp(base);
  assert.equal(app.tunnel.passwordIsDefault, true);
  assert.equal((await httpsGet(app.tunnel.proxyPort, '/', { authorization: basicAuth('alice', 'pw-default') })).status, 200);
  assert.equal((await httpsGet(app.tunnel.proxyPort, '/', { authorization: basicAuth('alice', 'edited') })).status, 401);
});

test('changing the default while shared leaves the live share\'s password (still masked)', async (t) => {
  const { base } = await setup(t);
  await j(base, 'PUT', '/api/apps/app/share/defaults', { username: 'alice', password: 'pw-old' });
  await j(base, 'POST', '/api/apps/app/share', { mode: 'lan', tls: false });
  await j(base, 'PUT', '/api/apps/app/share/defaults', { password: 'pw-new' });

  const app = await getApp(base);
  assert.equal(app.tunnel.passwordIsDefault, true);
  assert.equal(app.tunnel.password, 'pw-old');
  assert.equal(await status(app.tunnel.proxyPort, 'alice', 'pw-old'), 200);
  assert.equal(await status(app.tunnel.proxyPort, 'alice', 'pw-new'), 401);
});

test('LAN auth:false share of an app with a default gates with the default once auth is enabled', async (t) => {
  const { base } = await setup(t);
  await j(base, 'PUT', '/api/apps/app/share/defaults', { username: 'alice', password: 'pw-default' });
  const res = await j(base, 'POST', '/api/apps/app/share', { mode: 'lan', auth: false, tls: false });
  assert.equal(res.status, 200);
  let app = await getApp(base);
  assert.equal(app.tunnel.passwordIsDefault, false); // nothing to mask while ungated
  assert.equal(await status(app.tunnel.proxyPort), 200);

  assert.equal((await j(base, 'PATCH', '/api/apps/app/share/auth', { enabled: true })).status, 200);
  app = await getApp(base);
  assert.equal(app.tunnel.username, 'alice');
  assert.equal(app.tunnel.passwordIsDefault, true);
  assert.equal(await status(app.tunnel.proxyPort), 401);
  assert.equal(await status(app.tunnel.proxyPort, 'alice', 'pw-default'), 200);
});

test('a 404 PUT for an unknown id writes nothing', async (t) => {
  const { base } = await setup(t, { running: false });
  await j(base, 'PUT', '/api/apps/app/share/defaults', { username: 'alice' });
  const before = await shareDefaults.readAll();
  assert.equal((await j(base, 'PUT', '/api/apps/nope/share/defaults', { password: 'pw' })).status, 404);
  assert.deepEqual(await shareDefaults.readAll(), before);
});

test('DELETE removes an orphaned entry for an id that is no known app', async (t) => {
  const { base } = await setup(t, { running: false });
  await shareDefaults.update('orphan', { password: 'pw' });
  await shareDefaults.update('app', { username: 'alice' });
  const res = await j(base, 'DELETE', '/api/apps/orphan/share/defaults');
  assert.equal(res.status, 200);
  assert.deepEqual({ ...(await shareDefaults.readAll()) }, { app: { username: 'alice' } });
});

for (const mode of ['lan', 'tunnel', 'tailscale']) {
  test(`unsharing a ${mode} share clears passwordIsDefault: a re-share without a default password is not masked`, async (t) => {
    const { base } = await setup(t);
    const body = mode === 'lan' ? { mode, tls: false } : { mode };
    await j(base, 'PUT', '/api/apps/app/share/defaults', { username: 'alice', password: 'pw-default' });
    assert.equal((await j(base, 'POST', '/api/apps/app/share', body)).body.passwordIsDefault, true);
    await j(base, 'DELETE', '/api/apps/app/share');
    await j(base, 'PUT', '/api/apps/app/share/defaults', { password: null });
    const res = await j(base, 'POST', '/api/apps/app/share', body);
    assert.equal(res.status, 200);
    assert.equal(res.body.username, 'alice');
    assert.equal(res.body.passwordIsDefault, false);
    assert.equal((await getApp(base)).tunnel.passwordIsDefault, false);
  });
}

test('prototype-named app ids: unknown ones 404, real ones store and list their own entry only', async (t) => {
  const { root, base } = await setup(t, { running: false });
  // Not projects (yet): Object.prototype must not make them "known".
  assert.equal((await j(base, 'GET', '/api/apps/constructor/share/defaults')).status, 404);
  assert.equal((await j(base, 'GET', '/api/apps/__proto__/share/defaults')).status, 404);
  assert.equal((await j(base, 'PUT', '/api/apps/__proto__/share/defaults', { password: 'pw' })).status, 404);

  await mkProject(root, 'constructor', { start: fakeAppCmd() });
  await mkProject(root, '__proto__', { start: fakeAppCmd() });
  assert.equal((await getApp(base, 'constructor')).shareDefaults, null);
  assert.equal((await getApp(base, '__proto__')).shareDefaults, null);
  // list() must not treat Object.prototype as `__proto__`'s running record —
  // tearing that "record" down would write Object.prototype.tunnel.
  assert.equal((await getApp(base, '__proto__')).status, 'stopped');
  assert.ok(!Object.hasOwn(Object.prototype, 'tunnel'));

  const put = await j(base, 'PUT', '/api/apps/__proto__/share/defaults', { password: 'pw' });
  assert.deepEqual(put.body, { id: '__proto__', username: null, hasPassword: true });
  assert.deepEqual((await j(base, 'GET', '/api/apps/__proto__/share/defaults')).body, { id: '__proto__', username: null, hasPassword: true });
  assert.deepEqual((await getApp(base, '__proto__')).shareDefaults, { username: null, hasPassword: true });
  assert.equal((await getApp(base, 'constructor')).shareDefaults, null);
});

const PATCH_CREDS = '/api/apps/app/share/credentials';
const shareBody = (mode) => (mode === 'lan' ? { mode, tls: false } : { mode });

// Invariant: after a ticked Save, the live login equals the stored default and
// is masked, whatever the share mode.
for (const mode of ['lan', 'tunnel', 'tailscale']) {
  test(`saveAsDefault on a ${mode} share stores the typed login and masks it`, async (t) => {
    const { base } = await setup(t);
    await j(base, 'POST', '/api/apps/app/share', shareBody(mode));
    const res = await j(base, 'PATCH', PATCH_CREDS, { username: 'carol', password: 'pinned', saveAsDefault: true });
    assert.equal(res.status, 200);
    assert.equal(res.body.passwordIsDefault, true);
    const app = await getApp(base);
    assert.equal(app.tunnel.passwordIsDefault, true);
    assert.deepEqual(app.shareDefaults, { username: 'carol', hasPassword: true });
    assert.deepEqual((await j(base, 'GET', '/api/apps/app/share/defaults')).body, { id: 'app', username: 'carol', hasPassword: true });
    assert.equal((await shareDefaults.readAll()).app.password, 'pinned');
    assert.equal(await status(app.tunnel.proxyPort, 'carol', 'pinned'), 200);
  });
}

// Invariant: the effective login includes an untouched generated password, and
// a flag-only body is valid.
test('{ saveAsDefault: true } alone pins the share\'s generated login as the default', async (t) => {
  const { base } = await setup(t);
  const shared = (await j(base, 'POST', '/api/apps/app/share', shareBody('lan'))).body;
  assert.equal(shared.passwordIsDefault, false);
  const res = await j(base, 'PATCH', PATCH_CREDS, { saveAsDefault: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.passwordIsDefault, true);
  assert.equal(res.body.password, shared.password);
  assert.deepEqual({ ...(await shareDefaults.readAll()).app }, { username: 'hub', password: shared.password });
  assert.equal((await getApp(base)).tunnel.passwordIsDefault, true);
});

// Invariant: a blank password with the box ticked keeps the share's password.
test('saveAsDefault with only a username keeps a default-seeded share\'s stored password', async (t) => {
  const { base } = await setup(t);
  await j(base, 'PUT', '/api/apps/app/share/defaults', { username: 'alice', password: 'pw-default' });
  await j(base, 'POST', '/api/apps/app/share', shareBody('lan'));
  const res = await j(base, 'PATCH', PATCH_CREDS, { username: 'bob', saveAsDefault: true });
  assert.equal(res.body.passwordIsDefault, true);
  assert.deepEqual({ ...(await shareDefaults.readAll()).app }, { username: 'bob', password: 'pw-default' });
  assert.equal(await status((await getApp(base)).tunnel.proxyPort, 'bob', 'pw-default'), 200);
});

// Invariant: the stored default becomes what the share uses, so the mask stays truthful.
test('saveAsDefault after the default changed mid-share stores the share\'s live password', async (t) => {
  const { base } = await setup(t);
  await j(base, 'PUT', '/api/apps/app/share/defaults', { username: 'alice', password: 'pw-old' });
  await j(base, 'POST', '/api/apps/app/share', shareBody('lan'));
  await j(base, 'PUT', '/api/apps/app/share/defaults', { password: 'pw-new' });
  const res = await j(base, 'PATCH', PATCH_CREDS, { saveAsDefault: true });
  assert.equal(res.body.passwordIsDefault, true);
  assert.equal((await shareDefaults.readAll()).app.password, 'pw-old');
  assert.equal(await status((await getApp(base)).tunnel.proxyPort, 'alice', 'pw-old'), 200);
});

// Invariant: an unticked Save leaves share-defaults.json untouched.
test('saveAsDefault: false edits the share only and never writes the default', async (t) => {
  const { base } = await setup(t);
  await j(base, 'PUT', '/api/apps/app/share/defaults', { username: 'alice', password: 'pw-default' });
  await j(base, 'POST', '/api/apps/app/share', shareBody('lan'));
  const before = await shareDefaults.readAll();
  const res = await j(base, 'PATCH', PATCH_CREDS, { password: 'x', saveAsDefault: false });
  assert.equal(res.status, 200);
  assert.equal(res.body.passwordIsDefault, false);
  assert.deepEqual(await shareDefaults.readAll(), before);
});

// Invariant: a rejected request is side-effect free.
test('rejected saveAsDefault requests write nothing and leave the live login', async (t) => {
  const { base } = await setup(t);
  await j(base, 'PUT', '/api/apps/app/share/defaults', { username: 'alice', password: 'pw-default' });
  const before = await shareDefaults.readAll();

  assert.equal((await j(base, 'PATCH', PATCH_CREDS, { saveAsDefault: true })).status, 409); // no share

  await j(base, 'POST', '/api/apps/app/share', shareBody('lan'));
  let res = await j(base, 'PATCH', PATCH_CREDS, { password: 'x', saveAsDefault: 'yes' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /saveAsDefault/);
  assert.equal((await j(base, 'PATCH', PATCH_CREDS, { saveAsDefault: false })).status, 400);
  assert.equal((await j(base, 'PATCH', PATCH_CREDS, { password: '', saveAsDefault: true })).status, 400);
  assert.deepEqual(await shareDefaults.readAll(), before);
  assert.equal(await status((await getApp(base)).tunnel.proxyPort, 'alice', 'pw-default'), 200);

  await j(base, 'POST', '/api/apps/app/share', { mode: 'lan', auth: false, tls: false });
  assert.equal((await j(base, 'PATCH', PATCH_CREDS, { saveAsDefault: true })).status, 400);
  assert.deepEqual(await shareDefaults.readAll(), before);
  assert.equal(await status((await getApp(base)).tunnel.proxyPort), 200);
});

// Invariant: a ticked Save is all-or-nothing — the proxy and the mask aren't
// touched until the default is written.
test('a failed default write returns 500 and leaves the live login and mask untouched', async (t) => {
  const { base } = await setup(t);
  const { password } = (await j(base, 'POST', '/api/apps/app/share', shareBody('lan'))).body; // generated, unmasked
  await j(base, 'PUT', '/api/apps/app/share/defaults', { username: 'alice', password: 'pw-default' });
  const pp = (await getApp(base)).tunnel.proxyPort;
  // A directory where the file belongs: reading it fails with EISDIR, even as root.
  await fs.rm(shareDefaults.shareDefaultsFile());
  await fs.mkdir(shareDefaults.shareDefaultsFile());
  const res = await j(base, 'PATCH', PATCH_CREDS, { saveAsDefault: true });
  assert.equal(res.status, 500);
  assert.match(res.body.error, /default share login/);
  assert.equal(await status(pp, 'hub', password), 200);
  await fs.rm(shareDefaults.shareDefaultsFile(), { recursive: true }); // list() reads the file
  assert.equal((await getApp(base)).tunnel.passwordIsDefault, false);
});

// Hold share-defaults.json's publishing rename until release() is called:
// `reached` resolves once a write is parked there. Restored after the test.
function gateDefaultsWrite(t) {
  const realRename = fs.rename;
  let release, reached;
  const gate = new Promise((r) => { release = r; });
  const parked = new Promise((r) => { reached = r; });
  fs.rename = async (from, to) => {
    if (to === shareDefaults.shareDefaultsFile()) { reached(); await gate; }
    return realRename(from, to);
  };
  t.after(() => { fs.rename = realRename; });
  return { parked, release };
}

// Invariant: whatever interleaves with a ticked Save, passwordIsDefault is true
// only while the live password is the stored default, and then that stored
// pair is the one the proxy accepts.
test('an unflagged password edit during a ticked Save cannot leave a false mask', async (t) => {
  const { base } = await setup(t);
  await j(base, 'POST', '/api/apps/app/share', shareBody('lan'));
  const { parked, release } = gateDefaultsWrite(t);
  const ticked = j(base, 'PATCH', PATCH_CREDS, { saveAsDefault: true });
  await parked;
  assert.equal((await j(base, 'PATCH', PATCH_CREDS, { password: 'z' })).status, 200);
  release();
  assert.equal((await ticked).status, 200);

  const app = await getApp(base);
  const stored = (await shareDefaults.readAll()).app;
  assert.equal(app.tunnel.passwordIsDefault, app.tunnel.password === stored.password);
  if (app.tunnel.passwordIsDefault) {
    assert.equal(app.tunnel.username, stored.username);
    assert.equal(await status(app.tunnel.proxyPort, stored.username, stored.password), 200);
  }
});

// Invariant: a share that replaces (or ends) the edited one mid-write is never
// mutated or flagged; the requested default is still written, and the PATCH
// fails with a clean 409.
test('a ticked Save whose share is unshared mid-write returns 409 and keeps the default', async (t) => {
  const { base } = await setup(t);
  const { password } = (await j(base, 'POST', '/api/apps/app/share', shareBody('lan'))).body;
  const { parked, release } = gateDefaultsWrite(t);
  const ticked = j(base, 'PATCH', PATCH_CREDS, { username: 'carol', saveAsDefault: true });
  await parked;
  assert.equal((await j(base, 'DELETE', '/api/apps/app/share')).status, 200);
  release();
  const res = await ticked;
  assert.equal(res.status, 409);
  assert.match(res.body.error, /share ended/);
  assert.deepEqual({ ...(await shareDefaults.readAll()).app }, { username: 'carol', password });
  assert.equal((await getApp(base)).tunnel, null);
});

test('a ticked Save whose share is replaced mid-write returns 409 and leaves the new share alone', async (t) => {
  const { base } = await setup(t);
  const { password } = (await j(base, 'POST', '/api/apps/app/share', shareBody('lan'))).body;
  const { parked, release } = gateDefaultsWrite(t);
  const ticked = j(base, 'PATCH', PATCH_CREDS, { username: 'carol', saveAsDefault: true });
  await parked;
  const fresh = (await j(base, 'POST', '/api/apps/app/share', shareBody('lan'))).body; // read the file before the rename
  assert.equal(fresh.passwordIsDefault, false);
  release();
  const res = await ticked;
  assert.equal(res.status, 409);
  assert.match(res.body.error, /share ended/);
  assert.deepEqual({ ...(await shareDefaults.readAll()).app }, { username: 'carol', password });
  const app = await getApp(base);
  assert.equal(app.tunnel.passwordIsDefault, false);
  assert.equal(app.tunnel.username, fresh.username);
  assert.equal(app.tunnel.password, fresh.password);
  assert.equal(await status(app.tunnel.proxyPort, fresh.username, fresh.password), 200);
});

// Invariant: after a ticked TLS Save (re-share, then flagged PATCH), the new
// share's login equals the saved default, and later shares start from it.
test('the UI\'s ticked TLS Save — re-share then saveAsDefault — pins the new share\'s login', async (t) => {
  const { base } = await setup(t);
  const { username, password } = (await j(base, 'POST', '/api/apps/app/share', shareBody('lan'))).body;
  assert.equal((await j(base, 'POST', '/api/apps/app/share', { mode: 'lan', tls: true })).status, 200);
  const res = await j(base, 'PATCH', PATCH_CREDS, { username, password, saveAsDefault: true });
  assert.equal(res.body.passwordIsDefault, true);
  let app = await getApp(base);
  assert.equal((await httpsGet(app.tunnel.proxyPort, '/', { authorization: basicAuth(username, password) })).status, 200);
  assert.deepEqual({ ...(await shareDefaults.readAll()).app }, { username, password });

  await j(base, 'DELETE', '/api/apps/app/share');
  const again = await j(base, 'POST', '/api/apps/app/share', shareBody('lan'));
  assert.equal(again.body.passwordIsDefault, true);
  app = await getApp(base);
  assert.equal(await status(app.tunnel.proxyPort, username, password), 200);
});
