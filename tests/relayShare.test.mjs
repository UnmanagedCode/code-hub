import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { promises as fs, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from '../server.js';
import * as appManager from '../src/appManager.js';
import { _setContainerProbe } from '../src/net.js';
import { storeRoot } from '../src/projects.js';
import {
  REPO_ROOT, requirePython, startRelay, withRelayEnv, relayCall, canConnect, waitFor, holdShareAtSettingsRead, holdStateWrite,
  mkRoot, rmRoot, mkProject, fakeAppCmd, fakeCloudflaredBin, fakeTailscaleBin, ALT_LOOPBACK, altLoopbackBindable,
} from './helpers.mjs';

// In-process code-hub sharing over LAN with the real Python relay configured.

const PROTOCOL = JSON.parse(readFileSync(path.join(REPO_ROOT, 'relay', 'protocol.json'), 'utf8'));
const P = PROTOCOL.paths;

async function relayFor(t, opts) {
  const relay = await startRelay(opts);
  t.after(() => relay.stop());
  return relay;
}

// A code-hub with one running fake app 'app', served over HTTP.
async function boot(t) {
  process.env.CODEHUB_CLOUDFLARED_BIN = fakeCloudflaredBin;
  process.env.CODEHUB_TAILSCALE_BIN = fakeTailscaleBin;
  const root = await mkRoot();
  await mkProject(root, 'app', { start: fakeAppCmd() });
  await appManager.init();
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await appManager.stop('app').catch(() => {});
    server.close();
    await rmRoot(root);
  });
  await appManager.start('app');
  await appManager.awaitSettled('app');
  return { root, base: `http://127.0.0.1:${server.address().port}` };
}

const api = async (base, method, p, body) => {
  const r = await fetch(base + p, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const listed = async (base) => (await api(base, 'GET', '/api/apps')).body.apps.find((a) => a.id === 'app');

// One HTTPS request through a share, ignoring the self-signed cert: { status, headers }.
function hit(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { rejectUnauthorized: false, agent: false, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    }).on('error', reject);
  });
}

const portOf = (url) => Number(new URL(url).port);
const forwardsOn = async (relay) => (await relayCall(relay, 'GET', P.health)).body.forwards;
const noForwards = (relay, timeout = 1000) => waitFor(async () => (await forwardsOn(relay)) === 0, { timeout });

