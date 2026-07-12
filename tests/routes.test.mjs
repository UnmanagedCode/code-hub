import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createServer } from '../server.js';
import * as appManager from '../src/appManager.js';
import { storeRoot } from '../src/projects.js';
import { mkRoot, rmRoot, mkProject, gitCommit, waitFor, fakeAppCmd, fakeCloudflaredBin, pidAlive } from './helpers.mjs';

const basicAuth = (user, pass) => 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

async function boot(root) {
  process.env.CODEHUB_CLOUDFLARED_BIN = fakeCloudflaredBin;
  await appManager.init();
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base };
}

const j = async (base, method, path, body) => {
  const r = await fetch(base + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json() };
};

test('full lifecycle over HTTP: discover → start → share → out-of-date → stop', async (t) => {
  const root = await mkRoot();
  const dir = await mkProject(root, 'app', { start: fakeAppCmd() }, { git: true });
  const { server, base } = await boot(root);
  t.after(async () => { await appManager.stop('app').catch(() => {}); server.close(); await rmRoot(root); });

  // health
  let res = await j(base, 'GET', '/api/health');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });

  // discover
  res = await j(base, 'GET', '/api/apps');
  assert.equal(res.status, 200);
  assert.equal(res.body.cloudflaredAvailable, true);
  const app0 = res.body.apps.find((a) => a.id === 'app');
  assert.equal(app0.status, 'stopped');

  // start
  res = await j(base, 'POST', '/api/apps/app/start');
  assert.equal(res.status, 200);
  assert.ok(res.body.port);

  await waitFor(async () => {
    const { body } = await j(base, 'GET', '/api/apps');
    return ['ready', 'running'].includes(body.apps.find((a) => a.id === 'app').status);
  });
  res = await j(base, 'GET', '/api/apps');
  const running = res.body.apps.find((a) => a.id === 'app');
  assert.ok(running.urls.some((u) => u.startsWith('http://localhost:')));
  assert.equal(running.outOfDate, false);

  // share
  res = await j(base, 'POST', '/api/apps/app/share');
  assert.equal(res.status, 200);
  assert.match(res.body.url, /trycloudflare\.com$/);
  assert.match(res.body.qrSvg, /<svg/);

  // out-of-date after a new commit in the source dir
  gitCommit(dir);
  await waitFor(async () => {
    const { body } = await j(base, 'GET', '/api/apps');
    return body.apps.find((a) => a.id === 'app').outOfDate === true;
  });

  // stop (also tears down the tunnel)
  res = await j(base, 'POST', '/api/apps/app/stop');
  assert.equal(res.status, 200);
  await waitFor(async () => {
    const { body } = await j(base, 'GET', '/api/apps');
    return body.apps.find((a) => a.id === 'app').status === 'stopped';
  });
});

test('unknown app id → 404, and share on a stopped app → 409', async (t) => {
  const root = await mkRoot();
  await mkProject(root, 'app', { start: fakeAppCmd() });
  const { server, base } = await boot(root);
  t.after(async () => { server.close(); await rmRoot(root); });

  assert.equal((await j(base, 'POST', '/api/apps/nope/start')).status, 404);
  assert.equal((await j(base, 'POST', '/api/apps/app/share')).status, 409);
});

test('App shape carries per-route URLs and lastCommitAt', async (t) => {
  const root = await mkRoot();
  await mkProject(root, 'multi', {
    start: fakeAppCmd(),
    routes: [{ name: 'Main', path: '/' }, { name: 'Editor', path: '/edit.html' }],
  }, { git: true });
  await mkProject(root, 'plain', { start: fakeAppCmd() }, { git: true }); // no routes → implicit single '/'
  const { server, base } = await boot(root);
  t.after(async () => { await appManager.stop('multi').catch(() => {}); server.close(); await rmRoot(root); });

  // A git-tracked app reports its last commit date, even while stopped.
  let { body } = await j(base, 'GET', '/api/apps');
  assert.match(body.apps.find((a) => a.id === 'multi').lastCommitAt, /^\d{4}-\d{2}-\d{2}T/);

  // A manifest without routes exposes a single implicit '/' route.
  const plain = body.apps.find((a) => a.id === 'plain');
  assert.equal(plain.routes.length, 1);
  assert.equal(plain.routes[0].path, '/');

  // Start the multi-route app and check per-route URL enumeration.
  await j(base, 'POST', '/api/apps/multi/start');
  await waitFor(async () => {
    const r = await j(base, 'GET', '/api/apps');
    return ['ready', 'running'].includes(r.body.apps.find((a) => a.id === 'multi').status);
  });
  ({ body } = await j(base, 'GET', '/api/apps'));
  const multi = body.apps.find((a) => a.id === 'multi');
  assert.deepEqual(multi.routes.map((r) => r.name), ['Main', 'Editor']);
  assert.ok(multi.routes[0].urls.includes(`http://localhost:${multi.port}`));
  assert.ok(multi.routes[1].urls.includes(`http://localhost:${multi.port}/edit.html`));
});

