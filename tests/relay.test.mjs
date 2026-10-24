import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { promises as fs, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import * as hostRelay from '../src/hostRelay.js';
import * as appManager from '../src/appManager.js';
import { generateSelfSigned } from '../src/selfsigned.js';
import {
  REPO_ROOT, requirePython, startRelay, runRelay, withRelayEnv, relayCall, canConnect, waitFor,
  mkRoot, rmRoot, mkProject, fakeAppCmd, fakeCloudflaredBin, fakeTailscaleBin,
} from './helpers.mjs';

// The real Python relay (relay/relay.py) over loopback, driven raw and through
// src/hostRelay.js. Every relay advertises 127.0.0.1, so the route probe never
// runs (except R15, which forces it through its test seam).

const PROTOCOL = JSON.parse(readFileSync(path.join(REPO_ROOT, 'relay', 'protocol.json'), 'utf8'));
const P = PROTOCOL.paths;
const at = (template, id) => template.replace('{id}', id);
const PROTOCOL_IDS = [...Object.values(P), ...Object.values(PROTOCOL.errorCodes), PROTOCOL.upgradeToken];

async function relayFor(t, opts) {
  const relay = await startRelay(opts);
  t.after(() => relay.stop());
  return relay;
}

function handleFor(t, handle) {
  t.after(() => handle.close());
  return handle;
}

// Park one accept on forward `id`: resolves { upgraded: true, socket, head } once
// the relay splices a LAN client onto it, or { upgraded: false, status } when it
// answers instead.
function parkAccept(relay, id, { secret = relay.secret } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: relay.port, path: at(P.accept, id), agent: false,
      headers: { Connection: 'Upgrade', Upgrade: PROTOCOL.upgradeToken, ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
    });
    req.on('upgrade', (_res, socket, head) => resolve({ upgraded: true, socket, head, req }));
    req.on('response', (res) => { res.resume(); resolve({ upgraded: false, status: res.statusCode, req }); });
    req.on('error', reject);
    req.end();
  });
}

// A live view of what `socket` has received: { data, closed }.
function tap(socket, initial = '') {
  const view = { data: initial, closed: false };
  socket.on('data', (d) => { view.data += d; });
  socket.on('error', () => {});
  socket.on('close', () => { view.closed = true; });
  return view;
}

// Everything a raw client receives until the peer closes: { data, closedAt }.
function collect(socket) {
  return new Promise((resolve) => {
    let data = '';
    socket.on('data', (d) => { data += d; });
    socket.on('error', () => {});
    socket.on('close', () => resolve({ data, closedAt: Date.now() }));
  });
}

const connect = (port) => new Promise((resolve, reject) => {
  const s = net.connect(port, '127.0.0.1', () => resolve(s));
  s.once('error', reject);
});

