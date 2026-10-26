import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { existsSync, promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from '../server.js';
import * as appManager from '../src/appManager.js';
import * as appSettings from '../src/appSettings.js';
import * as bridgeForward from '../src/bridgeForward.js';
import { _setContainerProbe, _setLocalIPv4sProbe, _setBridgeProbe } from '../src/net.js';
import { storeRoot, unregisterInMemory } from '../src/projects.js';
import {
  mkRoot, rmRoot, mkProject, fakeAppCmd, fakeCloudflaredBin, fakeTailscaleBin, waitFor,
  ALT_LOOPBACK, altLoopbackBindable, listeningAddrs, holdShareAtSettingsRead,
  useConductorOverlay, resetConductorOverlay,
} from './helpers.mjs';

// The no-relay bridge-address fallback, through an in-process code-hub in a
// "container" with no host relay. ALT_LOOPBACK stands in for the bridge
// address (the only local IPv4): a bind target distinct from the 127.0.0.1 a
// loopback-only fake app holds, and covered by a 0.0.0.0 bind like a real one.
// Every listener assertion reads this process's own sockets; where a share
// proxy and a forwarder could both hold ALT:P, an unauthenticated GET tells
// them apart (forwarder 200, gated share 401).

const BRIDGE = ALT_LOOPBACK;
const bridgeUrl = (port) => `http://${BRIDGE}:${port}`;

async function boot(t, { projects = { app: { start: fakeAppCmd() } }, container = true, beforeInit } = {}) {
  if (process.platform !== 'linux' || !existsSync(`/proc/${process.pid}/net/tcp`) || !(await altLoopbackBindable())) {
    t.skip(`${ALT_LOOPBACK} is not a bindable loopback alias here, or /proc is unavailable`);
    return null;
  }
  process.env.CODEHUB_CLOUDFLARED_BIN = fakeCloudflaredBin;
  process.env.CODEHUB_TAILSCALE_BIN = fakeTailscaleBin;
  _setContainerProbe(() => container);
  _setLocalIPv4sProbe(() => [BRIDGE]);
  if (container) _setBridgeProbe(() => true);
  const root = await mkRoot({ bridgeFallback: true });
  for (const [id, manifest] of Object.entries(projects)) await mkProject(root, id, manifest);
  await beforeInit?.(root);
  await appManager.init();
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    for (const id of Object.keys(projects)) await appManager.stop(id).catch(() => {});
    bridgeForward.reset();
    _setContainerProbe(null);
    _setLocalIPv4sProbe(null);
    _setBridgeProbe(null);
    server.close();
    await rmRoot(root);
  });
  return { root, base: `http://127.0.0.1:${server.address().port}` };
}

const j = async (base, method, p, body) => {
  const r = await fetch(base + p, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json() };
};
const listing = async (base) => (await j(base, 'GET', '/api/apps')).body;
const listed = async (base, id = 'app') => (await listing(base)).apps.find((a) => a.id === id);

// Start through the API and wait for its readiness (and auto-share) to settle: its port.
async function startApp(base, id = 'app') {
  const res = await j(base, 'POST', `/api/apps/${id}/start`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  await j(base, 'GET', `/api/apps/${id}/settled`);
  return res.body.port;
}

function get(port, host = BRIDGE) {
  return new Promise((resolve, reject) => {
    http.get({ host, port, path: '/', agent: false }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    }).on('error', reject);
  });
}

const own = () => listeningAddrs(process.pid);
const holdsBridge = async (port) => (await own()).has(`${BRIDGE}:${port}`);

// Allocate then release, so the number is real and currently free.
const freePort = () => new Promise((r) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); });
});

async function fixedPortApp(t, opts = {}) {
  const port = await freePort();
  const booted = await boot(t, {
    ...opts,
    beforeInit: async () => { await appSettings.update('app', { port, ...(opts.settings ?? {}) }); },
  });
  return booted && { ...booted, port };
}