test('share stands up a Basic-Auth proxy; unshare tears it down', async (t) => {
  const root = await mkRoot();
  await mkProject(root, 'app', { start: fakeAppCmd() }, { git: true });
  const { server, base } = await boot(root);
  t.after(async () => { await appManager.stop('app').catch(() => {}); server.close(); await rmRoot(root); });

  await j(base, 'POST', '/api/apps/app/start');
  await waitFor(async () => ['ready', 'running'].includes((await j(base, 'GET', '/api/apps')).body.apps.find((a) => a.id === 'app').status));

  const res = await j(base, 'POST', '/api/apps/app/share');
  assert.equal(res.status, 200);
  assert.equal(res.body.username, 'hub');
  assert.ok(res.body.password.length >= 20);
  assert.match(res.body.authUrl, /^https:\/\/.+\.trycloudflare\.com\?__hubauth=[\w-]+$/);
  assert.match(res.body.qrSvg, /<svg/);

  // list() exposes username + proxyPort, never the password.
  const app = (await j(base, 'GET', '/api/apps')).body.apps.find((a) => a.id === 'app');
  assert.equal(app.tunnel.username, 'hub');
  assert.ok(app.tunnel.proxyPort > 0);
  assert.equal(app.tunnel.password, undefined);

  // The proxy (which cloudflared points at) enforces auth and forwards to the app.
  const pp = app.tunnel.proxyPort;
  const noauth = await fetch(`http://127.0.0.1:${pp}/`);
  assert.equal(noauth.status, 401);
  assert.match(noauth.headers.get('www-authenticate') || '', /Basic/);
  const authed = await fetch(`http://127.0.0.1:${pp}/`, { headers: { authorization: basicAuth('hub', res.body.password) } });
  assert.equal(authed.status, 200);
  assert.equal(await authed.text(), 'ok');

  // unshare closes the proxy (port no longer accepts connections).
  await j(base, 'DELETE', '/api/apps/app/share');
  await assert.rejects(fetch(`http://127.0.0.1:${pp}/`));
});

test('share mode=lan stands up an HTTP proxy without cloudflared', async (t) => {
  const root = await mkRoot();
  await mkProject(root, 'app', { start: fakeAppCmd() }, { git: true });
  process.env.CODEHUB_CLOUDFLARED_BIN = '/nonexistent/cloudflared'; // prove no cloudflared dependency
  const { server, base } = await boot(root);
  t.after(async () => { await appManager.stop('app').catch(() => {}); server.close(); await rmRoot(root); process.env.CODEHUB_CLOUDFLARED_BIN = fakeCloudflaredBin; });

  await j(base, 'POST', '/api/apps/app/start');
  await waitFor(async () => ['ready', 'running'].includes((await j(base, 'GET', '/api/apps')).body.apps.find((a) => a.id === 'app').status));

  const res = await j(base, 'POST', '/api/apps/app/share', { mode: 'lan' });
  assert.equal(res.status, 200);
  assert.equal(res.body.kind, 'lan');
  assert.match(res.body.authUrl, /^http:\/\/.+\?__hubauth=[\w-]+$/);
  assert.equal(res.body.username, 'hub');
  assert.ok(Array.isArray(res.body.urls));

  // list() exposes kind/urls, never the password.
  const app = (await j(base, 'GET', '/api/apps')).body.apps.find((a) => a.id === 'app');
  assert.equal(app.tunnel.kind, 'lan');
  assert.ok(Array.isArray(app.tunnel.urls));
  assert.equal(app.tunnel.password, undefined);

  // The proxy (bound 0.0.0.0) is reachable + auth-gated over loopback.
  const pp = app.tunnel.proxyPort;
  const noauth = await fetch(`http://127.0.0.1:${pp}/`);
  assert.equal(noauth.status, 401);
  const authed = await fetch(`http://127.0.0.1:${pp}/`, { headers: { authorization: basicAuth('hub', res.body.password) } });
  assert.equal(authed.status, 200);

  // unshare tears down a LAN share same as a tunnel share.
  await j(base, 'DELETE', '/api/apps/app/share');
  await assert.rejects(fetch(`http://127.0.0.1:${pp}/`));
});

