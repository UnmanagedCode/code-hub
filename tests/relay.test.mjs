import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { promises as fs, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as hostRelay from '../src/hostRelay.js';
import * as relayStore from '../src/relayStore.js';
import { _setContainerProbe } from '../src/net.js';
import { generateSelfSigned } from '../src/selfsigned.js';
import {
  REPO_ROOT, RELAY_PROTOCOL as PROTOCOL, requirePython, startRelay, runRelay, patchedRelayDir, canConnect, waitFor,
  mkRoot, rmRoot, relayLogin, relaySecret, protoMac, frameStream, tcpConnect, ALT_LOOPBACK, altLoopbackBindable, listeningAddrs,
} from './helpers.mjs';

// The real Python relay (relay/relay.py) over loopback, driven by a raw
// protocol peer (tests/helpers.mjs, independent of src/) and through the
// code-hub modules. Every relay advertises 127.0.0.1 unless a test says
// otherwise, so the route probe never decides the addresses.

const { frames: F, roles: ROLES, scopes: SCOPES, errorCodes: E, macLabels: LABELS } = PROTOCOL;
const STAND_IN_HUB = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'relay-client.mjs');

// A projects root with code-hub's relay secret provisioned: { root, secret }.
async function hubRoot(t) {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await relayStore.ensureSecret();
  return { root, secret: await relaySecret(root) };
}

async function relayFor(t, opts) {
  const relay = await startRelay(opts);
  t.after(() => relay.stop());
  return relay;
}

// An authenticated raw control session.
async function control(t, relay, secret) {
  const s = await relayLogin(relay.port, secret);
  assert.equal(s.reply.t, F.welcome, JSON.stringify(s.reply));
  t.after(() => s.socket.destroy());
  return s;
}

// The next frame that isn't a ping (answered, like code-hub does) — nor an
// `incoming`, unless `incoming` is asked for (a reachability probe makes one).
async function nextFrame(s, { incoming = false, timeoutMs = 3000 } = {}) {
  for (;;) {
    const f = await s.frames.next(timeoutMs);
    if (f?.t === F.ping) { s.socket.write(`${JSON.stringify({ t: F.pong })}\n`); continue; }
    if (f?.t === F.incoming && !incoming) continue;
    return f;
  }
}

// Send a full ports set and return the status the relay answers with.
async function sendPorts(s, entries) {
  s.socket.write(`${JSON.stringify({ t: F.ports, ports: entries })}\n`);
  const f = await nextFrame(s);
  assert.equal(f?.t, F.status, JSON.stringify(f));
  return f;
}

const entryFor = (status, port, scope) => status.ports.find((e) => e.port === port && e.scope === scope);

function freePort(host = '127.0.0.1') {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, host, () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function blocker(t, host = '127.0.0.1') {
  const srv = net.createServer((s) => s.destroy());
  await new Promise((r) => srv.listen(0, host, r));
  t.after(() => srv.close());
  return srv.address().port;
}

// Everything a socket receives until it closes: { data, closedAt }.
function collect(socket) {
  return new Promise((resolve) => {
    let data = '';
    socket.on('data', (d) => { data += d; });
    socket.on('error', () => {});
    socket.on('close', () => resolve({ data, closedAt: Date.now() }));
  });
}

// Spawn the stand-in hub exposing an echo server in `scopes`: { proc, hostPorts }.
async function standInHub(t, root, scopes, env = {}) {
  const proc = spawn(process.execPath, [STAND_IN_HUB, ...scopes], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PROJECTS_ROOT: root, ...env } });
  t.after(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } });
  let out = '', err = '';
  proc.stderr.on('data', (d) => { err += d; });
  const hostPorts = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`stand-in hub never bound its ports: ${err}`)), 10000);
    proc.stdout.on('data', (d) => {
      out += d;
      const line = out.split('\n').find((l) => l.startsWith('{'));
      if (line) { clearTimeout(timer); resolve(JSON.parse(line).hostPorts); }
    });
    proc.once('exit', (code) => { clearTimeout(timer); reject(new Error(`stand-in hub exited (${code}): ${err}`)); });
  });
  return { proc, hostPorts };
}

// Invariant (S5): a connection that fails the MAC check gets auth_failed and
// is closed — nothing it sends after its auth is acted on.
test('V1: a wrong-secret auth gets auth_failed and its ports are never bound', async (t) => {
  if (!requirePython(t)) return;
  const { root } = await hubRoot(t);
  const relay = await relayFor(t, { projectsRoot: root });
  const port = await freePort();
  const s = await relayLogin(relay.port, 'w'.repeat(43));
  assert.deepEqual([s.reply.t, s.reply.code], [F.error, E.authFailed]);
  s.socket.write(`${JSON.stringify({ t: F.ports, ports: [{ port, scope: SCOPES.loopback }] })}\n`);
  await s.frames.closed;
  assert.equal(await canConnect(port), false);
});

// Invariant (S5): the relay proves the secret back (M_relay under the relay
// label and both nonces), and an auth replayed onto a fresh hello is refused.
test('V2: the relay\'s welcome MAC verifies, and a replayed auth is refused', async (t) => {
  if (!requirePython(t)) return;
  const { root, secret } = await hubRoot(t);
  const relay = await relayFor(t, { projectsRoot: root });
  const first = await control(t, relay, secret);
  const expected = protoMac(secret, LABELS.relay, ROLES.control, first.hello.nonce, first.auth.nonce);
  assert.equal(first.reply.mac, expected);
  assert.notEqual(first.reply.mac, protoMac(secret, LABELS.hub, ROLES.control, first.hello.nonce, first.auth.nonce), 'the relay label, not a reflection of the hub\'s MAC');
  const replay = await tcpConnect(relay.port);
  const frames = frameStream(replay);
  const hello = await frames.next();
  assert.notEqual(hello.nonce, first.hello.nonce);
  replay.write(`${JSON.stringify(first.auth)}\n`);
  const reply = await frames.next();
  assert.deepEqual([reply.t, reply.code], [F.error, E.authFailed]);
  await frames.closed;
});

