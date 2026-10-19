import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { promises as fs } from 'node:fs';
import { createServer } from '../server.js';
import * as appManager from '../src/appManager.js';
import * as appSettings from '../src/appSettings.js';
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

const OFF = { autoStart: false, autoShare: null, port: null };
const NONE = { username: null, hasPassword: false, ...OFF };

const status = async (port, user, pass) =>
  (await fetch(`http://127.0.0.1:${port}/`, { headers: user ? { authorization: basicAuth(user, pass) } : {} })).status;

test('PUT/GET/DELETE app settings; GET never returns the password; unknown id → 404; DELETE of unknown id → 200', async (t) => {
  const { base } = await setup(t, { running: false });

  let res = await j(base, 'GET', '/api/apps/app/settings');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { id: 'app', username: null, hasPassword: false, ...OFF });

  res = await j(base, 'PUT', '/api/apps/app/settings', { username: 'alice', password: 'pw-1' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { id: 'app', username: 'alice', hasPassword: true, ...OFF });

  res = await j(base, 'GET', '/api/apps/app/settings');
  assert.deepEqual(res.body, { id: 'app', username: 'alice', hasPassword: true, ...OFF });
  assert.ok(!JSON.stringify(res.body).includes('pw-1'));
  // Nor does the app list leak it.
  const listed = await j(base, 'GET', '/api/apps');
  assert.ok(!JSON.stringify(listed.body).includes('pw-1'));
  assert.deepEqual(listed.body.apps.find((a) => a.id === 'app').settings, { username: 'alice', hasPassword: true, ...OFF });

  assert.equal((await j(base, 'PUT', '/api/apps/app/settings', { password: '' })).status, 400);
  assert.equal((await j(base, 'PUT', '/api/apps/app/settings', {})).status, 400);

  assert.equal((await j(base, 'GET', '/api/apps/nope/settings')).status, 404);
  assert.equal((await j(base, 'PUT', '/api/apps/nope/settings', { username: 'x' })).status, 404);

  res = await j(base, 'DELETE', '/api/apps/app/settings');
  assert.deepEqual(res.body, { id: 'app', username: null, hasPassword: false, ...OFF });
  assert.deepEqual((await getApp(base)).settings, NONE);
  res = await j(base, 'DELETE', '/api/apps/nope/settings');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { id: 'nope', username: null, hasPassword: false, ...OFF });
});

test('settings persist across appManager.init() (restart)', async (t) => {
  const { base } = await setup(t, { running: false });
  await j(base, 'PUT', '/api/apps/app/settings', { username: 'alice', password: 'pw' });
  await appManager.init(); // simulates a fresh code-hub
  assert.deepEqual((await getApp(base)).settings, { username: 'alice', hasPassword: true, ...OFF });
});

test('a worktree does not inherit its parent project\'s default', async (t) => {
  const { root, base } = await setup(t, { running: false });
  await mkWorktree(root, 'app', 'feat', { start: fakeAppCmd() }, { git: true });
  await j(base, 'PUT', '/api/apps/app/settings', { username: 'alice', password: 'pw' });
  assert.deepEqual((await getApp(base, 'app:feat')).settings, NONE);
  assert.deepEqual((await j(base, 'GET', '/api/apps/app%3Afeat/settings')).body, { id: 'app:feat', username: null, hasPassword: false, ...OFF });
});

test('a LAN share of an app with a default is gated with the default creds', async (t) => {
  const { base } = await setup(t);
  await j(base, 'PUT', '/api/apps/app/settings', { username: 'alice', password: 'pw-default' });

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
  await j(base, 'PUT', '/api/apps/app/settings', { username: 'alice', password: 'pw-default' });
  const res = await j(base, 'POST', '/api/apps/app/share', { mode: 'tunnel' });
  assert.equal(res.status, 200);
  assert.equal(res.body.passwordIsDefault, true);
  const app = await getApp(base);
  assert.equal(await status(app.tunnel.proxyPort, 'alice', 'pw-default'), 200);
});