function restoreRelayEnv(t) {
  const prev = { url: process.env.CODEHUB_RELAY_URL, secret: process.env.CODEHUB_RELAY_SECRET };
  t.after(() => {
    for (const [k, v] of [['CODEHUB_RELAY_URL', prev.url], ['CODEHUB_RELAY_SECRET', prev.secret]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
}

// Invariant: a relay-backed LAN share advertises only host URLs (relay up, forward id never exposed), and the auth gate and TLS work end to end through the relay.
test('S1: a relay-backed LAN share serves host URLs and keeps the gate end to end', async (t) => {
  if (!requirePython(t)) return;
  const relay = await relayFor(t, { leaseMs: 5000 });
  withRelayEnv(t, relay);
  const { base } = await boot(t);
  const shared = await api(base, 'POST', '/api/apps/app/share', { mode: 'lan' });
  assert.equal(shared.status, 200);
  const s = shared.body;
  assert.equal(s.relay.state, 'up');
  assert.equal(s.relay.forwardId, undefined);
  assert.equal(s.containerInternal, false);
  assert.equal(s.url, `https://127.0.0.1:${s.relay.port}`);
  assert.deepEqual(s.urls, [s.url]);
  const app = await listed(base);
  assert.equal(app.tunnel.url, s.url);
  assert.equal(app.tunnel.relay.state, 'up');
  assert.equal(app.tunnel.relay.forwardId, undefined);

  assert.equal((await hit(s.url)).status, 401);
  const exchanged = await hit(s.authUrl);
  assert.equal(exchanged.status, 302);
  const cookie = exchanged.headers['set-cookie'][0].split(';')[0];
  assert.equal((await hit(s.url, { Cookie: cookie })).status, 200);
  const basic = Buffer.from(`${s.username}:${s.password}`).toString('base64');
  assert.equal((await hit(s.url, { Authorization: `Basic ${basic}` })).status, 200);

  // The relay secret is never served or persisted.
  const listing = await api(base, 'GET', '/api/apps');
  const stateJson = await fs.readFile(path.join(storeRoot(), 'state.json'), 'utf8');
  for (const [where, text] of [['share response', JSON.stringify(s)], ['listing', JSON.stringify(listing.body)], ['state.json', stateJson]]) {
    assert.ok(!text.includes(relay.secret), `relay secret in the ${where}`);
  }
});

// Invariant: the share's cert carries the relay's advertised host address in its SAN, so the host URL gets no name mismatch.
test('S1b: the share certificate\'s SAN includes the relay\'s advertised address', async (t) => {
  if (!requirePython(t)) return;
  if (!(await altLoopbackBindable())) { t.skip(`${ALT_LOOPBACK} is not bindable on this host (no loopback alias)`); return; }
  const relay = await relayFor(t, { leaseMs: 5000, advertise: ALT_LOOPBACK });
  withRelayEnv(t, relay);
  const { base } = await boot(t);
  const s = (await api(base, 'POST', '/api/apps/app/share', { mode: 'lan' })).body;
  assert.equal(s.url, `https://${ALT_LOOPBACK}:${s.relay.port}`);
  const san = await new Promise((resolve, reject) => {
    const sock = tls.connect({ host: ALT_LOOPBACK, port: s.relay.port, rejectUnauthorized: false }, () => { resolve(sock.getPeerCertificate().subjectaltname); sock.destroy(); });
    sock.on('error', reject);
  });
  assert.ok(san.split(', ').includes(`IP Address:${ALT_LOOPBACK}`), san);
});

// Invariant: every lifecycle path that ends a share (unshare, stop, restart) closes its relay forward at once, not at lease expiry.
test('S2: unshare, stop and restart each release the relay forward well before the lease', async (t) => {
  if (!requirePython(t)) return;
  const relay = await relayFor(t, { leaseMs: 5000 });
  withRelayEnv(t, relay);
  const { base } = await boot(t);
  for (const action of ['unshare', 'stop', 'restart']) {
    if (action !== 'unshare' && !(await listed(base)).status.match(/ready|running/)) {
      await appManager.start('app'); await appManager.awaitSettled('app');
    }
    const s = await appManager.share('app', { mode: 'lan', tls: false });
    assert.equal(s.relay.state, 'up', action);
    assert.equal(await canConnect(s.relay.port), true, action);
    if (action === 'unshare') await appManager.unshare('app');
    if (action === 'stop') await appManager.stop('app');
    if (action === 'restart') { await appManager.restart('app'); await appManager.awaitSettled('app'); }
    await noForwards(relay); // well before the 5000ms lease
  }
});

// Invariant: a relay failure never breaks the share — it still answers 200 on the container's own URLs, with the reason on relay.error.
test('S3: an unreachable relay, a bad secret or a bad URL fail the relay, not the share', async (t) => {
  if (!requirePython(t)) return;
  const relay = await relayFor(t, { leaseMs: 5000 });
  const { base } = await boot(t);
  restoreRelayEnv(t);
  const cases = [
    // Port 9 on loopback (discard): nothing listens there on a test host, but
    // whatever answers, the invariant is the same — the share goes on.
    [{ url: 'http://127.0.0.1:9', secret: relay.secret }, /./],
    [{ url: relay.url, secret: 'w'.repeat(43) }, /refused CODEHUB_RELAY_SECRET \(401\)/],
    [{ url: relay.url, secret: '' }, /CODEHUB_RELAY_SECRET is empty/],
    [{ url: 'not a url', secret: relay.secret }, /CODEHUB_RELAY_URL 'not a url' is not a URL/],
    [{ url: `https://127.0.0.1:${relay.port}`, secret: relay.secret }, /CODEHUB_RELAY_URL must be an http: URL/],
  ];
  for (const [env, reason] of cases) {
    process.env.CODEHUB_RELAY_URL = env.url;
    process.env.CODEHUB_RELAY_SECRET = env.secret;
    const res = await api(base, 'POST', '/api/apps/app/share', { mode: 'lan', tls: false });
    assert.equal(res.status, 200, env.url);
    assert.equal(res.body.relay.state, 'failed', env.url);
    assert.ok(res.body.relay.error, `a reason for ${env.url}`);
    assert.match(res.body.relay.error, reason);
    assert.equal(portOf(res.body.url), res.body.proxyPort, 'the container URL of the share\'s own proxy');
    assert.equal((await listed(base)).tunnel.relay.state, 'failed');
  }
  assert.equal(await forwardsOn(relay), 0);
});

// state.json holding app 'app' with a LAN share whose relay forward is `forwardId`.
async function seedState(root, { pid, forwardId, port }) {
  await fs.mkdir(storeRoot(), { recursive: true });
  const tunnel = { kind: 'lan', url: `http://127.0.0.1:${port}`, urls: [`http://127.0.0.1:${port}`], pid: null, proxyPort: 1, auth: true, tls: false,
    relay: { state: 'up', error: null, forwardId, port, requestedPort: null, portFallback: false }, containerInternal: false };
  const rec = { id: 'app', project: 'app', path: path.join(root, 'app'), isWorktree: false, branch: null, pid, pgid: pid, port: 1, urls: [], startedSha: null, startedAt: null, tunnel };
  await fs.writeFile(path.join(storeRoot(), 'state.json'), JSON.stringify({ apps: { app: rec } }));
}

// Invariant: the boot sweep releases the relay forward of a live app's persisted LAN share.
test('S4: init() releases a live app\'s persisted relay forward before its lease', async (t) => {
  if (!requirePython(t)) return;
  const relay = await relayFor(t, { leaseMs: 5000 });
  withRelayEnv(t, relay);
  process.env.CODEHUB_TAILSCALE_BIN = fakeTailscaleBin;
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const live = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1e9)'], { detached: true, stdio: 'ignore' });
  t.after(() => { try { process.kill(-live.pid, 'SIGKILL'); } catch { /* gone */ } });
  const { body: fwd } = await relayCall(relay, 'POST', P.forwards, {});
  await seedState(root, { pid: live.pid, forwardId: fwd.id, port: fwd.port });
  await appManager.init();
  await noForwards(relay);
  assert.equal((await relayCall(relay, 'POST', P.renew.replace('{id}', fwd.id))).status, 404);
});

// Invariant: a record reconcile drops (dead app pid) still has its relay forward released.
test('S5: init() releases the relay forward of a dead app\'s dropped record', async (t) => {
  if (!requirePython(t)) return;
  const relay = await relayFor(t, { leaseMs: 5000 });
  withRelayEnv(t, relay);
  process.env.CODEHUB_TAILSCALE_BIN = fakeTailscaleBin;
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const { body: fwd } = await relayCall(relay, 'POST', P.forwards, {});
  await seedState(root, { pid: 2 ** 30, forwardId: fwd.id, port: fwd.port });
  await appManager.init();
  await noForwards(relay);
});

// Invariant: a LAN share abandoned in flight (its app stopped) closes the forward it opened.
test('S6: stopping the app while its LAN share is held leaves no forward behind', async (t) => {
  if (!requirePython(t)) return;
  const relay = await relayFor(t, { leaseMs: 5000 });
  withRelayEnv(t, relay);
  await boot(t);
  const hold = holdShareAtSettingsRead(t);
  const sharing = appManager.share('app', { mode: 'lan', tls: false });
  await hold.parked;
  await appManager.stop('app');
  hold.release();
  await assert.rejects(sharing, (e) => e.statusCode === 409);
  assert.match(relay.output().stderr, /forward \S+ open on/, 'the abandoned share did open a forward');
  await noForwards(relay);
});

// Invariant: containerInternal is set for a bridge-only container share without a relay, and cleared while the relay is up.
test('S7: containerInternal flags a bridge-only container share, and clears with the relay up', async (t) => {
  if (!requirePython(t)) return;
  _setContainerProbe(() => true);
  t.after(() => _setContainerProbe(null));
  t.mock.method(os, 'networkInterfaces', () => ({ eth0: [{ family: 'IPv4', address: '172.17.0.5', internal: false }] }));
  const { base } = await boot(t);
  const prev = { url: process.env.CODEHUB_RELAY_URL, secret: process.env.CODEHUB_RELAY_SECRET };
  delete process.env.CODEHUB_RELAY_URL;
  const bare = await appManager.share('app', { mode: 'lan', tls: false });
  assert.equal(bare.containerInternal, true);
  assert.equal(bare.relay, null);
  assert.equal(bare.url, `http://172.17.0.5:${bare.proxyPort}`);
  assert.equal((await listed(base)).tunnel.containerInternal, true);
  if (prev.url !== undefined) process.env.CODEHUB_RELAY_URL = prev.url;

  const relay = await startRelay({ leaseMs: 600 });
  t.after(() => relay.stop());
  withRelayEnv(t, relay);
  const relayed = await appManager.share('app', { mode: 'lan', tls: false });
  assert.equal(relayed.relay.state, 'up');
  assert.equal(relayed.containerInternal, false);
  assert.equal((await listed(base)).tunnel.containerInternal, false);

  // The relay goes away: down, and the share is container-internal again.
  await relay.stop();
  await waitFor(async () => (await listed(base)).tunnel.relay.state === 'down', { timeout: 3000 });
  const down = (await listed(base)).tunnel;
  assert.equal(down.containerInternal, true);
  assert.equal(down.url, `http://172.17.0.5:${down.proxyPort}`);

  // A share made while the relay can't be reached: failed, and container-internal.
  const failed = await appManager.share('app', { mode: 'lan', tls: false });
  assert.equal(failed.relay.state, 'failed');
  assert.equal(failed.containerInternal, true);
  assert.equal((await listed(base)).tunnel.containerInternal, true);
});

// Invariant: a relay down→up cycle re-points the live share's URLs (and persists them): container URLs while down, host URLs again once the forward is re-created.
test('S8: a relay restart re-points the share to container URLs while down and back to host URLs when up', async (t) => {
  if (!requirePython(t)) return;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codehub-relay-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const secretFile = path.join(dir, 'secret');
  const first = await startRelay({ leaseMs: 600, secretFile });
  t.after(() => first.stop());
  withRelayEnv(t, first);
  const { base } = await boot(t);
  const s = await appManager.share('app', { mode: 'lan', tls: false });
  const hostUrl = `http://127.0.0.1:${s.relay.port}`;
  assert.equal(s.url, hostUrl);
  const persisted = async () => JSON.parse(await fs.readFile(path.join(storeRoot(), 'state.json'), 'utf8')).apps.app.tunnel;

  await first.stop();
  await waitFor(async () => (await listed(base)).tunnel.relay.state === 'down', { timeout: 3000 });
  assert.notEqual((await listed(base)).tunnel.url, hostUrl);
  assert.equal(portOf((await listed(base)).tunnel.url), s.proxyPort, 'the container URL while down');
  await waitFor(async () => (await persisted()).relay.state === 'down');

  const second = await startRelay({ leaseMs: 600, secretFile, listenPort: first.port });
  t.after(() => second.stop());
  await waitFor(async () => (await listed(base)).tunnel.relay.state === 'up', { timeout: 3000 });
  assert.equal((await listed(base)).tunnel.url, hostUrl, 'the same host port again');
  await waitFor(async () => (await persisted()).relay.state === 'up');
  const p = await persisted();
  assert.equal(p.url, hostUrl);
  assert.equal(p.relay.forwardId !== undefined && p.relay.forwardId !== null, true);
  assert.equal(await forwardsOn(second), 1);
});

// A running record for app 'app' adopted from state.json (a live sleeper pid,
// so no in-process runtime) — what list()'s prune and start()'s replacement act on.
async function adoptSleeper(t, root) {
  const sleeper = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1e9)'], { detached: true, stdio: 'ignore' });
  t.after(() => { try { process.kill(-sleeper.pid, 'SIGKILL'); } catch { /* gone */ } });
  const app = net.createServer((sock) => sock.end('HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n'));
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  t.after(() => app.close());
  await fs.mkdir(storeRoot(), { recursive: true });
  const rec = { id: 'app', project: 'app', path: path.join(root, 'app'), isWorktree: false, branch: null, pid: sleeper.pid, pgid: sleeper.pid,
    port: app.address().port, urls: [], startedSha: null, startedAt: null, tunnel: null };
  await fs.writeFile(path.join(storeRoot(), 'state.json'), JSON.stringify({ apps: { app: rec } }));
  await appManager.init();
  return sleeper;
}

async function bootAdopted(t) {
  process.env.CODEHUB_CLOUDFLARED_BIN = fakeCloudflaredBin;
  process.env.CODEHUB_TAILSCALE_BIN = fakeTailscaleBin;
  const root = await mkRoot();
  t.after(async () => { await appManager.stop('app').catch(() => {}); await rmRoot(root); });
  await mkProject(root, 'app', { start: fakeAppCmd() });
  const sleeper = await adoptSleeper(t, root);
  return { root, sleeper };
}

const killed = (pid) => { process.kill(-pid, 'SIGKILL'); return waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } }); };

