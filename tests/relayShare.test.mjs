import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { promises as fs } from 'node:fs';
import { createServer } from '../server.js';
import * as appManager from '../src/appManager.js';
import * as hostRelay from '../src/hostRelay.js';
import * as relayStore from '../src/relayStore.js';
import { _setContainerProbe } from '../src/net.js';
import { storeRoot } from '../src/projects.js';
import {
  requirePython, startRelay, canConnect, waitFor, relaySecret, RELAY_PROTOCOL as P,
  mkRoot, rmRoot, mkProject, fakeAppCmd, fakeCloudflaredBin, fakeTailscaleBin, ALT_LOOPBACK, altLoopbackBindable,
} from './helpers.mjs';

// In-process code-hub (appManager + hostRelay, as server.js wires them) in a
// "container", sharing over LAN through the real Python relay.

const BRIDGE_ONLY = { eth0: [{ family: 'IPv4', address: '172.17.0.5', internal: false }] };

// A code-hub in a container with running fake apps `ids`, served over HTTP,
// its relay client started like server.js does: { root, base }.
async function boot(t, { ids = ['app'], interfaces } = {}) {
  process.env.CODEHUB_CLOUDFLARED_BIN = fakeCloudflaredBin;
  process.env.CODEHUB_TAILSCALE_BIN = fakeTailscaleBin;
  if (interfaces) t.mock.method(os, 'networkInterfaces', () => interfaces);
  _setContainerProbe(() => true);
  hostRelay._setLoopbackDialHost('127.0.0.1');
  relayStore._setHostPollMs(50);
  const root = await mkRoot();
  for (const id of ids) await mkProject(root, id, { start: fakeAppCmd() });
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
  for (const id of ids) {
    await appManager.start(id);
    await appManager.awaitSettled(id);
  }
  return { root, base: `http://127.0.0.1:${server.address().port}` };
}

async function relayFor(t, opts) {
  const relay = await startRelay(opts);
  t.after(() => relay.stop());
  return relay;
}