const echoServer = async (t) => {
  const srv = net.createServer((s) => { s.on('error', () => {}); s.pipe(s); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  return srv.address().port;
};

const healthForwards = async (relay) => (await relayCall(relay, 'GET', P.health)).body.forwards;

// Invariant: the control API is authenticated — every endpoint, the accept upgrade included, answers 401 to a missing or wrong bearer and creates nothing.
test('R1: every endpoint refuses a missing or wrong bearer with 401 and creates no listener', async (t) => {
  if (!requirePython(t)) return;
  const relay = await relayFor(t, { leaseMs: 5000 });
  const { body: fwd } = await relayCall(relay, 'POST', P.forwards, {});
  for (const secret of [null, 'x'.repeat(43)]) {
    assert.equal((await relayCall(relay, 'GET', P.health, undefined, { secret })).status, 401);
    assert.equal((await relayCall(relay, 'POST', P.forwards, {}, { secret })).status, 401);
    assert.equal((await relayCall(relay, 'POST', at(P.renew, fwd.id), undefined, { secret })).status, 401);
    assert.equal((await relayCall(relay, 'DELETE', at(P.forward, fwd.id), undefined, { secret })).status, 401);
    const accept = await parkAccept(relay, fwd.id, { secret });
    assert.deepEqual([accept.upgraded, accept.status], [false, 401]);
  }
  assert.equal(await healthForwards(relay), 1, 'only the authenticated forward exists');
  assert.equal((await relayCall(relay, 'POST', at(P.renew, fwd.id))).status, 200, 'and the refused DELETEs left it alone');
});

// Invariant: no target exists in the protocol — a create body naming a host/target, a privileged port or not an object is refused.
test('R2: a create body with a target, a host, a privileged port or a non-object is 400', async (t) => {
  if (!requirePython(t)) return;
  const relay = await relayFor(t);
  for (const body of [{ host: '10.0.0.1' }, { target: '10.0.0.1:22' }, { port: 80 }, { port: '8080' }, [], 'x', 5, '{not json']) {
    const res = await relayCall(relay, 'POST', P.forwards, body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  assert.equal(await healthForwards(relay), 0);
});

// Invariant: a LAN client gets only the forwarded share — with no parked accept it is dropped after the wait and never reaches the control API.
test('R3: a LAN client with no parked accept is dropped after the wait and never reaches the control API', async (t) => {
  if (!requirePython(t)) return;
  const relay = await relayFor(t, { acceptWaitMs: 200, leaseMs: 5000 });
  const { body: fwd } = await relayCall(relay, 'POST', P.forwards, {});
  const s = await connect(fwd.port);
  const opened = Date.now();
  const got = collect(s);
  s.write(`GET ${P.health} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${relay.secret}\r\n\r\n`);
  const { data, closedAt } = await got;
  assert.equal(data, '', 'no bytes, let alone JSON, come back');
  assert.ok(closedAt - opened >= 150, `dropped after the wait, not before (${closedAt - opened}ms)`);
});

// Invariant: bytes pass through untouched — TLS ends at the origin (its cert is what the client sees) and the body round-trips.
test('R4: through hostRelay the TLS peer is the origin itself and the body round-trips', async (t) => {
  if (!requirePython(t)) return;
  const relay = await relayFor(t, { leaseMs: 5000 });
  withRelayEnv(t, relay);
  const { key, cert } = generateSelfSigned({ ipAddresses: ['127.0.0.1'], dnsNames: ['localhost'] });
  const origin = https.createServer({ key, cert }, (req, res) => res.end(`hello ${req.url}`));
  await new Promise((r) => origin.listen(0, '127.0.0.1', r));
  t.after(() => origin.close());
  const handle = handleFor(t, await hostRelay.openForward({}));
  handle.attach({ host: '127.0.0.1', port: origin.address().port });

  const peer = await new Promise((resolve, reject) => {
    const s = tls.connect({ host: '127.0.0.1', port: handle.port, rejectUnauthorized: false }, () => { resolve(s.getPeerX509Certificate()); s.destroy(); });
    s.on('error', reject);
  });
  assert.equal(peer.fingerprint256, new crypto.X509Certificate(cert).fingerprint256);
  const body = await new Promise((resolve, reject) => {
    https.get({ host: '127.0.0.1', port: handle.port, path: '/ping', rejectUnauthorized: false, agent: false }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve(d));
    }).on('error', reject);
  });
  assert.equal(body, 'hello /ping');
});

// Invariant: a forward that is never renewed expires — its port refuses connections and renew answers 404.
test('R5: an unrenewed forward expires within about 3 leases: it is gone and renew is 404', async (t) => {
  if (!requirePython(t)) return;
  const relay = await relayFor(t, { leaseMs: 300 });
  const { body: fwd } = await relayCall(relay, 'POST', P.forwards, {});
  assert.equal(await canConnect(fwd.port), true);
  await waitFor(async () => (await healthForwards(relay)) === 0, { timeout: 3 * 300 });
  assert.equal((await relayCall(relay, 'POST', at(P.renew, fwd.id))).status, 404);
});

// Invariant: hostRelay's renewal keeps a forward alive well past its lease.
test('R6: a hostRelay forward stays connectable for at least 5 lease periods', async (t) => {
  if (!requirePython(t)) return;
  const relay = await relayFor(t, { leaseMs: 600 });
  withRelayEnv(t, relay);
  const handle = handleFor(t, await hostRelay.openForward({}));
  const until = Date.now() + 5 * 600 + 100;
  while (Date.now() < until) {
    assert.equal(await canConnect(handle.port), true);
    assert.equal(handle.state, 'up');
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal((await relayCall(relay, 'POST', at(P.renew, handle.id))).status, 200);
});

// Invariant: a crashed code-hub leaves nothing behind — its forward closes within the lease.
test('R7: SIGKILLing the code-hub side closes its forward within the lease', async (t) => {
  if (!requirePython(t)) return;
  const relay = await relayFor(t, { leaseMs: 1000 });
  const child = spawn(process.execPath, [path.join(REPO_ROOT, 'tests', 'fixtures', 'relay-client.mjs')], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, CODEHUB_RELAY_URL: relay.url, CODEHUB_RELAY_SECRET: relay.secret },
  });
  t.after(() => child.kill('SIGKILL'));
  const { port } = await new Promise((resolve) => {
    let out = '';
    child.stdout.on('data', (d) => { out += d; if (out.includes('\n')) resolve(JSON.parse(out)); });
  });
  await new Promise((r) => setTimeout(r, 1200)); // renewed past one lease while alive
  assert.equal(await canConnect(port), true);
  assert.equal(await healthForwards(relay), 1);
  child.kill('SIGKILL');
  await waitFor(async () => (await healthForwards(relay)) === 0, { timeout: 1000 + 1000 });
});

// Invariant: DELETE closes immediately — the listener goes and a live spliced connection is cut on both sides.
test('R8: DELETE closes the listener and cuts a live spliced connection', async (t) => {
  if (!requirePython(t)) return;
  const relay = await relayFor(t, { leaseMs: 5000 });
  const { body: fwd } = await relayCall(relay, 'POST', P.forwards, {});
  const parked = parkAccept(relay, fwd.id);
  const lanSocket = await connect(fwd.port);
  const lan = tap(lanSocket);
  lanSocket.write('ping');
  const { upgraded, socket: hubSocket, head } = await parked;
  assert.equal(upgraded, true);
  const hub = tap(hubSocket, head.toString());
  await waitFor(() => hub.data.includes('ping'));
  hubSocket.write('pong');
  await waitFor(() => lan.data.includes('pong'));
  assert.equal((await relayCall(relay, 'DELETE', at(P.forward, fwd.id))).status, 204);
  await waitFor(() => lan.closed && hub.closed, { timeout: 2000 });
  assert.equal(await healthForwards(relay), 0);
});

// Invariant: a LAN client that connects before any accept is parked is spliced onto the first one that parks, its early bytes delivered first and in order.
test('R18: a LAN client waiting for an accept is handed the next one parked, early bytes first', async (t) => {
  if (!requirePython(t)) return;
  const relay = await relayFor(t, { leaseMs: 5000, acceptWaitMs: 5000 });
  const { body: fwd } = await relayCall(relay, 'POST', P.forwards, {});
  const lanSocket = await connect(fwd.port);
  const lan = tap(lanSocket);
  lanSocket.write('first;');
  lanSocket.write('second;');
  await new Promise((r) => setTimeout(r, 150)); // queued, nothing parked yet
  const { upgraded, socket: hubSocket, head } = await parkAccept(relay, fwd.id);
  assert.equal(upgraded, true);
  const hub = tap(hubSocket, head.toString());
  lanSocket.write('third;');
  await waitFor(() => hub.data.includes('third;'));
  assert.equal(hub.data, 'first;second;third;');
  hubSocket.write('back');
  await waitFor(() => lan.data === 'back');
  hubSocket.destroy();
  lanSocket.destroy();
});

// Invariant: the accept pool stays at ACCEPT_POOL parked accepts across repeated down→up cycles — drained slots never come back alongside the fresh ones.
test('R19: the accept pool does not grow across down→up cycles', async (t) => {
  if (!requirePython(t)) return;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codehub-relay-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const secretFile = path.join(dir, 'secret');
  let relay = await startRelay({ leaseMs: 300, secretFile });
  const relays = [relay];
  t.after(() => Promise.all(relays.map((r) => r.stop())));
  withRelayEnv(t, relay);
  const target = await echoServer(t);
  const handle = handleFor(t, await hostRelay.openForward({}));
  handle.attach({ host: '127.0.0.1', port: target });
  const parked = async () => (await relayCall(relay, 'GET', P.health)).body.parked;
  await waitFor(async () => (await parked()) === 4);
  for (let cycle = 0; cycle < 2; cycle++) {
    const port = relay.port;
    await relay.stop();
    await waitFor(() => handle.state === 'down', { timeout: 3000 });
    relay = await startRelay({ leaseMs: 300, secretFile, listenPort: port });
    relays.push(relay);
    await waitFor(() => handle.state === 'up', { timeout: 3000 });
  }
  await waitFor(async () => (await parked()) === 4, { timeout: 3000 });
  await new Promise((r) => setTimeout(r, 1500)); // past every re-park floor and backoff
  assert.equal(await parked(), 4);
});

// Invariant: the control listener is never LAN-reachable — a wildcard or a non-loopback advertised listen address is refused before any socket, and loopback+loopback starts.
test('R9: the relay refuses a wildcard or an advertised non-loopback --listen before binding, and starts on loopback', async (t) => {
  if (!requirePython(t)) return;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codehub-relay-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const secret = ['--secret-file', path.join(dir, 'secret')];
  const wildcard = await runRelay(['--listen', '0.0.0.0:0', '--advertise', '127.0.0.1', ...secret]);
  assert.notEqual(wildcard.code, 0);
  assert.match(wildcard.stderr, /is a wildcard address/);
  const sameAsAdvertised = await runRelay(['--listen', '192.0.2.10:0', '--advertise', '192.0.2.10', ...secret]);
  assert.notEqual(sameAsAdvertised.code, 0);
  assert.match(sameAsAdvertised.stderr, /is also an advertised address/);
  assert.doesNotMatch(sameAsAdvertised.stderr, /cannot listen|Errno/, 'refused by the guard, not by a failed bind');
  const loopback = await relayFor(t, {});
  assert.match(loopback.output().stdout, /code-hub-relay listening on 127\.0\.0\.1:\d+/);
});

// Invariant: the running relay also refuses a non-loopback --listen equal to the default-route address, even with --advertise naming another address.
test('R9d: the relay refuses a --listen equal to the probed default-route address', async (t) => {
  if (!requirePython(t)) return;
  // The probe seam aims the route lookup at one of this host's own addresses,
  // whose source address is that address itself.
  const own = Object.values(os.networkInterfaces()).flat().find((ni) => ni?.family === 'IPv4' && !ni.internal)?.address;
  if (!own) { t.skip('this host has no non-loopback IPv4 address to probe'); return; }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codehub-relay-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const r = await runRelay(['--listen', `${own}:0`, '--advertise', '127.0.0.1', '--secret-file', path.join(dir, 'secret')],
    { env: { CODEHUB_RELAY_PROBE_DEST: `${own}:9` } });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /default-route \(LAN\) address/);
  assert.equal(r.stdout, '', 'it never listened');
});