// Invariant: list()'s prune of a record whose app died releases its relay forward at once.
test('S9: list() pruning a dead app releases its relay forward before the lease', async (t) => {
  if (!requirePython(t)) return;
  const relay = await relayFor(t, { leaseMs: 5000 });
  withRelayEnv(t, relay);
  const { sleeper } = await bootAdopted(t);
  const s = await appManager.share('app', { mode: 'lan', tls: false });
  assert.equal(s.relay.state, 'up');
  assert.equal(await forwardsOn(relay), 1);
  await killed(sleeper.pid);
  const app = (await appManager.list()).apps.find((a) => a.id === 'app');
  assert.equal(app.status, 'stopped');
  await noForwards(relay);
});

// Invariant: start() replacing a dead app's record releases that record's relay forward at once.
test('S10: start() replacing a dead app\'s record releases its relay forward before the lease', async (t) => {
  if (!requirePython(t)) return;
  const relay = await relayFor(t, { leaseMs: 5000 });
  withRelayEnv(t, relay);
  const { sleeper } = await bootAdopted(t);
  const s = await appManager.share('app', { mode: 'lan', tls: false });
  assert.equal(s.relay.state, 'up');
  await killed(sleeper.pid);
  await appManager.start('app');
  await noForwards(relay);
});

// Invariant: an in-process re-init() discards every live share's relay forward at once.
test('S11: a re-run init() releases a live share\'s relay forward before the lease', async (t) => {
  if (!requirePython(t)) return;
  const relay = await relayFor(t, { leaseMs: 5000 });
  withRelayEnv(t, relay);
  await boot(t);
  const s = await appManager.share('app', { mode: 'lan', tls: false });
  assert.equal(s.relay.state, 'up');
  await appManager.init();
  await noForwards(relay);
});

// Invariant: init()'s discard of the previous in-memory records releases a LAN
// share's relay forward — in the window where the share has committed but its
// state.json write hasn't landed, so neither init's load nor reconcile can see
// it. (Were the discard loop to skip LAN tunnels, nothing would release this
// forward before its lease: the load reads the pre-share file, so reconcile
// finds no tunnel to hand back.)
test('S12: init() during a share\'s post-commit persist releases its relay forward', async (t) => {
  if (!requirePython(t)) return;
  const relay = await relayFor(t, { leaseMs: 5000 });
  withRelayEnv(t, relay);
  await boot(t);
  const hold = holdStateWrite(t);
  const sharing = appManager.share('app', { mode: 'lan', tls: false });
  await hold.parked; // committed, attached, not yet on disk
  assert.equal(await forwardsOn(relay), 1);
  const initing = appManager.init();
  await hold.stateRead; // init has discarded and loaded the pre-share state.json
  hold.release();
  await Promise.all([sharing, initing]);
  await noForwards(relay); // well before the 5000ms lease
});