// Invariant (acceptance): once a loopback-only app is ready, its Start URL —
// top-level and per route — is the bridge address at its own port, served by
// a forwarder bound on that address only (never 0.0.0.0). B8: the listener is
// code-hub's own socket, not a helper process's, so it ends with code-hub.
test('B1/B8: a ready app opens at the bridge address through code-hub\'s own forwarder', async (t) => {
  const booted = await boot(t);
  if (!booted) return;
  const { base } = booted;
  const port = await startApp(base);
  const app = await listed(base);
  assert.equal(app.status, 'ready');
  assert.equal(app.urls[0], bridgeUrl(port));
  assert.equal(app.routes[0].urls[0], bridgeUrl(port));
  assert.ok(!app.urls.slice(1).includes(bridgeUrl(port)), 'listed once');
  const addrs = await own();
  assert.ok(addrs.has(`${BRIDGE}:${port}`), [...addrs].join(' '));
  assert.ok(!addrs.has(`0.0.0.0:${port}`), [...addrs].join(' '));
  assert.equal(await get(port), 200);
});

// Invariant: an app that already holds the bridge address itself (bound
// 0.0.0.0) still starts ready and is offered there, with no forwarder.
test('B2: a wildcard app keeps its start and is shown at the bridge address directly', async (t) => {
  const booted = await boot(t, { projects: { app: { start: fakeAppCmd('wildcard') } } });
  if (!booted) return;
  const { base } = booted;
  t.mock.method(console, 'error', () => {});
  const port = await startApp(base);
  await waitFor(async () => (await listed(base)).urls[0] === bridgeUrl(port), { timeout: 2000 });
  assert.equal((await listed(base)).status, 'ready');
  assert.equal(await holdsBridge(port), false);
  assert.equal(await get(port), 200, 'the app answers there itself');
});

// Invariant: a forwarder goes with its app on stop, follows a restart to the
// new record's port, and goes on a crash with no API call.
test('B3: stop, restart and crash each close the forwarder', async (t) => {
  const booted = await boot(t);
  if (!booted) return;
  const { base } = booted;
  const first = await startApp(base);
  assert.equal(await holdsBridge(first), true);
  assert.equal((await j(base, 'POST', '/api/apps/app/stop')).status, 200);
  assert.equal(await holdsBridge(first), false);

  const second = await startApp(base);
  const restarted = await j(base, 'POST', '/api/apps/app/restart');
  assert.equal(restarted.status, 200);
  await j(base, 'GET', '/api/apps/app/settled');
  const third = restarted.body.port;
  if (third !== second) assert.equal(await holdsBridge(second), false);
  assert.equal(await holdsBridge(third), true);

  process.kill(-appManager._record('app').pgid, 'SIGKILL');
  await waitFor(async () => !(await holdsBridge(third)), { timeout: 3000 });
});

// Invariant: no forwarder while the app is starting — it could take the
// bridge address before an app binding 0.0.0.0 does — only once it is ready.
test('B4: the forwarder opens at ready, never while starting', async (t) => {
  const marker = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'codehub-gate-')), 'go');
  t.after(() => fs.rm(path.dirname(marker), { recursive: true, force: true }));
  const booted = await boot(t, { projects: { app: { start: fakeAppCmd('gated', marker) } } });
  if (!booted) return;
  const { base } = booted;
  const { port } = (await j(base, 'POST', '/api/apps/app/start')).body;
  await new Promise((r) => setTimeout(r, 300));
  const app = await listed(base);
  assert.equal(app.status, 'starting');
  assert.equal(await holdsBridge(port), false);
  assert.equal(app.urls[0], `http://localhost:${port}`);
  await fs.writeFile(marker, '');
  await j(base, 'GET', '/api/apps/app/settled');
  assert.equal(await holdsBridge(port), true);
});

