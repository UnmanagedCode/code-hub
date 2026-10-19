import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createServer } from '../server.js';
import * as appManager from '../src/appManager.js';
import * as appSettings from '../src/appSettings.js';
import { localIPv4s } from '../src/net.js';
import { mkRoot, rmRoot, mkProject, mkWorktree, waitFor, fakeAppCmd, fakeCloudflaredBin, fakeTailscaleBin, writeRegistrations, ALT_LOOPBACK, altLoopbackBindable } from './helpers.mjs';

// The app's Settings `port` as the fixed port: Settings beats the manifest, a
// blank falls back, and every fixed-port rule (busy refusal, no fallback, LAN
// share, boot auto-start) applies to it.

const HAS_LAN = localIPv4s({ lanFallback: true }).length > 0;

// Allocate then release, so the number is real and currently free.
const freePort = () => new Promise((r) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); });
});

// Hold a port, as an unrelated process would.
const hold = (port) => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(port, '127.0.0.1', () => resolve(s));
});

async function boot(t, projects) {
  process.env.CODEHUB_CLOUDFLARED_BIN = fakeCloudflaredBin;
  process.env.CODEHUB_TAILSCALE_BIN = fakeTailscaleBin;
  const root = await mkRoot();
  for (const [name, manifest] of projects) await mkProject(root, name, manifest, { git: true });
  await appManager.init();
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    for (const [name] of projects) await appManager.stop(name).catch(() => {});
    await appManager.stop('app:feat').catch(() => {});
    server.close();
    await rmRoot(root);
  });
  return { root, base };
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
const setPort = (base, port, id = 'app') => j(base, 'PUT', `/api/apps/${encodeURIComponent(id)}/settings`, { port });
const up = (base, id = 'app') => waitFor(async () => ['ready', 'running'].includes((await getApp(base, id)).status));

// Invariant: the Settings port beats the manifest's, and survives a restart.
test('a Settings port beats the manifest port, on start and on restart', async (t) => {
  const [a, b] = [await freePort(), await freePort()];
  const { base } = await boot(t, [['app', { start: fakeAppCmd(), port: a }]]);
  assert.equal((await setPort(base, b)).status, 200);
  const started = await j(base, 'POST', '/api/apps/app/start');
  assert.equal(started.status, 200);
  assert.equal(started.body.port, b);
  assert.equal(started.body.fixedPort, b);
  await up(base);
  const restarted = await j(base, 'POST', '/api/apps/app/restart');
  assert.equal(restarted.status, 200);
  assert.equal(restarted.body.port, b);
  assert.equal(restarted.body.fixedPort, b);
});

// Invariant: clearing the Settings port falls back to the manifest's.
test('a blank Settings port falls back to the manifest port', async (t) => {
  const [a, b] = [await freePort(), await freePort()];
  const { base } = await boot(t, [['app', { start: fakeAppCmd(), port: a }]]);
  await setPort(base, b);
  await setPort(base, null);
  const started = await j(base, 'POST', '/api/apps/app/start');
  assert.equal(started.status, 200);
  assert.equal(started.body.port, a);
  assert.equal(started.body.fixedPort, a);
});

// Invariant: a Settings port pins an app that has no manifest port, and
// clearing it returns the app to a free port.
test('a Settings port pins an app with no manifest port; clearing returns to a free port', async (t) => {
  const b = await freePort();
  const { base } = await boot(t, [['app', { start: fakeAppCmd() }]]);
  await setPort(base, b);
  const pinned = await j(base, 'POST', '/api/apps/app/start');
  assert.equal(pinned.body.port, b);
  assert.equal(pinned.body.fixedPort, b);
  await up(base);
  await j(base, 'POST', '/api/apps/app/stop');
  await setPort(base, null);
  const free = await j(base, 'POST', '/api/apps/app/start');
  assert.equal(free.status, 200);
  assert.equal(free.body.fixedPort, null);
  assert.notEqual(free.body.port, b);
});

// Invariant: a change made while the app runs applies only on the next start.
test('a Settings port changed while running applies on the next restart only', async (t) => {
  const [a, b] = [await freePort(), await freePort()];
  const { base } = await boot(t, [['app', { start: fakeAppCmd(), port: a }]]);
  await j(base, 'POST', '/api/apps/app/start');
  await up(base);
  await setPort(base, b);
  assert.equal((await getApp(base)).port, a);
  const restarted = await j(base, 'POST', '/api/apps/app/restart');
  assert.equal(restarted.body.port, b);
});

// Invariant: a busy Settings port refuses the start (never falls back to a free
// port), whether an unrelated process or another app's record holds it.
test('a busy Settings port refuses the start and never falls back', async (t) => {
  const b = await freePort();
  const { base } = await boot(t, [['app', { start: fakeAppCmd() }], ['other', { start: fakeAppCmd() }]]);
  await setPort(base, b);
  const holder = await hold(b);
  t.after(() => holder.close());
  const res = await j(base, 'POST', '/api/apps/app/start');
  assert.equal(res.status, 409);
  assert.match(res.body.error, /will not fall back to a free one/);
  const listed = await getApp(base);
  assert.equal(listed.status, 'stopped');
  assert.equal(listed.port, undefined);
  await new Promise((r) => holder.close(r));

  // Another app's live record on the port is named in the refusal.
  const c = await freePort();
  await setPort(base, c, 'other');
  assert.equal((await j(base, 'POST', '/api/apps/other/start')).status, 200);
  await setPort(base, c);
  const clash = await j(base, 'POST', '/api/apps/app/start');
  assert.equal(clash.status, 409);
  assert.match(clash.body.error, /held by 'other'/);
});

