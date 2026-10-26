import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { createServer } from '../server.js';
import * as appManager from '../src/appManager.js';
import * as hostRelay from '../src/hostRelay.js';
import * as relayStore from '../src/relayStore.js';
import { _setContainerProbe } from '../src/net.js';
import { unregisterInMemory } from '../src/projects.js';
import {
  requirePython, startRelay, canConnect, waitFor, useConductorOverlay, resetConductorOverlay,
  mkRoot, rmRoot, mkProject, fakeAppCmd, fakeCloudflaredBin, fakeTailscaleBin, ALT_LOOPBACK, altLoopbackBindable, listeningAddrs,
} from './helpers.mjs';
import * as loopbackMirror from '../src/loopbackMirror.js';
import { storeRoot } from '../src/projects.js';
import { spawn } from 'node:child_process';
import net from 'node:net';

// Loopback mirrors (S10): every running app's port, mirrored onto the host's
// 127.0.0.1 by the real relay, driven by an in-process code-hub in a
// "container" — and the Start URL that follows the mirror.

async function boot(t, { ids = ['app'], manifests = {}, advertise = '127.0.0.1', beforeInit } = {}) {
  process.env.CODEHUB_CLOUDFLARED_BIN = fakeCloudflaredBin;
  process.env.CODEHUB_TAILSCALE_BIN = fakeTailscaleBin;
  _setContainerProbe(() => true);
  hostRelay._setLoopbackDialHost('127.0.0.1');
  relayStore._setHostPollMs(50);
  const root = await mkRoot();
  for (const id of ids) await mkProject(root, id, manifests[id] ?? { start: fakeAppCmd() });
  await beforeInit?.(root);
  await appManager.init();
  await hostRelay.init();
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    for (const id of ids) await appManager.stop(id).catch(() => {});
    hostRelay.stop();
    _setContainerProbe(null);
    hostRelay._setLoopbackDialHost(null);
    server.close();
    await rmRoot(root);
  });
  const relay = await startRelay({ projectsRoot: root, advertise });
  t.after(() => relay.stop());
  await waitFor(() => hostRelay.status().state === 'up', { timeout: 4000 });
  return { root, relay, base: `http://127.0.0.1:${server.address().port}` };
}

const listedApp = async (base, id = 'app') => (await (await fetch(`${base}/api/apps`)).json()).apps.find((a) => a.id === id);

async function startApp(id = 'app') {
  await appManager.start(id);
  await appManager.awaitSettled(id);
}

// The host port the relay bound for `id`'s mirror, once bound (from the Start URL).
async function mirrorPort(base, id = 'app') {
  let port = null;
  await waitFor(async () => {
    const app = await listedApp(base, id);
    const m = /^http:\/\/127\.0\.0\.1:(\d+)$/.exec(app?.urls?.[0] ?? '');
    port = m ? Number(m[1]) : null;
    return port !== null;
  }, { timeout: 3000 });
  return port;
}