// Invariant: the hub setting switches the fallback off and on live — off
// closes every forwarder and restores localhost Start URLs, a start while off
// opens none, and on reopens them; a malformed body is refused.
test('B5: the hub setting turns the fallback off and on, live', async (t) => {
  const booted = await boot(t, { projects: { app: { start: fakeAppCmd() }, two: { start: fakeAppCmd() } } });
  if (!booted) return;
  const { base } = booted;
  assert.deepEqual((await listing(base)).hubSettings, { bridgeFallback: true });
  const port = await startApp(base);
  assert.equal(await holdsBridge(port), true);

  const off = await j(base, 'PUT', '/api/hub-settings', { bridgeFallback: false });
  assert.deepEqual(off, { status: 200, body: { bridgeFallback: false } });
  assert.equal(await holdsBridge(port), false);
  assert.equal((await listed(base)).urls[0], `http://localhost:${port}`);
  assert.deepEqual((await listing(base)).hubSettings, { bridgeFallback: false });
  const two = await startApp(base, 'two');
  assert.equal(await holdsBridge(two), false);
  assert.equal((await listed(base, 'two')).urls[0], `http://localhost:${two}`);

  assert.equal((await j(base, 'PUT', '/api/hub-settings', { bridgeFallback: true })).status, 200);
  await waitFor(async () => (await holdsBridge(port)) && (await holdsBridge(two)), { timeout: 2000 });
  assert.equal((await listed(base)).urls[0], bridgeUrl(port));

  for (const body of [{ bridgeFallback: 'no' }, { bridgeFallback: false, x: 1 }, {}]) {
    assert.equal((await j(base, 'PUT', '/api/hub-settings', body)).status, 400, JSON.stringify(body));
  }
  assert.equal(await holdsBridge(port), true, 'a refused body changes nothing');
});

// Invariant: outside a container nothing changes — no forwarder, localhost
// Start URL.
test('B6: outside a container there is no forwarder', async (t) => {
  const booted = await boot(t, { container: false });
  if (!booted) return;
  const { base } = booted;
  const port = await startApp(base);
  assert.equal(await holdsBridge(port), false);
  assert.equal((await listed(base)).urls[0], `http://localhost:${port}`);
});

// Invariant: code-hub's boot re-opens the forwarder of an app it adopts
// (still running from before the restart).
test('B7: boot opens a forwarder for an adopted app', async (t) => {
  const app = http.createServer((req, res) => res.end('ok'));
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  t.after(() => app.close());
  const port = app.address().port;
  const sleeper = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1e9)'], { detached: true, stdio: 'ignore' });
  t.after(() => { try { process.kill(-sleeper.pid, 'SIGKILL'); } catch { /* gone */ } });
  const booted = await boot(t, {
    beforeInit: async (root) => {
      await fs.mkdir(storeRoot(), { recursive: true });
      const rec = { id: 'app', project: 'app', path: path.join(root, 'app'), isWorktree: false, branch: null, pid: sleeper.pid, pgid: sleeper.pid,
        port, fixedPort: null, startedSha: null, startedAt: null, tunnel: null };
      await fs.writeFile(path.join(storeRoot(), 'state.json'), JSON.stringify({ apps: { app: rec } }));
    },
  });
  if (!booted) return;
  await waitFor(() => holdsBridge(port), { timeout: 2000 });
  assert.equal(await get(port), 200);
  assert.equal((await listed(booted.base)).urls[0], bridgeUrl(port));
});

// Invariant: the always-on host conductor (never started by code-hub) is
// never forwarded, while an app code-hub started is.
test('B9: the host conductor is never forwarded', async (t) => {
  const conductor = http.createServer((req, res) => res.end('conductor'));
  await new Promise((r) => conductor.listen(0, '127.0.0.1', r));
  const conductorPort = conductor.address().port;
  t.after(async () => {
    resetConductorOverlay();
    delete process.env.CONDUCTOR_PROJECT_DIR;
    unregisterInMemory('code-conductor');
    conductor.close();
  });
  const booted = await boot(t, {
    beforeInit: async (root) => {
      await mkProject(root, 'code-conductor', null);
      await useConductorOverlay([]);
      process.env.CONDUCTOR_URL = `http://127.0.0.1:${conductorPort}`;
      process.env.CONDUCTOR_PROJECT_DIR = path.join(root, 'code-conductor');
    },
  });
  if (!booted) return;
  const { base } = booted;
  assert.equal((await listed(base, 'code-conductor')).alwaysOn, true);
  const port = await startApp(base);
  assert.equal(await holdsBridge(port), true);
  assert.equal(await holdsBridge(conductorPort), false);
  assert.equal((await listed(base, 'code-conductor')).urls[0], `http://localhost:${conductorPort}`);
});

// Invariant: a LAN share displaces the forwarder — a fixed-port share takes
// the bridge address at the app's own port, gated — and while it is up the
// Start URL is localhost again.
test('L1: a fixed-port LAN share takes the bridge address gated', async (t) => {
  const booted = await fixedPortApp(t);
  if (!booted) return;
  const { base, port } = booted;
  assert.equal(await startApp(base), port);
  assert.equal(await get(port), 200);
  const s = await j(base, 'POST', '/api/apps/app/share', { mode: 'lan', tls: false });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(s.body.fixedPortFallback, false);
  assert.equal(s.body.proxyPort, port);
  assert.equal(await get(port), 401);
  assert.equal((await listed(base)).urls[0], `http://localhost:${port}`);
});