test('share with an invalid mode → 400', async (t) => {
  const root = await mkRoot();
  await mkProject(root, 'app', { start: fakeAppCmd() }, { git: true });
  const { server, base } = await boot(root);
  t.after(async () => { await appManager.stop('app').catch(() => {}); server.close(); await rmRoot(root); });

  await j(base, 'POST', '/api/apps/app/start');
  await waitFor(async () => ['ready', 'running'].includes((await j(base, 'GET', '/api/apps')).body.apps.find((a) => a.id === 'app').status));

  const res = await j(base, 'POST', '/api/apps/app/share', { mode: 'bogus' });
  assert.equal(res.status, 400);
});

test('init tears down a LAN share orphaned by a code-hub restart (pid: null)', async (t) => {
  const root = await mkRoot();
  // Stand-in for the app process only — a LAN share has no cloudflared child.
  const appChild = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  t.after(async () => {
    try { process.kill(-appChild.pid, 'SIGKILL'); } catch { /* gone */ }
    await rmRoot(root);
  });

  const store = { apps: { demo: {
    id: 'demo', project: 'demo', path: path.join(root, 'demo'), isWorktree: false, branch: null,
    pid: appChild.pid, pgid: appChild.pid, port: 5000, urls: [], startedSha: null, startedAt: '',
    tunnel: { kind: 'lan', url: 'http://192.0.2.1:5001', pid: null, username: 'hub', proxyPort: 5001, urls: ['http://192.0.2.1:5001'] },
  } } };
  await fs.mkdir(storeRoot(), { recursive: true });
  await fs.writeFile(path.join(storeRoot(), 'state.json'), JSON.stringify(store));

  await appManager.init(); // simulates a fresh code-hub after restart

  const { apps } = await appManager.list();
  const demo = apps.find((a) => a.id === 'demo');
  assert.ok(demo, 'app with a live pid is kept');
  assert.equal(demo.tunnel, null, 'LAN share is cleared → Share reappears');
  assert.ok(pidAlive(appChild.pid), 'the app process itself is untouched');
});

test('init tears down a share orphaned by a code-hub restart (needs-reshare)', async (t) => {
  const root = await mkRoot();
  // Two detached, own-group children: one stands in for the app process (stays
  // alive → app survives reconcile), one for the orphaned cloudflared tunnel.
  const appChild = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  const tunChild = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  t.after(async () => {
    for (const c of [appChild, tunChild]) { try { process.kill(-c.pid, 'SIGKILL'); } catch { /* gone */ } }
    await rmRoot(root);
  });

  const store = { apps: { demo: {
    id: 'demo', project: 'demo', path: path.join(root, 'demo'), isWorktree: false, branch: null,
    pid: appChild.pid, pgid: appChild.pid, port: 5000, urls: [], startedSha: null, startedAt: '',
    tunnel: { url: 'https://x.trycloudflare.com', pid: tunChild.pid, username: 'hub', proxyPort: 5001 },
  } } };
  await fs.mkdir(storeRoot(), { recursive: true });
  await fs.writeFile(path.join(storeRoot(), 'state.json'), JSON.stringify(store));

  await appManager.init(); // simulates a fresh code-hub after restart

  const { apps } = await appManager.list();
  const demo = apps.find((a) => a.id === 'demo');
  assert.ok(demo, 'app with a live pid is kept');
  assert.equal(demo.tunnel, null, 'orphaned tunnel is cleared → Share reappears');
  await waitFor(() => !pidAlive(tunChild.pid)); // orphaned cloudflared killed
  assert.ok(pidAlive(appChild.pid), 'the app process itself is untouched');
});