// A TCP tap between a code-hub and the relay: every byte both ways.
async function tap(t, relayPort) {
  const seen = [];
  const srv = net.createServer((client) => {
    const upstream = net.connect(relayPort, '127.0.0.1');
    for (const [a, b] of [[client, upstream], [upstream, client]]) {
      a.on('data', (d) => { seen.push(Buffer.from(d)); b.write(d); });
      a.on('error', () => b.destroy());
      a.on('close', () => b.destroy());
    }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  return { port: srv.address().port, bytes: () => Buffer.concat(seen) };
}

// Invariant (S5): the secret never crosses the wire, in any common encoding,
// on the control session or the data path.
test('V3: no byte between code-hub and the relay carries the secret', async (t) => {
  if (!requirePython(t)) return;
  const { root: relayRoot, secret } = await hubRoot(t);
  const relay = await relayFor(t, { projectsRoot: relayRoot });
  // The stand-in hub's own root: the same secret, and a relay file naming the tap.
  const hubRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codehub-tapped-'));
  t.after(() => fs.rm(hubRootDir, { recursive: true, force: true }));
  const rdir = path.join(hubRootDir, '.code-hub', PROTOCOL.rendezvous.dir);
  await fs.mkdir(rdir, { recursive: true });
  await fs.copyFile(path.join(relayRoot, '.code-hub', PROTOCOL.rendezvous.dir, PROTOCOL.rendezvous.hubFile), path.join(rdir, PROTOCOL.rendezvous.hubFile));
  const wire = await tap(t, relay.port);
  await fs.writeFile(path.join(rdir, PROTOCOL.rendezvous.relayFile), JSON.stringify({ protocolVersion: PROTOCOL.protocolVersion, listen: `127.0.0.1:${wire.port}`, pid: 1 }));
  const { hostPorts } = await standInHub(t, hubRootDir, [SCOPES.loopback]);
  const client = await tcpConnect(hostPorts[SCOPES.loopback]);
  const got = collect(client);
  client.write('through the data path');
  await waitFor(() => wire.bytes().includes('through the data path'));
  client.end();
  assert.equal((await got).data, 'through the data path');
  const bytes = wire.bytes();
  assert.ok(bytes.includes(F.incoming), 'the tap saw the control session and the data path');
  const key = Buffer.from(secret, 'base64url');
  for (const form of [secret, Buffer.from(secret).toString('base64'), Buffer.from(secret).toString('hex'), key.toString('hex'), key.toString('base64')]) {
    assert.ok(!bytes.includes(form), `the secret crossed the wire as ${form.slice(0, 8)}…`);
  }
  assert.ok(!bytes.includes(key), 'the raw key bytes crossed the wire');
});

// Invariant (S5): pre-auth connections are capped at maxPendingHandshakes (one
// more is cut with no hello) and each gets handshakeTimeoutMs to authenticate.
test('V4: the unauthenticated cap and the handshake timeout hold', async (t) => {
  if (!requirePython(t)) return;
  const { root } = await hubRoot(t);
  const relayDir = await patchedRelayDir(t, { maxPendingHandshakes: 4, handshakeTimeoutMs: 800 });
  const relay = await relayFor(t, { projectsRoot: root, relayDir });
  const silent = [];
  for (let i = 0; i < 4; i++) {
    const s = await tcpConnect(relay.port);
    const frames = frameStream(s);
    assert.equal((await frames.next()).t, F.hello);
    silent.push({ s, frames, at: Date.now() });
  }
  const extra = await tcpConnect(relay.port);
  const { data } = await collect(extra);
  assert.equal(data, '', 'cut with no hello');
  for (const { frames, at } of silent) {
    await frames.closed;
    const lived = Date.now() - at;
    assert.ok(lived >= 600 && lived < 2500, `a silent connection lived ${lived}ms`);
  }
});

// Invariant (S5): a data connection claims exactly one pending client of the
// CURRENT session, once; a client nobody claims is dropped after --accept-wait-ms.
test('V5: data claims need the current session and a pending conn, once; unclaimed clients are dropped', async (t) => {
  if (!requirePython(t)) return;
  const { root, secret } = await hubRoot(t);
  const relay = await relayFor(t, { projectsRoot: root, acceptWaitMs: 400 });
  const s = await control(t, relay, secret);
  const port = await freePort();
  const status = await sendPorts(s, [{ port, scope: SCOPES.loopback }]);
  const hostPort = entryFor(status, port, SCOPES.loopback).hostPort;

  const client = await tcpConnect(hostPort);
  const fromClient = collect(client);
  client.write('early');
  const inc = await nextFrame(s, { incoming: true });
  assert.deepEqual({ ...inc, conn: undefined }, { t: F.incoming, port, scope: SCOPES.loopback, conn: undefined });
  const data = { role: ROLES.data };
  const stale = await relayLogin(relay.port, secret, { ...data, session: 'x'.repeat(16), conn: inc.conn });
  assert.deepEqual([stale.reply.t, stale.reply.code], [F.error, E.staleSession]);
  const unknown = await relayLogin(relay.port, secret, { ...data, session: s.reply.session, conn: 'y'.repeat(16) });
  assert.deepEqual([unknown.reply.t, unknown.reply.code], [F.error, E.unknownConn]);
  const claim = await relayLogin(relay.port, secret, { ...data, session: s.reply.session, conn: inc.conn });
  assert.equal(claim.reply.t, F.welcome);
  assert.equal(claim.reply.mac, protoMac(secret, LABELS.relay, ROLES.data, claim.hello.nonce, claim.auth.nonce, s.reply.session, inc.conn));
  await waitFor(() => claim.frames.rest().toString() === 'early');
  claim.socket.write('back');
  claim.socket.end();
  assert.equal((await fromClient).data, 'back');
  const again = await relayLogin(relay.port, secret, { ...data, session: s.reply.session, conn: inc.conn });
  assert.deepEqual([again.reply.t, again.reply.code], [F.error, E.unknownConn]);

  const idle = await tcpConnect(hostPort);
  const opened = Date.now();
  const idleDone = collect(idle);
  assert.equal((await nextFrame(s, { incoming: true })).t, F.incoming);
  const { data: idleData, closedAt } = await idleDone;
  assert.equal(idleData, '');
  assert.ok(closedAt - opened >= 300 && closedAt - opened < 2500, `dropped after ${closedAt - opened}ms`);
});

// Invariant (S5): a ports frame is validated strictly — a host or target key,
// an unknown scope, an out-of-range port or a duplicate pair is bad_frame, and
// the whole session (its listeners included) closes.
test('V6: a malformed ports frame gets bad_frame and closes the session and its listeners', async (t) => {
  if (!requirePython(t)) return;
  const { root, secret } = await hubRoot(t);
  const relay = await relayFor(t, { projectsRoot: root });
  const good = { port: await freePort(), scope: SCOPES.loopback };
  const bad = [
    [{ ...good, host: '10.0.0.1' }],
    [{ ...good, target: '10.0.0.1:22' }],
    [{ port: good.port, scope: 'everywhere' }],
    [{ port: 80, scope: SCOPES.loopback }],
    [good, good],
  ];
  for (const entries of bad) {
    const s = await control(t, relay, secret);
    const hostPort = entryFor(await sendPorts(s, [good]), good.port, good.scope).hostPort;
    assert.equal(await canConnect(hostPort), true);
    s.socket.write(`${JSON.stringify({ t: F.ports, ports: entries })}\n`);
    const f = await nextFrame(s);
    assert.deepEqual([f?.t, f?.code], [F.error, E.badFrame], JSON.stringify(entries));
    await s.frames.closed;
    await waitFor(async () => !(await canConnect(hostPort)), { timeout: 2000 });
  }
});

// Invariant (S3): a free requested port is bound as is; a busy one falls back
// to a working free port, flagged — in both scopes, with the scope echoed.
test('V7: same port when free, a flagged fallback when busy, in both scopes', async (t) => {
  if (!requirePython(t)) return;
  const { root, secret } = await hubRoot(t);
  const relay = await relayFor(t, { projectsRoot: root });
  const s = await control(t, relay, secret);
  const [freeLan, freeLoop, busyLan, busyLoop] = [await freePort(), await freePort(), await blocker(t), await blocker(t)];
  const entries = [
    { port: freeLan, scope: SCOPES.lan }, { port: freeLoop, scope: SCOPES.loopback },
    { port: busyLan, scope: SCOPES.lan }, { port: busyLoop, scope: SCOPES.loopback },
  ];
  const status = await sendPorts(s, entries);
  assert.deepEqual(status.addresses, ['127.0.0.1']);
  for (const { port, scope } of entries.slice(0, 2)) {
    assert.deepEqual(entryFor(status, port, scope), { port, scope, hostPort: port, fallback: false });
    assert.equal(await canConnect(port), true);
  }
  for (const { port, scope } of entries.slice(2)) {
    const e = entryFor(status, port, scope);
    assert.equal(e.fallback, true, scope);
    assert.notEqual(e.hostPort, port, scope);
    assert.equal(await canConnect(e.hostPort), true, scope);
  }
});

// Invariant (S3): the ports set is live — a pair dropped from it closes, a pair
// kept in it stays on the same host port.
test('V8: ports [A,B] then [B] closes A and keeps B where it was', async (t) => {
  if (!requirePython(t)) return;
  const { root, secret } = await hubRoot(t);
  const relay = await relayFor(t, { projectsRoot: root });
  const s = await control(t, relay, secret);
  const [a, b] = [await freePort(), await freePort()];
  const first = await sendPorts(s, [{ port: a, scope: SCOPES.loopback }, { port: b, scope: SCOPES.lan }]);
  const hostB = entryFor(first, b, SCOPES.lan).hostPort;
  assert.equal(await canConnect(a), true);
  const second = await sendPorts(s, [{ port: b, scope: SCOPES.lan }]);
  assert.equal(entryFor(second, a, SCOPES.loopback), undefined);
  assert.equal(entryFor(second, b, SCOPES.lan).hostPort, hostB);
  assert.equal(await canConnect(a), false);
  assert.equal(await canConnect(hostB), true);
});

// Invariant (S4/S10): exposure is session-scoped — a code-hub killed outright
// takes every host listener of both scopes with it, promptly.
test('V9: SIGKILL of the code-hub side closes all its host listeners promptly', async (t) => {
  if (!requirePython(t)) return;
  const { root } = await hubRoot(t);
  const relay = await relayFor(t, { projectsRoot: root });
  const { proc, hostPorts } = await standInHub(t, root, [SCOPES.lan, SCOPES.loopback]);
  for (const p of Object.values(hostPorts)) assert.equal(await canConnect(p), true);
  proc.kill('SIGKILL');
  for (const p of Object.values(hostPorts)) await waitFor(async () => !(await canConnect(p)), { timeout: 1500 });
  assert.match(relay.output().stderr, /control session \S+ closed/);
});

// Invariant (S4/S10): a code-hub that stops answering (frozen, not dead) loses
// its listeners within keepaliveTimeoutMs.
test('V10: SIGSTOP of the code-hub side closes its listeners within the keepalive timeout', { skip: process.platform === 'win32' ? 'POSIX signals only' : false }, async (t) => {
  if (!requirePython(t)) return;
  const { root } = await hubRoot(t);
  const relayDir = await patchedRelayDir(t, { pingIntervalMs: 150, keepaliveTimeoutMs: 700 });
  await relayFor(t, { projectsRoot: root, relayDir });
  const { proc, hostPorts } = await standInHub(t, root, [SCOPES.lan, SCOPES.loopback], { RELAY_CLIENT_TIMINGS: JSON.stringify({ pingIntervalMs: 150, keepaliveTimeoutMs: 700 }) });
  await new Promise((r) => setTimeout(r, 900)); // pings keep it alive past one timeout
  for (const p of Object.values(hostPorts)) assert.equal(await canConnect(p), true);
  proc.kill('SIGSTOP');
  t.after(() => { try { proc.kill('SIGCONT'); } catch { /* gone */ } });
  const stopped = Date.now();
  for (const p of Object.values(hostPorts)) await waitFor(async () => !(await canConnect(p)), { timeout: 3000, interval: 50 });
  assert.ok(Date.now() - stopped >= 500, 'not before the timeout');
});

// Invariant (S4): one session at a time — a newly authenticated control
// session replaces the old one, whose socket and listeners close.
test('V11: a second control session replaces the first', async (t) => {
  if (!requirePython(t)) return;
  const { root, secret } = await hubRoot(t);
  const relay = await relayFor(t, { projectsRoot: root });
  const first = await control(t, relay, secret);
  const port = await freePort();
  const hostPort = entryFor(await sendPorts(first, [{ port, scope: SCOPES.loopback }]), port, SCOPES.loopback).hostPort;
  const second = await control(t, relay, secret);
  assert.notEqual(second.reply.session, first.reply.session);
  await first.frames.closed;
  assert.equal(await canConnect(hostPort), false);
  assert.equal(entryFor(await sendPorts(second, [{ port, scope: SCOPES.loopback }]), port, SCOPES.loopback).hostPort, port, 'the port is free for the new session');
});

// Code-hub's own relay client in this process, against relay files under `root`.
function hubInProcess(t) {
  _setContainerProbe(() => true);
  hostRelay._setLoopbackDialHost('127.0.0.1');
  relayStore._setHostPollMs(50);
  t.after(() => { hostRelay.stop(); _setContainerProbe(null); hostRelay._setLoopbackDialHost(null); });
}

// Invariant (S5): bytes pass through untouched — TLS ends at the origin (its
// certificate is the one the client sees) and early client bytes come first.
test('V12: through the code-hub modules the TLS peer is the origin and early bytes arrive first', async (t) => {
  if (!requirePython(t)) return;
  const { root } = await hubRoot(t);
  await relayFor(t, { projectsRoot: root });
  hubInProcess(t);
  const { key, cert } = generateSelfSigned({ ipAddresses: ['127.0.0.1'], dnsNames: ['localhost'] });
  const origin = https.createServer({ key, cert }, (req, res) => res.end(`hello ${req.url}`));
  await new Promise((r) => origin.listen(0, '127.0.0.1', r));
  t.after(() => origin.close());
  const echo = net.createServer((s) => { s.on('error', () => {}); s.pipe(s); });
  await new Promise((r) => echo.listen(0, '127.0.0.1', r));
  t.after(() => echo.close());
  const tlsHandle = hostRelay.expose(origin.address().port, SCOPES.lan, { host: '127.0.0.1', port: origin.address().port });
  const echoHandle = hostRelay.expose(echo.address().port, SCOPES.loopback, { host: '127.0.0.1', port: echo.address().port });
  t.after(() => { tlsHandle.close(); echoHandle.close(); });
  await hostRelay.init();
  await waitFor(() => tlsHandle.hostPort() && echoHandle.hostPort());

  const { body, fingerprint } = await new Promise((resolve, reject) => {
    const req = https.get({ host: '127.0.0.1', port: tlsHandle.hostPort(), path: '/x', rejectUnauthorized: false, agent: false }, (res) => {
      const fp = res.socket.getPeerCertificate().fingerprint256;
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => resolve({ body: b, fingerprint: fp }));
    });
    req.on('error', reject);
  });
  assert.equal(body, 'hello /x');
  assert.equal(fingerprint, new crypto.X509Certificate(cert).fingerprint256);

  const client = net.connect(echoHandle.hostPort(), '127.0.0.1');
  client.write('early;'); // before the connection is even established
  const got = collect(client);
  await new Promise((r) => setTimeout(r, 100));
  client.end('later');
  assert.equal((await got).data, 'early;later');
});

// Invariant (S5): the control listener is never LAN-reachable — a wildcard, an
// advertised non-loopback or the default-route address is refused before any bind.
test('V13: the relay refuses a wildcard, an advertised or a default-route --listen before binding', async (t) => {
  if (!requirePython(t)) return;
  const { root } = await hubRoot(t);
  const common = ['--projects-root', root];
  const wildcard = await runRelay(['--listen', '0.0.0.0:0', '--advertise', '127.0.0.1', ...common]);
  assert.notEqual(wildcard.code, 0);
  assert.match(wildcard.stderr, /is a wildcard address/);
  const sameAsAdvertised = await runRelay(['--listen', '192.0.2.10:0', '--advertise', '192.0.2.10', ...common]);
  assert.notEqual(sameAsAdvertised.code, 0);
  assert.match(sameAsAdvertised.stderr, /is also an advertised address/);
  assert.doesNotMatch(sameAsAdvertised.stderr, /cannot listen|Errno/, 'refused by the guard, not by a failed bind');
  // The probe seam aims the route lookup at one of this host's own addresses,
  // whose source address is that address itself.
  const own = Object.values(os.networkInterfaces()).flat().find((ni) => ni?.family === 'IPv4' && !ni.internal)?.address;
  if (own) {
    const route = await runRelay(['--listen', `${own}:0`, '--advertise', '127.0.0.1', ...common], { env: { CODEHUB_RELAY_PROBE_DEST: `${own}:9` } });
    assert.notEqual(route.code, 0);
    assert.match(route.stderr, /default-route \(LAN\) address/);
    assert.equal(route.stdout, '', 'it never listened');
  }
  const loopback = await relayFor(t, { projectsRoot: root });
  assert.match(loopback.output().stdout, /code-hub-relay listening on 127\.0\.0\.1:\d+/);
});

const hostFileIn = (root) => path.join(root, '.code-hub', PROTOCOL.rendezvous.dir, PROTOCOL.rendezvous.relayFile);
const exists = (p) => fs.access(p).then(() => true, () => false);

// Invariant (S7): with no flags the relay finds code-hub's store by walking up
// from its own script — never from the working directory; --projects-root
// overrides it; finding none fails naming where it looked and the flag.
test('V14: discovery walks up from the script, --projects-root overrides, and none found fails clearly', async (t) => {
  if (!requirePython(t)) return;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codehub-discover-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const plugin = path.join(tmp, 'root', '.plugins', 'code-hub', 'relay');
  await fs.mkdir(plugin, { recursive: true });
  for (const f of ['relay.py', 'protocol.json']) await fs.copyFile(path.join(REPO_ROOT, 'relay', f), path.join(plugin, f));
  await fs.mkdir(path.join(tmp, 'root', '.code-hub'));
  const decoy = path.join(tmp, 'decoy');
  await fs.mkdir(path.join(decoy, '.code-hub'), { recursive: true });

  const found = await startRelay({ relayDir: plugin, cwd: decoy });
  t.after(() => found.stop());
  await waitFor(() => exists(hostFileIn(path.join(tmp, 'root'))));
  assert.equal(await exists(hostFileIn(decoy)), false, 'never the working directory\'s store');
  await found.stop('SIGTERM');

  const other = path.join(tmp, 'other');
  await fs.mkdir(path.join(other, '.code-hub'), { recursive: true });
  const overridden = await startRelay({ relayDir: plugin, cwd: decoy, projectsRoot: other });
  t.after(() => overridden.stop());
  await waitFor(() => exists(hostFileIn(other)));
  await overridden.stop('SIGTERM');

  const lonely = path.join(tmp, 'lonely', 'relay');
  await fs.mkdir(lonely, { recursive: true });
  for (const f of ['relay.py', 'protocol.json']) await fs.copyFile(path.join(REPO_ROOT, 'relay', f), path.join(lonely, f));
  const none = await runRelay(['--listen', '127.0.0.1:0', '--advertise', '127.0.0.1'], { relayDir: lonely, cwd: decoy });
  assert.notEqual(none.code, 0);
  assert.ok(none.stderr.includes(path.join(tmp, 'lonely')), none.stderr);
  assert.ok(none.stderr.includes(tmp), 'names the searched dirs');
  assert.match(none.stderr, /--projects-root/);
});

// Invariant (S2/S7): the relay file names where the relay really listens and
// which process wrote it, is written atomically, is removed on a clean exit,
// and is left alone once another relay has taken it over.
test('V15: host.json carries the real port and pid, goes on SIGTERM, and stays when overwritten', { skip: process.platform === 'win32' ? 'POSIX signals only' : false }, async (t) => {
  if (!requirePython(t)) return;
  const { root } = await hubRoot(t);
  const relay = await relayFor(t, { projectsRoot: root });
  const host = JSON.parse(await fs.readFile(hostFileIn(root), 'utf8'));
  assert.deepEqual(host, { protocolVersion: PROTOCOL.protocolVersion, listen: `127.0.0.1:${relay.port}`, pid: relay.proc.pid });
  assert.deepEqual((await fs.readdir(path.dirname(hostFileIn(root)))).filter((n) => n.endsWith('.tmp')), []);
  relay.proc.kill('SIGTERM');
  await relay.exited;
  assert.equal(relay.proc.exitCode, 0);
  assert.equal(await exists(hostFileIn(root)), false);
  assert.equal(await canConnect(relay.port), false);

  const second = await relayFor(t, { projectsRoot: root });
  const taken = JSON.stringify({ protocolVersion: PROTOCOL.protocolVersion, listen: '127.0.0.1:1', pid: second.proc.pid + 100000 });
  await fs.writeFile(hostFileIn(root), taken);
  second.proc.kill('SIGTERM');
  await second.exited;
  assert.equal(await fs.readFile(hostFileIn(root), 'utf8'), taken);
});

// Invariant (S5): the secret is read on every handshake — a relay started
// before code-hub ever wrote it waits instead of failing, and a regenerated
// secret applies to the very next connection.
test('V16: a relay started before the secret exists waits for it, and picks up a regenerated one', async (t) => {
  if (!requirePython(t)) return;
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await fs.mkdir(path.join(root, '.code-hub'));
  const relay = await relayFor(t, { projectsRoot: root });
  await waitFor(() => /waiting for code-hub to create .*relay\.json/.test(relay.output().stderr));
  const early = await relayLogin(relay.port, 'z'.repeat(43));
  assert.deepEqual([early.reply.t, early.reply.code], [F.error, E.noSecret]);
  await relayStore.ensureSecret();
  const secret = await relaySecret(root);
  const s = await relayLogin(relay.port, secret);
  assert.equal(s.reply.t, F.welcome);
  s.socket.destroy();
  const hubFile = path.join(root, '.code-hub', PROTOCOL.rendezvous.dir, PROTOCOL.rendezvous.hubFile);
  await fs.writeFile(hubFile, 'not json');
  await relayStore.ensureSecret(); // replaces the invalid file with a fresh secret
  const fresh = await relaySecret(root);
  assert.notEqual(fresh, secret);
  const old = await relayLogin(relay.port, secret);
  assert.deepEqual([old.reply.t, old.reply.code], [F.error, E.authFailed]);
  const now = await relayLogin(relay.port, fresh);
  assert.equal(now.reply.t, F.welcome);
  now.socket.destroy();
});

// Every string literal's text in JS source — '…', "…" and template text
// outside ${} — with comments skipped, and with the code just before it.
function jsStringLiterals(src) {
  const out = [];
  let i = 0;
  const readQuoted = (q) => {
    const before = src.slice(Math.max(0, i - 24), i);
    let buf = '';
    for (i += 1; src[i] !== q; i += 1) buf += src[i] === '\\' ? src[++i] : src[i];
    i += 1;
    out.push({ text: buf, before });
  };
  const readTemplate = () => {
    let buf = '';
    for (i += 1; src[i] !== '`'; i += 1) {
      if (src[i] === '\\') { buf += src[++i]; continue; }
      if (src[i] === '$' && src[i + 1] === '{') { out.push({ text: buf, before: '' }); buf = ''; i += 2; code('}'); i -= 1; continue; }
      buf += src[i];
    }
    i += 1;
    out.push({ text: buf, before: '' });
  };
  // Scan code until the unmatched `close` (or the end).
  const code = (close) => {
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); i = nl < 0 ? src.length : nl; continue; }
      if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 2; continue; }
      if (c === '/' && /[=(,:!&|?{};]\s*$/.test(src.slice(Math.max(0, i - 8), i))) {
        // A regex literal: skip it (character classes may hold quotes).
        let inClass = false;
        for (i += 1; i < src.length && (inClass || src[i] !== '/'); i += 1) {
          if (src[i] === '\\') { i += 1; continue; }
          if (src[i] === '[') inClass = true;
          if (src[i] === ']') inClass = false;
        }
        i += 1;
        continue;
      }
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

// Every identifier protocol.json defines for both sides to read.
const PROTOCOL_IDS = [
  ...Object.values(PROTOCOL.frames), ...Object.values(PROTOCOL.roles), ...Object.values(PROTOCOL.scopes),
  ...Object.values(PROTOCOL.macLabels), ...Object.values(PROTOCOL.errorCodes), ...Object.values(PROTOCOL.rendezvous),
];
// A literal restates an identifier by equalling it; one that isn't a plain
// word (an error code, a label, a file name) also by containing it. An event
// name passed to .on/.once/.off/.emit is Node's vocabulary, not the protocol's.
const EVENT_ARG = /\.(on|once|off|emit|removeListener|prependListener)\(\s*$/;
const restatements = (src) => jsStringLiterals(src)
  .filter((lit) => !EVENT_ARG.test(lit.before))
  .flatMap((lit) => PROTOCOL_IDS
    .filter((id) => lit.text === id || (/[^a-z]/.test(id) && lit.text.includes(id)))
    .map((id) => ({ lit: lit.text, id })));

// Invariant (S5): protocol identifiers have a single source on the code-hub
// side — the relay modules read them from protocol.json and restate none.
test('V17: the code-hub relay modules restate no protocol identifier', () => {
  const planted = [
    "const a = { t: 'hello' }; // 'auth' named in a comment",
    '/* "bad_frame" in a block comment */ const b = `x ${y} relay.json`;',
    "socket.on('data', f); const c = `role ${'control'}`; const d = 'code-hub-relay/2 hub' + x; const e = /'ping'/;",
    "const g = 'no_lan_address: busy'; const h = 'lan';",
  ].join('\n');
  assert.deepEqual(restatements(planted).map((r) => r.id).sort(), ['code-hub-relay/2 hub', 'control', 'hello', 'lan', 'no_lan_address', 'relay.json']);
  for (const file of ['hostRelay.js', 'relaySession.js', 'relayStore.js', 'loopbackMirror.js']) {
    const src = readFileSync(path.join(REPO_ROOT, 'src', file), 'utf8');
    assert.ok(jsStringLiterals(src).length > 0, `the scanner sees ${file}'s literals`);
    assert.deepEqual(restatements(src), [], file);
  }
});

// Invariant (S10): scope confinement on the real relay — a loopback pair is
// bound on 127.0.0.1 only, a LAN pair on the advertised address only. Asserted
// on what the relay process itself listens on (/proc), so another process on
// the same port of the other address can't make the check pass or fail.
test('V18: loopback scope binds 127.0.0.1 only, lan scope the advertised address only', async (t) => {
  if (!requirePython(t)) return;
  if (process.platform !== 'linux' || !(await altLoopbackBindable())) { t.skip(`${ALT_LOOPBACK} is not a bindable loopback alias on this host (Linux configures all of 127/8)`); return; }
  const { root, secret } = await hubRoot(t);
  const relay = await relayFor(t, { projectsRoot: root, advertise: ALT_LOOPBACK });
  const s = await control(t, relay, secret);
  const [p1, p2] = [await freePort(ALT_LOOPBACK), await freePort()];
  const status = await sendPorts(s, [{ port: p1, scope: SCOPES.lan }, { port: p2, scope: SCOPES.loopback }]);
  assert.deepEqual(status.addresses, [ALT_LOOPBACK]);
  const h1 = entryFor(status, p1, SCOPES.lan).hostPort;
  const h2 = entryFor(status, p2, SCOPES.loopback).hostPort;
  const bound = await listeningAddrs(relay.proc.pid);
  assert.ok(bound.has(`127.0.0.1:${h2}`) && !bound.has(`${ALT_LOOPBACK}:${h2}`), [...bound].join(' '));
  assert.ok(bound.has(`${ALT_LOOPBACK}:${h1}`) && !bound.has(`127.0.0.1:${h1}`), [...bound].join(' '));
  assert.equal([...bound].filter((a) => a.endsWith(`:${h1}`) || a.endsWith(`:${h2}`)).length, 2, 'nothing else, no wildcard');
  assert.equal(await canConnect(h2, '127.0.0.1'), true);
  assert.equal(await canConnect(h1, ALT_LOOPBACK), true);
});

// Invariant (S5): pending host clients are capped per port and per session;
// one over either cap is cut at once, while those within it stay claimable.
test('V19: the incoming caps cut excess clients at once and keep the rest claimable', async (t) => {
  if (!requirePython(t)) return;
  const { root, secret } = await hubRoot(t);
  const relayDir = await patchedRelayDir(t, { maxIncomingPerPort: 2, maxIncomingTotal: 3 });
  const relay = await relayFor(t, { projectsRoot: root, relayDir, acceptWaitMs: 5000 });
  const s = await control(t, relay, secret);
  const [a, b] = [await freePort(), await freePort()];
  const status = await sendPorts(s, [{ port: a, scope: SCOPES.loopback }, { port: b, scope: SCOPES.loopback }]);
  const [ha, hb] = [entryFor(status, a, SCOPES.loopback).hostPort, entryFor(status, b, SCOPES.loopback).hostPort];
  const conns = [];
  const pending = async (hostPort) => {
    const c = await tcpConnect(hostPort);
    t.after(() => c.destroy());
    const f = await nextFrame(s, { incoming: true });
    assert.equal(f.t, F.incoming);
    conns.push({ client: c, conn: f.conn });
  };
  const cut = async (hostPort) => {
    const opened = Date.now();
    const { closedAt } = await collect(await tcpConnect(hostPort));
    assert.ok(closedAt - opened < 1500, `cut after ${closedAt - opened}ms, not at the accept wait`);
  };
  await pending(ha);
  await pending(ha);
  await cut(ha); // the per-port cap
  await pending(hb);
  await cut(hb); // the session cap
  const first = conns[0];
  const got = collect(first.client);
  const claim = await relayLogin(relay.port, secret, { role: ROLES.data, session: s.reply.session, conn: first.conn });
  assert.equal(claim.reply.t, F.welcome);
  claim.socket.end('claimed');
  assert.equal((await got).data, 'claimed');
});

// Invariant (S4): the relay's silence timer restarts on every frame — a peer
// that keeps answering stays connected across several keepalive windows, and
// one that stops is dropped within one.
test('V20: a responsive hub keeps its session across keepalive windows; silence ends it', async (t) => {
  if (!requirePython(t)) return;
  const { root, secret } = await hubRoot(t);
  const relayDir = await patchedRelayDir(t, { pingIntervalMs: 100, keepaliveTimeoutMs: 400 });
  const relay = await relayFor(t, { projectsRoot: root, relayDir });
  const s = await control(t, relay, secret);
  const port = await freePort();
  const hostPort = entryFor(await sendPorts(s, [{ port, scope: SCOPES.loopback }]), port, SCOPES.loopback).hostPort;
  const end = Date.now() + 1600; // four windows
  while (Date.now() < end) {
    const f = await s.frames.next(500);
    assert.notEqual(f, null, 'the relay closed a session that kept answering');
    if (f.t === F.ping) s.socket.write(`${JSON.stringify({ t: F.pong })}\n`);
  }
  assert.equal(await canConnect(hostPort), true);
  const quietSince = Date.now();
  await s.frames.closed;
  const quiet = Date.now() - quietSince;
  assert.ok(quiet < 1500, `dropped ${quiet}ms after going quiet`);
});

// Invariant (S5): a handshake that ends — refused for a wrong MAC or a bad
// frame, or timed out — gives its pre-auth slot back, so a full cap's worth of
// failures never locks code-hub out.
test('V21: refused and timed-out handshakes release their pre-auth slots', async (t) => {
  if (!requirePython(t)) return;
  const { root, secret } = await hubRoot(t);
  const relayDir = await patchedRelayDir(t, { maxPendingHandshakes: 2, handshakeTimeoutMs: 400 });
  const relay = await relayFor(t, { projectsRoot: root, relayDir });
  const welcomed = async () => {
    const s = await relayLogin(relay.port, secret);
    s.socket.destroy();
    return s.reply.t;
  };
  for (let i = 0; i < 3; i++) {
    const bad = await relayLogin(relay.port, 'w'.repeat(43));
    assert.equal(bad.reply.code, E.authFailed);
    await bad.frames.closed;
  }
  assert.equal(await welcomed(), F.welcome, 'after cap-many refused MACs');
  for (let i = 0; i < 3; i++) {
    const bad = await relayLogin(relay.port, secret, { authOver: { mac: 5 } });
    assert.equal(bad.reply.code, E.badFrame);
    await bad.frames.closed;
  }
  assert.equal(await welcomed(), F.welcome, 'after cap-many bad frames');
  const silent = [];
  for (let i = 0; i < 2; i++) {
    const c = await tcpConnect(relay.port);
    const frames = frameStream(c);
    assert.equal((await frames.next()).t, F.hello);
    silent.push(frames.closed);
  }
  await Promise.all(silent);
  assert.equal(await welcomed(), F.welcome, 'after cap-many timeouts');
});

const nonceLen = Math.ceil((PROTOCOL.nonceBytes * 8) / 6);

// Invariant (S5): the relay validates the peer's nonce — wrong length or a
// character outside base64url is bad_frame even with a MAC correctly computed
// over that very nonce.
test('V22: a malformed hub nonce is bad_frame, whatever the MAC', async (t) => {
  if (!requirePython(t)) return;
  const { root, secret } = await hubRoot(t);
  const relay = await relayFor(t, { projectsRoot: root });
  for (const bad of ['a'.repeat(nonceLen - 1), 'a'.repeat(nonceLen + 1), `${'a'.repeat(nonceLen - 1)}+`, `${'a'.repeat(nonceLen - 1)}=`]) {
    const s = await relayLogin(relay.port, secret, { authOver: (hello) => ({ nonce: bad, mac: protoMac(secret, LABELS.hub, ROLES.control, hello.nonce, bad) }) });
    assert.deepEqual([s.reply.t, s.reply.code], [F.error, E.badFrame], bad);
  }
  const good = await relayLogin(relay.port, secret);
  assert.equal(good.reply.t, F.welcome, 'the same path with a good nonce');
  good.socket.destroy();
});

// Invariant (S5): the auth frame's shape is exact — an extra key, a missing
// key or a mistyped value is bad_frame, MAC notwithstanding.
test('V23: an auth with an extra, missing or mistyped key is bad_frame', async (t) => {
  if (!requirePython(t)) return;
  const { root, secret } = await hubRoot(t);
  const relay = await relayFor(t, { projectsRoot: root });
  const variants = [
    { authOver: { extra: 1 } },
    { authOver: { mac: undefined } }, // JSON.stringify drops it: missing
    { authOver: { nonce: 5 } },
    { authOver: { role: 'admin' } },
    { authOver: { session: 'x'.repeat(16) } }, // control role with data keys
    { role: ROLES.data, session: 'x'.repeat(16), conn: 'y'.repeat(16), authOver: { conn: undefined } },
    { role: ROLES.data, session: 'x'.repeat(16), conn: 'y'.repeat(16), authOver: { conn: 7 } },
  ];
  for (const v of variants) {
    const s = await relayLogin(relay.port, secret, v);
    assert.deepEqual([s.reply.t, s.reply.code], [F.error, E.badFrame], JSON.stringify(v));
  }
});

// Invariant (S5): a version mismatch is reported as one — distinct from an
// authentication failure — even with a valid MAC.
test('V24: an auth of another protocol version gets version_mismatch, not auth_failed', async (t) => {
  if (!requirePython(t)) return;
  const { root, secret } = await hubRoot(t);
  const relay = await relayFor(t, { projectsRoot: root });
  const s = await relayLogin(relay.port, secret, { authOver: { v: PROTOCOL.protocolVersion + 1 } });
  assert.deepEqual([s.reply.t, s.reply.code], [F.error, E.versionMismatch]);
  assert.match(s.reply.message, /update the relay\/ copy on the host/);
  const wrongSecret = await relayLogin(relay.port, 'w'.repeat(43));
  assert.equal(wrongSecret.reply.code, E.authFailed, 'the contrast: same version, wrong MAC');
});

// Invariant: startup failures say what really failed — a rendezvous dir or
// store the relay can't write names the path and says to run it as the owner
// (never "cannot listen"); a busy --listen is "cannot listen".
test('V25: store permission failures and a busy --listen each give their own message', { skip: process.platform === 'win32' || process.getuid?.() === 0 ? 'needs POSIX permissions enforced (not root)' : false }, async (t) => {
  if (!requirePython(t)) return;
  const { root } = await hubRoot(t);
  const rdir = path.join(root, '.code-hub', PROTOCOL.rendezvous.dir);
  await fs.chmod(rdir, 0o500);
  t.after(() => fs.chmod(rdir, 0o700).catch(() => {}));
  const unwritable = await runRelay(['--listen', '127.0.0.1:0', '--advertise', '127.0.0.1', '--projects-root', root]);
  assert.notEqual(unwritable.code, 0);
  assert.match(unwritable.stderr, new RegExp(`cannot write \\S*${PROTOCOL.rendezvous.relayFile}: Permission denied — run the relay as the user that owns`));
  assert.doesNotMatch(unwritable.stderr, /cannot listen/);
  await fs.chmod(rdir, 0o700);

  const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'codehub-bare-'));
  t.after(async () => { await fs.chmod(path.join(bare, '.code-hub'), 0o700).catch(() => {}); await fs.rm(bare, { recursive: true, force: true }); });
  await fs.mkdir(path.join(bare, '.code-hub'), { mode: 0o500 });
  const noDir = await runRelay(['--listen', '127.0.0.1:0', '--advertise', '127.0.0.1', '--projects-root', bare]);
  assert.notEqual(noDir.code, 0);
  assert.match(noDir.stderr, /cannot create \S+: Permission denied — run the relay as the user that owns/);

  const busy = net.createServer();
  await new Promise((r) => busy.listen(0, '127.0.0.1', r));
  t.after(() => busy.close());
  const taken = await runRelay(['--listen', `127.0.0.1:${busy.address().port}`, '--advertise', '127.0.0.1', '--projects-root', root]);
  assert.notEqual(taken.code, 0);
  assert.match(taken.stderr, new RegExp(`cannot listen on 127\\.0\\.0\\.1:${busy.address().port}: Address already in use`));
});