const api = async (base, method, p, body) => {
  const r = await fetch(base + p, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const listed = async (base, id = 'app') => (await api(base, 'GET', '/api/apps')).body.apps.find((a) => a.id === id);
const tunnelOf = async (base, id = 'app') => (await listed(base, id)).tunnel;
const share = (base, body, id = 'app') => api(base, 'POST', `/api/apps/${id}/share`, { mode: 'lan', ...body });
const portOf = (url) => Number(new URL(url).port);

// One request through a share (HTTPS ignores the self-signed cert): { status, headers }.
function hit(url, headers = {}) {
  const mod = url.startsWith('https:') ? https : http;
  return new Promise((resolve, reject) => {
    mod.get(url, { rejectUnauthorized: false, agent: false, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    }).on('error', reject);
  });
}

const upWithHostUrl = (base, id = 'app') => waitFor(async () => (await tunnelOf(base, id))?.relay?.state === 'up', { timeout: 4000 });

// Invariant (S1): with no relay configuration anywhere, a TLS LAN share of a
// code-hub in a container lists host URLs once the relay runs, and the gate
// holds end to end through it (401 bare, 200 with the token's cookie).
test('W1: zero-config — a TLS LAN share serves host URLs with the gate intact', async (t) => {
  if (!requirePython(t)) return;
  for (const k of Object.keys(process.env)) assert.ok(!/^CODEHUB_RELAY_(URL|SECRET)$/i.test(k), `${k} is set`);
  const { root, base } = await boot(t);
  await relayFor(t, { projectsRoot: root });
  await waitFor(() => hostRelay.status().state === 'up', { timeout: 4000 });
  const s = (await share(base, {})).body;
  const tunnel = await tunnelOf(base);
  assert.equal(tunnel.relay.state, 'up');
  assert.equal(tunnel.url, `https://127.0.0.1:${tunnel.relay.port}`);
  assert.deepEqual(tunnel.urls, [tunnel.url]);
  assert.equal(s.url, tunnel.url, 'the share answer already carries the host URL');

  assert.equal((await hit(tunnel.url)).status, 401);
  const exchanged = await hit(s.authUrl);
  assert.equal(exchanged.status, 302);
  const cookie = exchanged.headers['set-cookie'][0].split(';')[0];
  assert.equal((await hit(tunnel.url, { Cookie: cookie })).status, 200);

  const secret = await relaySecret(root);
  const listing = JSON.stringify((await api(base, 'GET', '/api/apps')).body);
  const stateJson = await fs.readFile(path.join(storeRoot(), 'state.json'), 'utf8');
  for (const [where, text] of [['listing', listing], ['state.json', stateJson]]) assert.ok(!text.includes(secret), `the relay secret in the ${where}`);
});

// Invariant (S1/S5): a relay that starts AFTER a TLS share was made still
// carries it — the listing turns to the host URL within seconds, and the
// certificate is re-issued to cover the newly advertised address.
test('W2: a relay started after the share picks it up, SAN included', async (t) => {
  if (!requirePython(t)) return;
  if (!(await altLoopbackBindable())) { t.skip(`${ALT_LOOPBACK} is not bindable on this host (no loopback alias)`); return; }
  const { root, base } = await boot(t);
  const s = (await share(base, {})).body;
  assert.equal(s.relay, null, 'no relay yet');
  assert.equal(portOf(s.url), s.proxyPort);
  await relayFor(t, { projectsRoot: root, advertise: ALT_LOOPBACK });
  const startedAt = Date.now();
  await upWithHostUrl(base);
  assert.ok(Date.now() - startedAt < 3000);
  const tunnel = await tunnelOf(base);
  assert.equal(tunnel.url, `https://${ALT_LOOPBACK}:${tunnel.relay.port}`);
  const san = await new Promise((resolve, reject) => {
    const sock = tls.connect({ host: ALT_LOOPBACK, port: tunnel.relay.port, rejectUnauthorized: false }, () => { resolve(sock.getPeerCertificate().subjectaltname); sock.destroy(); });
    sock.on('error', reject);
  });
  assert.ok(san.split(', ').includes(`IP Address:${ALT_LOOPBACK}`), san);
});

// Invariant (S2): any start order converges — relay first, a code-hub restart
// (its listeners go and come back), and a relay restart (the share flips to
// container URLs and back with no code-hub call).
test('W3: relay first, a hub restart and a relay restart all converge', async (t) => {
  if (!requirePython(t)) return;
  const root = await mkRoot();
  await fs.mkdir(path.join(root, '.code-hub'), { recursive: true });
  await relayStore.ensureSecret();
  const first = await relayFor(t, { projectsRoot: root });
  // The relay is up before code-hub boots (boot() makes its own root, so point it here).
  const { base } = await bootAt(t, root);
  const bootedAt = Date.now();
  await waitFor(() => hostRelay.status().state === 'up', { timeout: 3000 });
  assert.ok(Date.now() - bootedAt < 2500);
  const s = (await share(base, { tls: false })).body;
  const hostPort = s.relay.port;
  assert.equal(await canConnect(hostPort), true);

  // code-hub restarts: its session ends, then a fresh boot re-shares.
  hostRelay.stop();
  await waitFor(async () => !(await canConnect(hostPort)), { timeout: 2000 });
  await appManager.init();
  await hostRelay.init();
  await waitFor(() => hostRelay.status().state === 'up', { timeout: 3000 });
  const again = (await share(base, { tls: false })).body;
  assert.equal(again.relay.state, 'up');
  assert.equal((await hit(again.url)).status, 401);

  // The relay restarts: down to container URLs, then back up, untouched.
  await first.stop('SIGTERM');
  await waitFor(async () => (await tunnelOf(base)).relay?.state !== 'up', { timeout: 3000 });
  assert.equal(portOf((await tunnelOf(base)).url), again.proxyPort, 'the container URL while the relay is gone');
  await relayFor(t, { projectsRoot: root });
  await upWithHostUrl(base);
  assert.equal((await hit((await tunnelOf(base)).url)).status, 401);
});

// boot() at an existing root (W3's relay-first order).
async function bootAt(t, root) {
  process.env.CODEHUB_CLOUDFLARED_BIN = fakeCloudflaredBin;
  process.env.CODEHUB_TAILSCALE_BIN = fakeTailscaleBin;
  process.env.PROJECTS_ROOT = root;
  _setContainerProbe(() => true);
  hostRelay._setLoopbackDialHost('127.0.0.1');
  relayStore._setHostPollMs(50);
  await mkProject(root, 'app', { start: fakeAppCmd() });
  await appManager.init();
  await hostRelay.init();
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await appManager.stop('app').catch(() => {});
    hostRelay.stop();
    _setContainerProbe(null);
    hostRelay._setLoopbackDialHost(null);
    server.close();
    await rmRoot(root);
  });
  await appManager.start('app');
  await appManager.awaitSettled('app');
  return { base: `http://127.0.0.1:${server.address().port}` };
}