test('tailscale shares apply the default too', async (t) => {
  const { base } = await setup(t);
  await j(base, 'PUT', '/api/apps/app/settings', { username: 'alice', password: 'pw-default' });
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
  assert.deepEqual(app.settings, NONE);
  assert.equal(app.tunnel.passwordIsDefault, false);
});

test('username-only default → custom user + random pw (not masked); password-only → hub + default pw (masked)', async (t) => {
  const { base } = await setup(t);
  await j(base, 'PUT', '/api/apps/app/settings', { username: 'alice' });
  let res = await j(base, 'POST', '/api/apps/app/share', { mode: 'lan', tls: false });
  assert.equal(res.body.username, 'alice');
  assert.ok(res.body.password.length >= 20);
  assert.equal(res.body.passwordIsDefault, false);
  assert.equal(await status((await getApp(base)).tunnel.proxyPort, 'alice', res.body.password), 200);

  await j(base, 'PUT', '/api/apps/app/settings', { username: null, password: 'pw-only' });
  res = await j(base, 'POST', '/api/apps/app/share', { mode: 'lan', tls: false });
  assert.equal(res.body.username, 'hub');
  assert.equal(res.body.password, 'pw-only');
  assert.equal(res.body.passwordIsDefault, true);
  assert.equal(await status((await getApp(base)).tunnel.proxyPort, 'hub', 'pw-only'), 200);
});

test('a share-time password edit clears passwordIsDefault and never touches the stored login', async (t) => {
  const { base } = await setup(t);
  await j(base, 'PUT', '/api/apps/app/settings', { username: 'alice', password: 'pw-default' });
  await j(base, 'POST', '/api/apps/app/share', { mode: 'lan', tls: false });

  // A username-only edit keeps the default password, so it stays masked.
  let res = await j(base, 'PATCH', '/api/apps/app/share/credentials', { username: 'bob' });
  assert.equal(res.body.passwordIsDefault, true);

  res = await j(base, 'PATCH', '/api/apps/app/share/credentials', { password: 'edited' });
  assert.equal(res.status, 200);
  assert.equal(res.body.passwordIsDefault, false);
  assert.equal((await getApp(base)).tunnel.passwordIsDefault, false);
  assert.deepEqual((await j(base, 'GET', '/api/apps/app/settings')).body, { id: 'app', username: 'alice', hasPassword: true, ...OFF });

  await j(base, 'DELETE', '/api/apps/app/share');
  res = await j(base, 'POST', '/api/apps/app/share', { mode: 'lan', tls: false });
  assert.equal(res.body.passwordIsDefault, true);
  assert.equal(await status((await getApp(base)).tunnel.proxyPort, 'alice', 'pw-default'), 200);
});

test('a TLS re-share returns to the default login', async (t) => {
  const { base } = await setup(t);
  await j(base, 'PUT', '/api/apps/app/settings', { username: 'alice', password: 'pw-default' });
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
  await j(base, 'PUT', '/api/apps/app/settings', { username: 'alice', password: 'pw-old' });
  await j(base, 'POST', '/api/apps/app/share', { mode: 'lan', tls: false });
  await j(base, 'PUT', '/api/apps/app/settings', { password: 'pw-new' });

  const app = await getApp(base);
  assert.equal(app.tunnel.passwordIsDefault, true);
  assert.equal(app.tunnel.password, 'pw-old');
  assert.equal(await status(app.tunnel.proxyPort, 'alice', 'pw-old'), 200);
  assert.equal(await status(app.tunnel.proxyPort, 'alice', 'pw-new'), 401);
});

test('LAN auth:false share of an app with a default gates with the default once auth is enabled', async (t) => {
  const { base } = await setup(t);
  await j(base, 'PUT', '/api/apps/app/settings', { username: 'alice', password: 'pw-default' });
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
  await j(base, 'PUT', '/api/apps/app/settings', { username: 'alice' });
  const before = await appSettings.readAll();
  assert.equal((await j(base, 'PUT', '/api/apps/nope/settings', { password: 'pw' })).status, 404);
  assert.deepEqual(await appSettings.readAll(), before);
});

