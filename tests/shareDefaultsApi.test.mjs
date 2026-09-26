import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { createServer } from '../server.js';
import * as appManager from '../src/appManager.js';
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