// Invariant: a busy requested port is refused with port_in_use, and openForward falls back to a free port, saying so.
test('R10: a busy requested port is 409 port_in_use; openForward falls back with portFallback', async (t) => {
  if (!requirePython(t)) return;
  const relay = await relayFor(t, { leaseMs: 5000 });
  withRelayEnv(t, relay);
  const busy = net.createServer();
  await new Promise((r) => busy.listen(0, '127.0.0.1', r));
  t.after(() => busy.close());
  const port = busy.address().port;
  const res = await relayCall(relay, 'POST', P.forwards, { port });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, PROTOCOL.errorCodes.portInUse);
  const handle = handleFor(t, await hostRelay.openForward({ port }));
  assert.equal(handle.portFallback, true);
  assert.notEqual(handle.port, port);
  assert.equal(await canConnect(handle.port), true);
});

// Invariant: after a relay restart the handle goes down, then re-creates its forward on the same port and reports both changes.
test('R11: a relay restart takes the handle down and back up on the same forward port', async (t) => {
  if (!requirePython(t)) return;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codehub-relay-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const secretFile = path.join(dir, 'secret');
  const first = await startRelay({ leaseMs: 300, secretFile });
  t.after(() => first.stop());
  withRelayEnv(t, first);
  const changes = [];
  const handle = handleFor(t, await hostRelay.openForward({ onChange: () => changes.push(handle.state) }));
  const port = handle.port;
  await first.stop();
  await waitFor(() => handle.state === 'down', { timeout: 3000 });
  const second = await startRelay({ leaseMs: 300, secretFile, listenPort: first.port });
  t.after(() => second.stop());
  await waitFor(() => handle.state === 'up', { timeout: 3000 });
  assert.equal(handle.port, port);
  assert.deepEqual(changes, ['down', 'up']);
  assert.equal(await canConnect(port), true);
});