// Invariant: a repeated --advertise address is bound once — LAN pairs bind
// and the advertised list carries it once.
test('V26: a duplicated --advertise address still binds lan pairs, listed once', async (t) => {
  if (!requirePython(t)) return;
  const { root, secret } = await hubRoot(t);
  const relay = await relayFor(t, { projectsRoot: root, advertise: '127.0.0.1,127.0.0.1' });
  const s = await control(t, relay, secret);
  const port = await freePort();
  const status = await sendPorts(s, [{ port, scope: SCOPES.lan }]);
  assert.deepEqual(status.addresses, ['127.0.0.1']);
  assert.deepEqual(entryFor(status, port, SCOPES.lan), { port, scope: SCOPES.lan, hostPort: port, fallback: false });
});

// Equality comparisons in JS source: { left, op, right } per `a OP b`.
const equalities = (src) => [...src.matchAll(/([\w.$[\]'"`]+)\s*(===|!==|==|!=)\s*([\w.$[\]'"`]+)/g)].map((m) => ({ left: m[1], op: m[2], right: m[3] }));
const fnBody = (src, name) => {
  const start = src.indexOf(`function ${name}(`);
  return start < 0 ? null : src.slice(start, src.indexOf('\n}', start) + 2);
};
// A comparison touching a MAC value: an operand naming one.
const onMac = (e) => [e.left, e.right].some((x) => /mac|proof/i.test(x));
// What verifyMac may compare with an equality: lengths and a typeof check.
const allowedInVerify = (e) => [e.left, e.right].every((x) => /\.length$|^typeof$|^given$|^'string'$/.test(x)) && !(/^given$/.test(e.left) && /^given$/.test(e.right));

// Invariant (S5): MACs are compared only in constant time — verifyMac goes
// through crypto.timingSafeEqual and compares nothing else but lengths, and no
// code-hub relay module compares a MAC value with an equality operator.
test('V27: code-hub compares MACs only through timingSafeEqual', () => {
  const planted = 'export function verifyMac(expected, given) {\n  const g = given;\n  return g === expected;\n}\nconst ok = reply.mac !== mine;';
  assert.equal(fnBody(planted, 'verifyMac').includes('timingSafeEqual('), false);
  assert.ok(equalities(fnBody(planted, 'verifyMac')).some((e) => !allowedInVerify(e)), 'the scanner flags a plain compare in verifyMac');
  assert.ok(equalities(planted).some(onMac), 'the scanner flags a MAC compared outside it');
  const session = readFileSync(path.join(REPO_ROOT, 'src', 'relaySession.js'), 'utf8');
  const verify = fnBody(session, 'verifyMac');
  assert.ok(verify && verify.includes('crypto.timingSafeEqual('), 'verifyMac uses timingSafeEqual');
  assert.deepEqual(equalities(verify).filter((e) => !allowedInVerify(e)), []);
  for (const file of ['relaySession.js', 'hostRelay.js']) {
    assert.deepEqual(equalities(readFileSync(path.join(REPO_ROOT, 'src', file), 'utf8')).filter(onMac), [], file);
  }
});