test('DELETE removes an orphaned entry for an id that is no known app', async (t) => {
  const { base } = await setup(t, { running: false });
  await appSettings.update('orphan', { password: 'pw' });
  await appSettings.update('app', { username: 'alice' });
  const res = await j(base, 'DELETE', '/api/apps/orphan/settings');
  assert.equal(res.status, 200);
  assert.deepEqual({ ...(await appSettings.readAll()) }, { app: { username: 'alice' } });
});

for (const mode of ['lan', 'tunnel', 'tailscale']) {
  test(`unsharing a ${mode} share clears passwordIsDefault: a re-share without a default password is not masked`, async (t) => {
    const { base } = await setup(t);
    const body = mode === 'lan' ? { mode, tls: false } : { mode };
    await j(base, 'PUT', '/api/apps/app/settings', { username: 'alice', password: 'pw-default' });
    assert.equal((await j(base, 'POST', '/api/apps/app/share', body)).body.passwordIsDefault, true);
    await j(base, 'DELETE', '/api/apps/app/share');
    await j(base, 'PUT', '/api/apps/app/settings', { password: null });
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
  assert.equal((await j(base, 'GET', '/api/apps/constructor/settings')).status, 404);
  assert.equal((await j(base, 'GET', '/api/apps/__proto__/settings')).status, 404);
  assert.equal((await j(base, 'PUT', '/api/apps/__proto__/settings', { password: 'pw' })).status, 404);

  await mkProject(root, 'constructor', { start: fakeAppCmd() });
  await mkProject(root, '__proto__', { start: fakeAppCmd() });
  assert.deepEqual((await getApp(base, 'constructor')).settings, NONE);
  assert.deepEqual((await getApp(base, '__proto__')).settings, NONE);
  // list() must not treat Object.prototype as `__proto__`'s running record —
  // tearing that "record" down would write Object.prototype.tunnel.
  assert.equal((await getApp(base, '__proto__')).status, 'stopped');
  assert.ok(!Object.hasOwn(Object.prototype, 'tunnel'));

  const put = await j(base, 'PUT', '/api/apps/__proto__/settings', { password: 'pw' });
  assert.deepEqual(put.body, { id: '__proto__', username: null, hasPassword: true, ...OFF });
  assert.deepEqual((await j(base, 'GET', '/api/apps/__proto__/settings')).body, { id: '__proto__', username: null, hasPassword: true, ...OFF });
  assert.deepEqual((await getApp(base, '__proto__')).settings, { username: null, hasPassword: true, ...OFF });
  assert.deepEqual((await getApp(base, 'constructor')).settings, NONE);
});

// Invariant: the settings endpoint round-trips both toggles, stored normalised,
// and neither its answer nor the listing ever carries the password.
test('PUT then GET round-trips autoStart and autoShare; neither GET nor the listing leaks the password', async (t) => {
  const { base } = await setup(t, { running: false });
  const put = await j(base, 'PUT', '/api/apps/app/settings', { password: 'pw-secret', autoStart: true, autoShare: { mode: 'lan', tls: false }, port: 4100 });
  assert.equal(put.status, 200);
  // Invariant: the endpoint and the listing agree on the stored port.
  const want = { id: 'app', username: null, hasPassword: true, autoStart: true, autoShare: { mode: 'lan', auth: true, tls: false }, port: 4100 };
  assert.deepEqual(put.body, want);
  const got = await j(base, 'GET', '/api/apps/app/settings');
  assert.deepEqual(got.body, want);
  const { id: _id, ...listed } = want;
  assert.deepEqual((await getApp(base)).settings, listed);
  assert.ok(!JSON.stringify(got.body).includes('pw-secret'));
  assert.ok(!JSON.stringify((await j(base, 'GET', '/api/apps')).body).includes('pw-secret'));
  assert.equal((await j(base, 'PUT', '/api/apps/app/settings', { autoShare: { mode: 'tunnel', auth: false } })).status, 400);
  assert.deepEqual((await j(base, 'GET', '/api/apps/app/settings')).body, want);
});

// Invariant: the toggles are main-checkout-only and refused for a worktree
// before anything is written, while its own default login stays settable and
// clearing a toggle is always allowed.
test('a worktree id refuses autoStart/autoShare with a 400 naming the rule, but takes a login', async (t) => {
  const { root, base } = await setup(t, { running: false });
  await mkWorktree(root, 'app', 'feat', { start: fakeAppCmd() }, { git: true });
  await j(base, 'PUT', '/api/apps/app%3Afeat/settings', { username: 'wt-user' });
  const before = await fs.readFile(appSettings.appSettingsFile(), 'utf8');
  for (const body of [{ autoStart: true }, { autoShare: { mode: 'lan' } }, { username: 'x', autoStart: true }, { port: 4100 }, { username: 'x', port: 4100 }]) {
    const res = await j(base, 'PUT', '/api/apps/app%3Afeat/settings', body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match(res.body.error, /only to a project's main checkout — 'app:feat' is a worktree/);
  }
  assert.equal(await fs.readFile(appSettings.appSettingsFile(), 'utf8'), before);
  assert.equal((await j(base, 'PUT', '/api/apps/app%3Afeat/settings', { autoStart: false, autoShare: null, port: null })).status, 200);
  const res = await j(base, 'PUT', '/api/apps/app%3Afeat/settings', { username: 'wt-user2' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { id: 'app:feat', username: 'wt-user2', hasPassword: false, ...OFF });
});

// Invariant: the live share's credentials edit no longer writes the stored
// login — a leftover saveAsDefault flag is ignored.
test('PATCH share/credentials with saveAsDefault leaves the stored settings unchanged', async (t) => {
  const { base } = await setup(t);
  await j(base, 'PUT', '/api/apps/app/settings', { username: 'alice', password: 'pw-default' });
  await j(base, 'POST', '/api/apps/app/share', { mode: 'lan', tls: false });
  const before = await fs.readFile(appSettings.appSettingsFile(), 'utf8');
  const res = await j(base, 'PATCH', '/api/apps/app/share/credentials', { username: 'carol', password: 'typed', saveAsDefault: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.passwordIsDefault, false);
  assert.equal(await fs.readFile(appSettings.appSettingsFile(), 'utf8'), before);
  assert.equal((await j(base, 'PATCH', '/api/apps/app/share/credentials', { saveAsDefault: true })).status, 400);
});

// Invariant: every listed app carries a settings object, toggles off when it
// has no entry at all.
test('the listing\'s settings is always an object, toggles off for an app with no entry', async (t) => {
  const { base } = await setup(t, { running: false });
  await assert.rejects(fs.access(appSettings.appSettingsFile()));
  assert.deepEqual((await getApp(base)).settings, NONE);
});

// Invariant: the listing exposes the manifest's port beside the stored setting,
// and a worktree has no manifest port.
test('the listing exposes the manifest port beside the settings port', async (t) => {
  const { root, base } = await setup(t, { running: false });
  await mkProject(root, 'pinned', { start: fakeAppCmd(), port: 4200 }, { git: true });
  await mkWorktree(root, 'pinned', 'feat', { start: fakeAppCmd(), port: 4200 }, { git: true });
  await j(base, 'PUT', '/api/apps/pinned/settings', { port: 4300 });
  const main = await getApp(base, 'pinned');
  assert.equal(main.manifestPort, 4200);
  assert.equal(main.settings.port, 4300);
  assert.equal((await getApp(base, 'pinned:feat')).manifestPort, null);
  assert.equal((await getApp(base)).manifestPort, null);
});
