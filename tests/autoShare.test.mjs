import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server.js';
import * as appManager from '../src/appManager.js';
import * as appSettings from '../src/appSettings.js';
import { mkRoot, rmRoot, mkProject, mkWorktree, waitFor, fakeAppCmd, fakeCloudflaredBin, fakeTailscaleBin } from './helpers.mjs';

// End-to-end auto-share over HTTP: a fake app, fake cloudflared and fake
// tailscale (env-injected), and the GET …/settled long-poll as the only wait.

async function boot(t, projects = ['app']) {
  process.env.CODEHUB_CLOUDFLARED_BIN = fakeCloudflaredBin;
  process.env.CODEHUB_TAILSCALE_BIN = fakeTailscaleBin;
  const root = await mkRoot();
  for (const name of projects) await mkProject(root, name, { start: fakeAppCmd() }, { git: true });
  await appManager.init();
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const ids = new Set(projects);
  t.after(async () => {
    for (const id of ids) await appManager.stop(id).catch(() => {});
    server.close();
    await rmRoot(root);
  });
  return { root, base, ids };
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
const enc = encodeURIComponent;
const settled = (base, id = 'app') => j(base, 'GET', `/api/apps/${enc(id)}/settled`);
const quiet = (t) => {
  const real = console.error;
  console.error = () => {};
  t.after(() => { console.error = real; });
};

// Invariant: one Start of a ticked app shares it with no second request, using
// the stored mode/auth/TLS and the stored default login.
test('a ticked app is shared by its Start alone, with the stored config and login', async (t) => {
  const { base } = await boot(t);
  await j(base, 'PUT', '/api/apps/app/settings', { username: 'alice', autoShare: { mode: 'lan', auth: true, tls: false } });
  assert.equal((await j(base, 'POST', '/api/apps/app/start')).status, 200);
  assert.deepEqual((await settled(base)).body, { id: 'app', settled: true });
  const app = await getApp(base);
  assert.equal(app.tunnel?.kind, 'lan');
  assert.equal(app.tunnel.tls, false);
  assert.equal(app.tunnel.auth, true);
  assert.equal(app.tunnel.username, 'alice');
  assert.equal(app.autoShareStatus, null);
  assert.equal(app.autoShareError, null);
});

// Invariant: an app without auto-share is started exactly as before.
test('an unticked app starts unshared, with nothing pending', async (t) => {
  const { base } = await boot(t);
  await j(base, 'POST', '/api/apps/app/start');
  assert.equal((await getApp(base)).autoShareStatus, null);
  assert.deepEqual((await settled(base)).body, { id: 'app', settled: true });
  const app = await getApp(base);
  assert.ok(['ready', 'running'].includes(app.status));
  assert.equal(app.tunnel, null);
  assert.equal(app.autoShareStatus, null);
});

// Invariant: Restart is a start, so it auto-shares the fresh process.
test('restarting a ticked, shared app shares it again', async (t) => {
  const { base } = await boot(t);
  await j(base, 'PUT', '/api/apps/app/settings', { autoShare: { mode: 'tunnel' } });
  await j(base, 'POST', '/api/apps/app/start');
  await settled(base);
  const first = await getApp(base);
  assert.equal(first.tunnel?.kind, 'tunnel');
  assert.equal((await j(base, 'POST', '/api/apps/app/restart')).status, 200);
  await settled(base);
  const again = await getApp(base);
  assert.equal(again.tunnel?.kind, 'tunnel');
  assert.notEqual(again.tunnel.proxyPort, first.tunnel.proxyPort);
});

// Invariant: every start path auto-shares, the MCP start_app tool included.
test('MCP start_app on a ticked app shares it', async (t) => {
  const { base } = await boot(t);
  await j(base, 'PUT', '/api/apps/app/settings', { autoShare: { mode: 'lan', tls: false } });
  const res = await j(base, 'POST', '/api/mcp', { tool: 'start_app', arguments: { id: 'app' }, caller: { sessionId: 's', project: 'p' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.error, undefined);
  await settled(base);
  assert.equal((await getApp(base)).tunnel?.kind, 'lan');
});

// Invariant: a funnel held by another app makes the auto-share fail visibly,
// naming the holder, while the start stands and the holder's share is untouched.
test('auto-share into a held tailscale funnel fails visibly; the start and the holder are unaffected', async (t) => {
  quiet(t);
  const { base } = await boot(t, ['holder', 'app']);
  await j(base, 'POST', '/api/apps/holder/start');
  await settled(base, 'holder');
  assert.equal((await j(base, 'POST', '/api/apps/holder/share', { mode: 'tailscale' })).status, 200);
  const held = (await getApp(base, 'holder')).tunnel;

  await j(base, 'PUT', '/api/apps/app/settings', { autoShare: { mode: 'tailscale' } });
  await j(base, 'POST', '/api/apps/app/start');
  await settled(base);
  const app = await getApp(base);
  assert.ok(['ready', 'running'].includes(app.status));
  assert.equal(app.tunnel, null);
  assert.equal(app.autoShareStatus, 'failed');
  assert.match(app.autoShareError, /'holder' already has a tailscale share/);
  const after = (await getApp(base, 'holder')).tunnel;
  assert.equal(after.url, held.url);
  assert.equal(after.proxyPort, held.proxyPort);
});

// Invariant: a share never runs against an app that did not become ready; the
// start itself still answers 200, and the reason shows in the listing.
test('a ticked app that crashes is not shared, and the failure is visible', async (t) => {
  const { root, base } = await boot(t, []);
  await mkProject(root, 'app', { start: fakeAppCmd('crash') }, { git: true });
  await j(base, 'PUT', '/api/apps/app/settings', { autoShare: { mode: 'lan' } });
  assert.equal((await j(base, 'POST', '/api/apps/app/start')).status, 200);
  await settled(base);
  const app = await getApp(base);
  assert.equal(app.status, 'crashed');
  assert.equal(app.tunnel, null);
  assert.equal(app.autoShareStatus, 'failed');
  assert.equal(app.autoShareError, 'app did not become ready (crashed) — not shared');
});

// Invariant: a worktree is never auto-shared, even with a hand-written config.
test('a worktree with a hand-written autoShare is started but never shared', async (t) => {
  const { root, base, ids } = await boot(t);
  await mkWorktree(root, 'app', 'feat', { start: fakeAppCmd() }, { git: true });
  ids.add('app:feat');
  await appSettings.update('app:feat', { autoShare: { mode: 'lan' } }); // the store itself doesn't police the kind
  await j(base, 'POST', `/api/apps/${enc('app:feat')}/start`);
  assert.equal((await getApp(base, 'app:feat')).autoShareStatus, null);
  await settled(base, 'app:feat');
  const wt = await getApp(base, 'app:feat');
  assert.ok(['ready', 'running'].includes(wt.status));
  assert.equal(wt.tunnel, null);
  assert.equal(wt.autoShareStatus, null);
});

// Invariant: any successful share, by hand included, clears a stale failure.
test('a manual share after a failed auto-share clears the failure', async (t) => {
  quiet(t);
  const { base } = await boot(t);
  await j(base, 'PUT', '/api/apps/app/settings', { autoShare: { mode: 'tailscale' } });
  process.env.CODEHUB_TAILSCALE_BIN = '/nonexistent/tailscale'; // the auto-share answers 501
  t.after(() => { process.env.CODEHUB_TAILSCALE_BIN = fakeTailscaleBin; });
  await j(base, 'POST', '/api/apps/app/start');
  await settled(base);
  assert.equal((await getApp(base)).autoShareStatus, 'failed');
  assert.match((await getApp(base)).autoShareError, /tailscale is not available/);
  assert.equal((await j(base, 'POST', '/api/apps/app/share', { mode: 'lan', tls: false })).status, 200);
  const app = await getApp(base);
  assert.equal(app.autoShareStatus, null);
  assert.equal(app.autoShareError, null);
});

// Invariant: the settle wait never hangs on an app with nothing in flight.
test('GET settled for a stopped app answers at once with settled:true', async (t) => {
  const { base } = await boot(t);
  const t0 = Date.now();
  assert.deepEqual((await settled(base)).body, { id: 'app', settled: true });
  assert.ok(Date.now() - t0 < 2000);
  await waitFor(async () => (await getApp(base)).status === 'stopped');
});