// Invariant: a worktree never takes a Settings port, even one written by hand
// past the API guard.
test('a worktree ignores a hand-written Settings port', async (t) => {
  const b = await freePort();
  const { root, base } = await boot(t, [['app', { start: fakeAppCmd() }]]);
  await mkWorktree(root, 'app', 'feat', { start: fakeAppCmd() }, { git: true });
  await appSettings.update('app:feat', { port: b });
  const res = await j(base, 'POST', '/api/apps/app%3Afeat/start');
  assert.equal(res.status, 200);
  assert.equal(res.body.fixedPort, null);
  assert.notEqual(res.body.port, b);
});

// Invariant: a LAN share reuses a Settings fixed port exactly as it does a
// manifest one.
test('the LAN share reuses a Settings fixed port', async (t) => {
  if (!HAS_LAN) return t.skip('no LAN interface on this host');
  const b = await freePort();
  const { base } = await boot(t, [['app', { start: fakeAppCmd() }]]);
  await setPort(base, b);
  await j(base, 'POST', '/api/apps/app/start');
  await up(base);
  const res = await j(base, 'POST', '/api/apps/app/share', { mode: 'lan', tls: false });
  assert.equal(res.status, 200);
  assert.equal(res.body.proxyPort, b);
  assert.equal(res.body.fixedPortFallback, false);
});

// Invariant: a Settings port that is busy at boot fails the auto-start, and the
// failure shows on the card.
test('a Settings port busy at boot fails the auto-start on the card', async (t) => {
  const b = await freePort();
  const { base } = await boot(t, [['app', { start: fakeAppCmd() }]]);
  await appSettings.update('app', { autoStart: true, port: b });
  const holder = await hold(b);
  t.after(() => holder.close());
  const real = console.error;
  console.error = () => {};
  t.after(() => { console.error = real; });
  await appManager.init();
  const res = await appManager.autoStartAll();
  assert.deepEqual(res.failed, ['app']);
  const app = await getApp(base);
  assert.equal(app.status, 'stopped');
  assert.match(app.autoStartError, /will not fall back/);
});

// Invariant: the availability pre-check applies to a Settings port too — one held
// only on another local address (which the app, binding loopback, could still
// start beside) is refused, so the check can't be gated on the manifest's port.
test('a Settings port held only on another local address is refused', async (t) => {
  const lanIp = localIPv4s({ lanFallback: true })[0];
  const host = (await altLoopbackBindable()) ? ALT_LOOPBACK : lanIp;
  if (!host) return t.skip('no alternate local address on this host');
  const b = await freePort();
  const { base } = await boot(t, [['app', { start: fakeAppCmd() }]]);
  await setPort(base, b);
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(b, host, r));
  t.after(() => new Promise((r) => blocker.close(r)));
  const res = await j(base, 'POST', '/api/apps/app/start');
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.match(res.body.error, /already in use/);
  assert.equal((await getApp(base)).status, 'stopped');
});

// Invariant: a Settings-port child that hits EADDRINUSE after a clean pre-check is
// refused and never retried onto another port, so the runner's `fixed` flag
// can't be derived from the manifest's port.
test('a Settings-port child that hits EADDRINUSE after a clean pre-check still 409s, and never moves', async (t) => {
  const b = await freePort();
  const root0 = await mkRoot();
  const marker = path.join(root0, 'flaky-marker');
  t.after(() => rmRoot(root0));
  const { base } = await boot(t, [['app', { start: fakeAppCmd('flaky', marker) }]]);
  await setPort(base, b);
  const res = await j(base, 'POST', '/api/apps/app/start');
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.match(res.body.error, /already in use/);
  const app = await getApp(base);
  assert.equal(app.status, 'stopped');
  assert.equal(app.port, undefined);
});

// Invariant: a registry-sourced app exposes its registration's port as
// `manifestPort`, with `source: 'registry'`.
test('a registration port is exposed as manifestPort with source registry', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkProject(root, 'reg', { start: fakeAppCmd() });
  await fs.rm(path.join(root, 'reg', '.hub.json'));
  await writeRegistrations(root, { reg: { start: fakeAppCmd(), port: 4400 } });
  process.env.CODEHUB_CLOUDFLARED_BIN = fakeCloudflaredBin;
  process.env.CODEHUB_TAILSCALE_BIN = fakeTailscaleBin;
  await appManager.init();
  const app = (await appManager.list()).apps.find((a) => a.id === 'reg');
  assert.equal(app.source, 'registry');
  assert.equal(app.manifestPort, 4400);
});