// Invariant: the secret is created on first run, reused afterwards, and never logged.
test('R12: the secret file is created, reused, and never printed', async (t) => {
  if (!requirePython(t)) return;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codehub-relay-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const secretFile = path.join(dir, 'nested', 'secret');
  const first = await startRelay({ secretFile });
  await relayCall(first, 'POST', P.forwards, {});
  await first.stop('SIGTERM');
  const second = await startRelay({ secretFile });
  await second.stop('SIGTERM');
  assert.equal(second.secret, first.secret);
  for (const r of [first, second]) {
    const { stdout, stderr } = r.output();
    assert.ok(!stdout.includes(first.secret) && !stderr.includes(first.secret), 'secret not in the output');
    assert.ok(stderr.includes(secretFile), 'the file path is logged instead');
  }
});

// Invariant: resources are bounded — parked accepts per forward and forwards per relay are capped with 429.
test('R13: the parked-accept cap and the forward cap answer 429', async (t) => {
  if (!requirePython(t)) return;
  const relay = await relayFor(t, { leaseMs: 10000 });
  const { body: fwd } = await relayCall(relay, 'POST', P.forwards, {});
  const results = [];
  for (let i = 0; i < 17; i++) parkAccept(relay, fwd.id).then((r) => results.push(r), () => {});
  await waitFor(() => results.length === 1);
  assert.deepEqual([results[0].upgraded, results[0].status], [false, 429]);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(results.length, 1, 'the other 16 stay parked');
  for (let i = 1; i < 64; i++) assert.equal((await relayCall(relay, 'POST', P.forwards, {})).status, 201);
  assert.equal((await relayCall(relay, 'POST', P.forwards, {})).status, 429);
});