// Invariant: the forwarder is closed before the share's first await (so before
// any bind of its own), and a share that never commits hands the address back
// to the forwarder.
test('L2: the forwarder closes before the share\'s first await, and returns when the share is cancelled', async (t) => {
  const booted = await boot(t);
  if (!booted) return;
  const { base } = booted;
  const port = await startApp(base);
  assert.equal(await holdsBridge(port), true);
  const hold = holdShareAtSettingsRead(t);
  const sharing = j(base, 'POST', '/api/apps/app/share', { mode: 'lan', tls: false });
  await hold.parked;
  assert.equal(await holdsBridge(port), false);
  assert.equal((await j(base, 'DELETE', '/api/apps/app/share')).status, 200);
  hold.release();
  assert.equal((await sharing).status, 409);
  await waitFor(() => holdsBridge(port), { timeout: 2000 });
  assert.equal(await get(port), 200);
  assert.equal((await listed(base)).urls[0], bridgeUrl(port));
});

// Invariant: a fixed-port LAN share that can't take the bridge address (a
// wildcard app holds it) falls back as it always has, and its unshare leaves
// no stale state — the app is offered at the bridge address directly again.
test('L2b: a wildcard app\'s LAN share falls back, and unsharing restores the bridge URL', async (t) => {
  const booted = await fixedPortApp(t, { projects: { app: { start: fakeAppCmd('wildcard') } } });
  if (!booted) return;
  const { base, port } = booted;
  t.mock.method(console, 'error', () => {});
  await startApp(base);
  await waitFor(async () => (await listed(base)).urls[0] === bridgeUrl(port), { timeout: 2000 });
  const s = await j(base, 'POST', '/api/apps/app/share', { mode: 'lan', tls: false });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(s.body.fixedPortFallback, true);
  assert.equal(s.body.fixedPortHolder, 'app');
  assert.equal((await listed(base)).urls[0], `http://localhost:${port}`);
  assert.equal((await j(base, 'DELETE', '/api/apps/app/share')).status, 200);
  await waitFor(async () => (await listed(base)).urls[0] === bridgeUrl(port), { timeout: 2000 });
  assert.equal(await holdsBridge(port), false);
});

// Invariant: unsharing a LAN share reopens the forwarder.
test('L3: unsharing reopens the forwarder', async (t) => {
  const booted = await fixedPortApp(t);
  if (!booted) return;
  const { base, port } = booted;
  await startApp(base);
  assert.equal((await j(base, 'POST', '/api/apps/app/share', { mode: 'lan', tls: false })).status, 200);
  assert.equal(await get(port), 401);
  assert.equal((await j(base, 'DELETE', '/api/apps/app/share')).status, 200);
  await waitFor(() => holdsBridge(port), { timeout: 2000 });
  assert.equal(await get(port), 200);
  assert.equal((await listed(base)).urls[0], bridgeUrl(port));
});

// Invariant: displacement is decided per record — a restart drops the LAN
// share and the new record gets its forwarder — and a LAN auto-share on the
// restart takes the address whichever of it and the forwarder comes first.
test('L4: a restart re-evaluates the displacement; a LAN auto-share still takes the address', async (t) => {
  const booted = await fixedPortApp(t);
  if (!booted) return;
  const { base, port } = booted;
  await startApp(base);
  assert.equal((await j(base, 'POST', '/api/apps/app/share', { mode: 'lan', tls: false })).status, 200);
  assert.equal((await j(base, 'POST', '/api/apps/app/restart')).status, 200);
  await j(base, 'GET', '/api/apps/app/settled');
  assert.equal((await listed(base)).tunnel, null);
  await waitFor(() => holdsBridge(port), { timeout: 2000 });
  assert.equal(await get(port), 200);

  assert.equal((await j(base, 'PUT', '/api/apps/app/settings', { autoShare: { mode: 'lan', tls: false } })).status, 200);
  assert.equal((await j(base, 'POST', '/api/apps/app/restart')).status, 200);
  await j(base, 'GET', '/api/apps/app/settled');
  const app = await listed(base);
  assert.equal(app.tunnel?.kind, 'lan', JSON.stringify(app.autoShareError));
  assert.equal(app.tunnel.proxyPort, port);
  assert.equal(await get(port), 401);
});