// Invariant (S3): port sync is live — a share made while connected is bound at
// once, and unsharing it closes its host port while another share stays.
test('W4: a second share binds live; unsharing it closes only its host port', async (t) => {
  if (!requirePython(t)) return;
  const { root, base } = await boot(t, { ids: ['app', 'two'] });
  await relayFor(t, { projectsRoot: root });
  await waitFor(() => hostRelay.status().state === 'up', { timeout: 4000 });
  const one = (await share(base, { tls: false }, 'app')).body;
  const two = (await share(base, { tls: false }, 'two')).body;
  assert.equal(two.relay.state, 'up');
  assert.equal(await canConnect(one.relay.port), true);
  assert.equal(await canConnect(two.relay.port), true);
  await api(base, 'DELETE', '/api/apps/two/share');
  await waitFor(async () => !(await canConnect(two.relay.port)), { timeout: 2000 });
  assert.equal(await canConnect(one.relay.port), true);
  assert.equal((await tunnelOf(base, 'app')).relay.port, one.relay.port);
});

// Invariant (S3): a busy host port falls back, and the URLs carry the port
// actually bound, flagged, with the requested (container) port named.
test('W5: a host-port collision shows the actual host port, flagged', async (t) => {
  if (!requirePython(t)) return;
  const { root, base } = await boot(t);
  await relayFor(t, { projectsRoot: root });
  await waitFor(() => hostRelay.status().state === 'up', { timeout: 4000 });
  await share(base, { tls: false });
  // The share's own proxy holds its port on every interface here, so the
  // relay can't take it on 127.0.0.1: the collision case, for real.
  const tunnel = await tunnelOf(base);
  assert.equal(tunnel.relay.portFallback, true);
  assert.equal(tunnel.relay.requestedPort, tunnel.proxyPort);
  assert.notEqual(tunnel.relay.port, tunnel.proxyPort);
  assert.deepEqual(tunnel.urls, [`http://127.0.0.1:${tunnel.relay.port}`]);
  assert.equal((await hit(tunnel.url)).status, 401);
});

// Invariant (S4): a relay that dies takes the exposure with it — the share
// goes back to its container URLs, relay down with the reason, and flagged
// container-internal.
test('W6: a SIGKILLed relay reverts the share to container URLs, down with a reason', async (t) => {
  if (!requirePython(t)) return;
  const { root, base } = await boot(t, { interfaces: BRIDGE_ONLY });
  const relay = await relayFor(t, { projectsRoot: root });
  await waitFor(() => hostRelay.status().state === 'up', { timeout: 4000 });
  const s = (await share(base, { tls: false })).body;
  assert.equal(s.relay.state, 'up');
  assert.equal(s.containerInternal, false);
  await relay.stop('SIGKILL');
  await waitFor(async () => (await tunnelOf(base)).relay.state === 'down', { timeout: 3000 });
  const down = await tunnelOf(base);
  assert.match(down.relay.error, /connection to the relay lost|ECONNREFUSED/);
  assert.equal(down.containerInternal, true);
  assert.equal(down.url, `http://172.17.0.5:${down.proxyPort}`);
});

// Invariant (S4): a relay that exits cleanly (withdrawing its relay file) leaves
// no relay to report — relay null — and the share is container-internal again.
test('W7: a clean relay exit reports no relay and container-internal', async (t) => {
  if (!requirePython(t)) return;
  const { root, base } = await boot(t, { interfaces: BRIDGE_ONLY });
  const relay = await relayFor(t, { projectsRoot: root });
  await waitFor(() => hostRelay.status().state === 'up', { timeout: 4000 });
  await share(base, { tls: false });
  await relay.stop('SIGTERM');
  await waitFor(async () => (await tunnelOf(base)).relay === null, { timeout: 3000 });
  const t2 = await tunnelOf(base);
  assert.equal(t2.containerInternal, true);
  assert.equal(t2.url, `http://172.17.0.5:${t2.proxyPort}`);
  assert.equal(hostRelay.status().state, 'absent');
});