// Every string literal's text in JS source — '…', "…" and template text
// outside ${} — with comments skipped.
function jsStringLiterals(src) {
  const out = [];
  let i = 0;
  const readQuoted = (q) => {
    let buf = '';
    for (i += 1; src[i] !== q; i += 1) buf += src[i] === '\\' ? src[++i] : src[i];
    i += 1;
    out.push(buf);
  };
  const readTemplate = () => {
    let buf = '';
    for (i += 1; src[i] !== '`'; i += 1) {
      if (src[i] === '\\') { buf += src[++i]; continue; }
      if (src[i] === '$' && src[i + 1] === '{') { out.push(buf); buf = ''; i += 2; code('}'); i -= 1; continue; }
      buf += src[i];
    }
    i += 1;
    out.push(buf);
  };
  // Scan code until the unmatched `close` (or the end).
  const code = (close) => {
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); i = nl < 0 ? src.length : nl; continue; }
      if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 2; continue; }
      if (c === '\'' || c === '"') { readQuoted(c); continue; }
      if (c === '`') { readTemplate(); continue; }
      if (c === '{') depth += 1;
      if (c === '}') { if (depth === 0 && close === '}') { i += 1; return; } depth -= 1; }
      i += 1;
    }
  };
  code(null);
  return out;
}