function get(port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    http.get({ host, port, path: '/', agent: false }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

// Invariant (S10): a started app is mirrored on the host's loopback within
// seconds and answers there; stopping it closes the mirror; a restart mirrors it again.
test('M1: start mirrors the app on host loopback, stop closes it, restart re-mirrors', async (t) => {
  if (!requirePython(t)) return;
  const { base } = await boot(t);
  await startApp();
  const h = await mirrorPort(base);
  assert.deepEqual(await get(h), { status: 200, body: 'ok' });
  await appManager.stop('app');
  await waitFor(async () => !(await canConnect(h)), { timeout: 2000 });
  await startApp();
  const again = await mirrorPort(base);
  assert.deepEqual(await get(again), { status: 200, body: 'ok' });
});

// Invariant (S10): an app that dies on its own loses its mirror with no API
// call at all — the runner's exit hook drives it.
test('M2: a crashed app\'s mirror closes without any API call', async (t) => {
  if (!requirePython(t)) return;
  const { base } = await boot(t);
  await startApp();
  const h = await mirrorPort(base);
  const { pgid } = appManager._record('app');
  assert.equal(await canConnect(h), true);
  process.kill(-pgid, 'SIGKILL');
  await waitFor(async () => !(await canConnect(h)), { timeout: 3000 });
});

// Invariant (S10): the always-on host conductor (never started by code-hub) is
// never mirrored, while an app code-hub started is.
test('M3: the host conductor is never mirrored', async (t) => {
  if (!requirePython(t)) return;
  const conductor = http.createServer((req, res) => res.end('conductor'));
  await new Promise((r) => conductor.listen(0, '127.0.0.1', r));
  const conductorPort = conductor.address().port;
  t.after(async () => {
    resetConductorOverlay();
    delete process.env.CONDUCTOR_PROJECT_DIR;
    unregisterInMemory('code-conductor');
    conductor.close();
  });
  const { base, relay } = await boot(t, {
    beforeInit: async (root) => {
      await mkProject(root, 'code-conductor', null);
      await useConductorOverlay([]);
      process.env.CONDUCTOR_URL = `http://127.0.0.1:${conductorPort}`;
      process.env.CONDUCTOR_PROJECT_DIR = path.join(root, 'code-conductor');
    },
  });
  const hc = await listedApp(base, 'code-conductor');
  assert.equal(hc.alwaysOn, true);
  await startApp();
  const appPort = (await listedApp(base)).port;
  await mirrorPort(base);
  assert.match(relay.output().stderr, new RegExp(`loopback port ${appPort} on host`));
  assert.doesNotMatch(relay.output().stderr, new RegExp(`loopback port ${conductorPort} on host`));
  assert.equal((await listedApp(base, 'code-conductor')).urls[0], `http://localhost:${conductorPort}`);
});

// Invariant (S10): the Start URL (top-level and per route) is the host loopback
// mirror while it is bound — at the port actually bound, here a fallback —
// and reverts to localhost at the app's port once the relay is gone.
test('M4: the Start URL follows the mirror, fallback port included, and reverts when the relay dies', async (t) => {
  if (!requirePython(t)) return;
  const { base, relay } = await boot(t);
  await startApp();
  const h = await mirrorPort(base);
  const app = await listedApp(base);
  assert.notEqual(h, app.port, 'the app holds its own port on 127.0.0.1, so the mirror fell back');
  assert.equal(app.urls[0], `http://127.0.0.1:${h}`);
  assert.equal(app.routes[0].urls[0], `http://127.0.0.1:${h}`);
  assert.ok(!app.urls.includes(`http://localhost:${app.port}`));
  await relay.stop('SIGKILL');
  await waitFor(async () => (await listedApp(base)).urls[0] === `http://localhost:${app.port}`, { timeout: 3000 });
  assert.equal((await listedApp(base)).routes[0].urls[0], `http://localhost:${app.port}`);
});

// Invariant (S4/S10): the mirrors live exactly as long as code-hub's session —
// ending it closes every one.
test('M5: a session drop closes every mirror', async (t) => {
  if (!requirePython(t)) return;
  const { base } = await boot(t, { ids: ['app', 'two'] });
  await startApp('app');
  await startApp('two');
  const ports = [await mirrorPort(base, 'app'), await mirrorPort(base, 'two')];
  for (const p of ports) assert.equal(await canConnect(p), true);
  hostRelay.stop();
  for (const p of ports) await waitFor(async () => !(await canConnect(p)), { timeout: 2000 });
});

// Invariant (S10): end-to-end scope confinement — a mirror is bound on
// loopback only, and a LAN share on the advertised address only. Asserted on
// what the relay process itself listens on (/proc), so another process on the
// same port of the other address can't make the check pass or fail.
test('M6: a mirror is loopback-only and a LAN share is advertised-address-only', async (t) => {
  if (!requirePython(t)) return;
  if (process.platform !== 'linux' || !(await altLoopbackBindable())) { t.skip(`${ALT_LOOPBACK} is not a bindable loopback alias on this host (Linux configures all of 127/8)`); return; }
  const { base, relay } = await boot(t, { advertise: ALT_LOOPBACK });
  await startApp();
  const h = await mirrorPort(base);
  const s = await appManager.share('app', { mode: 'lan', tls: false });
  assert.equal(s.relay.state, 'up');
  assert.equal(s.url, `http://${ALT_LOOPBACK}:${s.relay.port}`);
  const bound = await listeningAddrs(relay.proc.pid);
  assert.ok(bound.has(`127.0.0.1:${h}`) && !bound.has(`${ALT_LOOPBACK}:${h}`), [...bound].join(' '));
  assert.ok(bound.has(`${ALT_LOOPBACK}:${s.relay.port}`) && !bound.has(`127.0.0.1:${s.relay.port}`), [...bound].join(' '));
  assert.equal(await canConnect(h, '127.0.0.1'), true);
  assert.equal(await canConnect(s.relay.port, ALT_LOOPBACK), true);
});

// Invariant (S10): an ADOPTED app (running from before a code-hub restart, so
// no child of this process exits when it dies) that dies loses its mirror as
// soon as a host client finds its port refusing — with no API call and no
// store change.
test('M8: a dead adopted app\'s mirror closes on the first refused client', async (t) => {
  if (!requirePython(t)) return;
  const conns = new Set();
  const app = net.createServer((sock) => { conns.add(sock); sock.end('HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok'); });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  t.after(() => app.close());
  const sleeper = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1e9)'], { detached: true, stdio: 'ignore' });
  t.after(() => { try { process.kill(-sleeper.pid, 'SIGKILL'); } catch { /* gone */ } });
  const { relay } = await boot(t, {
    ids: [],
    beforeInit: async (root) => {
      await mkProject(root, 'app', { start: fakeAppCmd() });
      await fs.mkdir(storeRoot(), { recursive: true });
      const rec = { id: 'app', project: 'app', path: path.join(root, 'app'), isWorktree: false, branch: null, pid: sleeper.pid, pgid: sleeper.pid,
        port: app.address().port, fixedPort: null, startedSha: null, startedAt: null, tunnel: null };
      await fs.writeFile(path.join(storeRoot(), 'state.json'), JSON.stringify({ apps: { app: rec } }));
    },
  });
  await waitFor(() => loopbackMirror.hostPort('app') !== null, { timeout: 3000 });
  const h = loopbackMirror.hostPort('app');
  const appPort = app.address().port;
  assert.deepEqual(await get(h), { status: 200, body: 'ok' });
  process.kill(-sleeper.pid, 'SIGKILL');
  app.close();
  for (const c of conns) c.destroy();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(loopbackMirror.hostPort('app'), h, 'nothing else noticed the death');
  await canConnect(h); // a host client: its data connection finds the app's port refusing
  await waitFor(() => loopbackMirror.hostPort('app') === null, { timeout: 2000 });
  await waitFor(() => new RegExp(`closed loopback port ${appPort} \\(host port ${h}\\)`).test(relay.output().stderr), { timeout: 2000 });
});

// Invariant (S10): a mirror appears only once the app is ready — never while
// it is starting, when a relay listener could take the app's own port first —
// and every way readiness settles today (no readiness keys: the TCP probe;
// healthPath; readyWhen) reaches ready and is mirrored.
test('M7: no mirror while starting; every readiness kind reaches ready and is mirrored', async (t) => {
  if (!requirePython(t)) return;
  const marker = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'codehub-gate-')), 'go');
  t.after(() => fs.rm(path.dirname(marker), { recursive: true, force: true }));
  const manifests = {
    gated: { start: fakeAppCmd('gated', marker) },
    plain: { start: fakeAppCmd() },
    health: { start: fakeAppCmd(), healthPath: '/' },
    ready: { start: fakeAppCmd(), readyWhen: 'listening on' },
  };
  const { base, relay } = await boot(t, { ids: Object.keys(manifests), manifests });

  await appManager.start('gated');
  const { port } = await listedApp(base, 'gated');
  await new Promise((r) => setTimeout(r, 600));
  assert.equal((await listedApp(base, 'gated')).status, 'starting');
  assert.doesNotMatch(relay.output().stderr, new RegExp(`loopback port ${port} on host`));
  assert.equal((await listedApp(base, 'gated')).urls[0], `http://localhost:${port}`);
  await fs.writeFile(marker, '');
  await appManager.awaitSettled('gated');
  assert.deepEqual(await get(await mirrorPort(base, 'gated')), { status: 200, body: 'ok' });

  for (const id of ['plain', 'health', 'ready']) {
    await startApp(id);
    assert.equal((await listedApp(base, id)).status, 'ready', id);
    assert.deepEqual(await get(await mirrorPort(base, id)), { status: 200, body: 'ok' }, id);
  }
});