const closedLog = (relay, proxyPort) => new RegExp(`closed ${P.scopes.lan} port ${proxyPort} \\(host port (\\d+)\\)`).exec(relay.output().stderr);

// Invariant (S5): every way a share ends — unshare, stop, and a share
// abandoned while it waited for the relay — withdraws its pair, so the relay
// closes the host port.
test('W8: unshare, stop and an abandoned share each withdraw the host port', { skip: process.platform === 'win32' ? 'POSIX signals only' : false }, async (t) => {
  if (!requirePython(t)) return;
  const { root, base } = await boot(t);
  const relay = await relayFor(t, { projectsRoot: root });
  await waitFor(() => hostRelay.status().state === 'up', { timeout: 4000 });
  for (const end of ['unshare', 'stop']) {
    if (end === 'stop') { await appManager.start('app').catch(() => {}); await appManager.awaitSettled('app'); }
    const s = (await share(base, { tls: false })).body;
    assert.equal(await canConnect(s.relay.port), true, end);
    if (end === 'unshare') await api(base, 'DELETE', '/api/apps/app/share');
    else await appManager.stop('app');
    await waitFor(() => closedLog(relay, s.proxyPort), { timeout: 2000 });
    assert.equal(await canConnect(s.relay.port), false, end);
  }
  await appManager.start('app');
  await appManager.awaitSettled('app');

  // Abandoned: the relay is frozen, so the share waits on its status; an
  // unshare cancels it meanwhile.
  relay.proc.kill('SIGSTOP');
  t.after(() => { try { relay.proc.kill('SIGCONT'); } catch { /* gone */ } });
  const sharing = appManager.share('app', { mode: 'lan', tls: false });
  await new Promise((r) => setTimeout(r, 300));
  await appManager.unshare('app');
  await assert.rejects(sharing, (e) => e.statusCode === 409);
  relay.proc.kill('SIGCONT');
  const bound = new RegExp(`${P.scopes.lan} port (\\d+) on host \\S+ port (\\d+)`, 'g');
  await waitFor(() => [...relay.output().stderr.matchAll(bound)].length === 3, { timeout: 3000 });
  const [, proxyPort, hostPort] = [...relay.output().stderr.matchAll(bound)][2];
  await waitFor(() => closedLog(relay, proxyPort), { timeout: 3000 });
  assert.equal(await canConnect(Number(hostPort)), false);
  assert.equal((await tunnelOf(base)), null);
});

// Invariant (S1/S6): code-hub dials the relay only from inside a container — a
// native code-hub never connects, even to a valid relay file.
test('W9: outside a container code-hub never dials, even with a valid relay file', async (t) => {
  if (!requirePython(t)) return;
  const { root, base } = await boot(t);
  _setContainerProbe(() => false);
  await hostRelay.init();
  const relay = await relayFor(t, { projectsRoot: root });
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(hostRelay.status().state, 'off');
  assert.doesNotMatch(relay.output().stderr, /control session \S+ opened/);
  const s = (await share(base, { tls: false })).body;
  assert.equal(s.relay, null);
  assert.equal(portOf(s.url), s.proxyPort);
});

// Invariant (S5): a burst well past the relay's old fixed cap of 8 — 24
// concurrent clients over two shares, against the unpatched relay — all get
// through, because code-hub's own handshake bound stays under the relay's cap.
test('B1: 24 concurrent clients over two shares all complete through the real relay', async (t) => {
  if (!requirePython(t)) return;
  const { root, base } = await boot(t, { ids: ['app', 'two'] });
  await relayFor(t, { projectsRoot: root });
  await waitFor(() => hostRelay.status().state === 'up', { timeout: 4000 });
  const urls = [];
  for (const id of ['app', 'two']) urls.push((await share(base, { tls: false, auth: false }, id)).body.url);
  const results = await Promise.all(Array.from({ length: 24 }, (_, i) => hit(urls[i % 2]).then((r) => r.status, (e) => e.message)));
  assert.deepEqual(results, Array(24).fill(200));
});