const restatements = (src) => jsStringLiterals(src).flatMap((lit) => PROTOCOL_IDS.filter((id) => lit.includes(id)).map((id) => ({ lit, id })));

// Invariant: protocol identifiers have a single source on the Node side — src/hostRelay.js reads them from protocol.json and never restates one.
test('R14: src/hostRelay.js restates no protocol identifier', () => {
  const planted = [
    "const a = '/v1/forwards/' + id; // '/v1/health' named in a comment",
    '/* "port_in_use" in a block comment */ const b = `${x}code-hub-relay/1`;',
    'const c = "no_lan_address"; const d = { port }; const e = `ok ${ "/v1/health" } done`;',
  ].join('\n');
  assert.deepEqual(restatements(planted).map((r) => r.id).sort(), ['/v1/forwards', '/v1/health', 'code-hub-relay/1', 'no_lan_address']);
  const src = readFileSync(path.join(REPO_ROOT, 'src', 'hostRelay.js'), 'utf8');
  assert.ok(jsStringLiterals(src).length > 10, 'the scanner sees the file\'s literals');
  assert.deepEqual(restatements(src), []);
});

// Invariant: a probe result the relay must not advertise refuses the start (wired through the probe seam, host-independent).
test('R15: a loopback route-probe answer refuses the start with "no LAN address to advertise (loopback)"', async (t) => {
  if (!requirePython(t)) return;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codehub-relay-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const r = await runRelay(['--listen', '127.0.0.1:0', '--secret-file', path.join(dir, 'secret')], { env: { CODEHUB_RELAY_PROBE_DEST: '127.0.0.1:9' } });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /no LAN address to advertise \(loopback\)/);
  assert.equal(r.stdout, '', 'it never listened');
});

// Invariant: an out-of-date deployed relay copy is detected — a protocol mismatch fails the relay on the share, never the share.
test('R16: a relay speaking another protocol version fails the share\'s relay with the mismatch text', async (t) => {
  if (!requirePython(t)) return;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codehub-relay-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.copyFile(path.join(REPO_ROOT, 'relay', 'relay.py'), path.join(dir, 'relay.py'));
  await fs.writeFile(path.join(dir, 'protocol.json'), JSON.stringify({ ...PROTOCOL, protocolVersion: 2 }));
  const relay = await relayFor(t, { relayDir: dir, leaseMs: 5000 });
  withRelayEnv(t, relay);
  await assert.rejects(hostRelay.openForward({}), /relay speaks protocol 2, this code-hub speaks 1 — update the relay\/ copy on the host/);

  process.env.CODEHUB_CLOUDFLARED_BIN = fakeCloudflaredBin;
  process.env.CODEHUB_TAILSCALE_BIN = fakeTailscaleBin;
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkProject(root, 'app', { start: fakeAppCmd() });
  await appManager.init();
  t.after(() => appManager.stop('app').catch(() => {}));
  await appManager.start('app');
  const shared = await appManager.share('app', { mode: 'lan', tls: false });
  assert.equal(shared.relay.state, 'failed');
  assert.match(shared.relay.error, /relay speaks protocol 2, this code-hub speaks 1/);
  await waitFor(async () => (await healthForwards(relay)) === 0, { timeout: 2000 });
});

// Invariant: SIGTERM is a clean shutdown — exit code 0 and every forward port closed.
test('R17: SIGTERM exits 0 and closes the forward ports', { skip: process.platform === 'win32' ? 'POSIX signals only' : false }, async (t) => {
  if (!requirePython(t)) return;
  const relay = await relayFor(t, { leaseMs: 5000 });
  const { body: fwd } = await relayCall(relay, 'POST', P.forwards, {});
  assert.equal(await canConnect(fwd.port), true);
  relay.proc.kill('SIGTERM');
  await relay.exited;
  assert.equal(relay.proc.exitCode, 0);
  assert.equal(await canConnect(fwd.port), false);
});