// Invariant: only a LAN share displaces the forwarder — a tunnel share leaves
// it up, and re-sharing a LAN share as a tunnel reopens it.
test('L5: a tunnel share leaves the forwarder up; a LAN share re-shared as a tunnel reopens it', async (t) => {
  const booted = await boot(t);
  if (!booted) return;
  const { base } = booted;
  const port = await startApp(base);
  assert.equal((await j(base, 'POST', '/api/apps/app/share', { mode: 'tunnel' })).status, 200);
  assert.equal(await holdsBridge(port), true);
  assert.equal(await get(port), 200);
  assert.equal((await j(base, 'POST', '/api/apps/app/share', { mode: 'lan', tls: false })).status, 200);
  assert.equal(await holdsBridge(port), false);
  assert.equal((await j(base, 'POST', '/api/apps/app/share', { mode: 'tunnel' })).status, 200);
  await waitFor(() => holdsBridge(port), { timeout: 2000 });
  assert.equal(await get(port), 200);
});

// Invariant: a tailscale share binds nothing on the bridge address and leaves
// the forwarder up, like a tunnel share.
test('L5b: a tailscale share leaves the forwarder up', async (t) => {
  const booted = await boot(t);
  if (!booted) return;
  const { base } = booted;
  const port = await startApp(base);
  const s = await j(base, 'POST', '/api/apps/app/share', { mode: 'tailscale' });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(await holdsBridge(port), true);
  assert.equal(await get(port), 200);
  assert.equal((await listed(base)).urls[0], bridgeUrl(port));
});

// Invariant: a re-share away from LAN that fails — after it has already torn
// the LAN share down — hands the bridge address back to the forwarder, in
// both non-LAN modes.
test('L6: a failed tunnel or tailscale re-share of a LAN share reopens the forwarder', async (t) => {
  const booted = await boot(t);
  if (!booted) return;
  const { base } = booted;
  const port = await startApp(base);
  t.after(() => { delete process.env.FAKE_CLOUDFLARED_MODE; delete process.env.FAKE_TAILSCALE_MODE; });
  for (const [mode, env, value] of [['tunnel', 'FAKE_CLOUDFLARED_MODE', 'fail'], ['tailscale', 'FAKE_TAILSCALE_MODE', 'denied']]) {
    assert.equal((await j(base, 'POST', '/api/apps/app/share', { mode: 'lan', tls: false })).status, 200, mode);
    assert.equal(await holdsBridge(port), false, mode);
    process.env[env] = value;
    const failed = await j(base, 'POST', '/api/apps/app/share', { mode });
    delete process.env[env];
    assert.ok(failed.status >= 400, `${mode}: ${JSON.stringify(failed.body)}`);
    assert.equal((await listed(base)).tunnel, null, mode);
    assert.equal(await holdsBridge(port), true, mode);
    assert.equal(await get(port), 200, mode);
    assert.equal((await listed(base)).urls[0], bridgeUrl(port), mode);
  }
});

// Invariant: displacement is per record — a LAN share still in flight for a
// stopped record doesn't keep the restarted record's forwarder closed.
test('L7: a parked LAN share of the old record leaves the new record\'s forwarder up', async (t) => {
  const booted = await boot(t);
  if (!booted) return;
  const { base } = booted;
  await startApp(base);
  const hold = holdShareAtSettingsRead(t);
  const sharing = j(base, 'POST', '/api/apps/app/share', { mode: 'lan', tls: false });
  await hold.parked;
  const restarted = await j(base, 'POST', '/api/apps/app/restart');
  assert.equal(restarted.status, 200, JSON.stringify(restarted.body));
  await j(base, 'GET', '/api/apps/app/settled');
  const port = restarted.body.port;
  assert.equal(await holdsBridge(port), true, 'the new record is forwarded while the old share is parked');
  assert.equal(await get(port), 200);
  hold.release();
  assert.equal((await sharing).status, 409);
  assert.equal(await holdsBridge(port), true);
});
