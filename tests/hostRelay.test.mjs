import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import * as hostRelay from '../src/hostRelay.js';
import * as relayStore from '../src/relayStore.js';
import { _setTimings } from '../src/relaySession.js';
import { _setContainerProbe, parseDefaultGateway } from '../src/net.js';
import { RELAY_PROTOCOL as P, mkRoot, rmRoot, waitFor, relaySecret } from './helpers.mjs';
import { startFakeRelay } from './fixtures/fake-relay.mjs';

// src/hostRelay.js (with relayStore.js and relaySession.js) against FAKE relays
// (tests/fixtures/fake-relay.mjs, no Python): relays that misbehave in ways
// the real one never does, and that count what code-hub does to them.

const { scopes: SCOPES } = P;

// A projects root with the secret provisioned, the hub in a "container", and
// cleanup of everything module-level this file touches.
async function setup(t, { timings } = {}) {
  const root = await mkRoot();
  await relayStore.ensureSecret();
  _setContainerProbe(() => true);
  hostRelay._setLoopbackDialHost('127.0.0.1');
  relayStore._setHostPollMs(50);
  if (timings) _setTimings(timings);
  t.after(async () => {
    hostRelay.stop();
    _setContainerProbe(null);
    hostRelay._setLoopbackDialHost(null);
    _setTimings(null);
    await rmRoot(root);
  });
  return root;
}

async function fakeFor(t, root, opts) {
  const fake = await startFakeRelay({ root, ...opts });
  t.after(() => fake.close());
  return fake;
}

// expose() for the rest of the test: the handle, and every info() it was notified with.
function exposeFor(t, port, scope, target = { host: '127.0.0.1', port }) {
  const seen = [];
  const handle = hostRelay.expose(port, scope, target, () => seen.push(handle.info()));
  t.after(() => handle.close());
  return { handle, seen };
}

async function echoServer(t) {
  const srv = net.createServer((s) => { s.on('error', () => {}); s.pipe(s); });
  srv.connections = 0;
  srv.on('connection', () => { srv.connections += 1; });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  return srv;
}

const pairs = (ports) => ports.map((e) => `${e.port}/${e.scope}`).sort();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Invariant (S5): a relay that can't prove the secret is never trusted — the
// session never comes up and no ports frame is sent; and on the data path no
// byte reaches the target behind an unproven data welcome.
test('H1: an impostor relay is refused on the control and the data path', async (t) => {
  const root = await setup(t);
  const fake = await fakeFor(t, root, { impostor: true });
  exposeFor(t, 40001, SCOPES.loopback);
  await hostRelay.init();
  await waitFor(() => /could not prove the secret/.test(hostRelay.status().error ?? ''));
  assert.equal(hostRelay.status().state === 'up', false);
  await waitFor(() => fake.controls.length >= 2, { timeout: 3000 }); // it retried, still refused
  assert.deepEqual(fake.controls.flatMap((c) => c.ports), []);
  hostRelay.stop();
  await fake.close();

  const data = await fakeFor(t, root, { impostorData: true });
  const target = await echoServer(t);
  exposeFor(t, target.address().port, SCOPES.lan);
  await hostRelay.init();
  await waitFor(() => hostRelay.status().state === 'up');
  data.send({ t: P.frames.incoming, port: target.address().port, scope: SCOPES.lan, conn: 'c'.repeat(16) });
  await waitFor(() => data.dataWelcomed === 1);
  await sleep(200);
  assert.equal(target.connections, 0);
});

// Invariant (S5): code-hub validates the relay's frames strictly, keys and
// values — a status or incoming frame with an extra key, an out-of-range port,
// an unknown scope, an unknown error code, an out-of-range host port or a
// malformed conn ends the session.
test('H2: a malformed status or incoming frame closes the session', async (t) => {
  const root = await setup(t);
  const fake = await fakeFor(t, root, { autoStatus: false });
  exposeFor(t, 40002, SCOPES.loopback);
  await hostRelay.init();
  const malformed = [
    { t: P.frames.status, addresses: ['127.0.0.1'], ports: [], extra: 1 },
    { t: P.frames.status, addresses: ['127.0.0.1'], ports: [{ port: 40002, scope: SCOPES.loopback, hostPort: 40002, fallback: false, host: '10.0.0.1' }] },
    { t: P.frames.status, addresses: ['127.0.0.1'], ports: [{ port: 80, scope: SCOPES.loopback, hostPort: 40002, fallback: false }] },
    { t: P.frames.status, addresses: ['127.0.0.1'], ports: [{ port: 40002, scope: 'everywhere', hostPort: 40002, fallback: false }] },
    { t: P.frames.status, addresses: ['127.0.0.1'], ports: [{ port: 40002, scope: SCOPES.loopback, code: 'no_such_code', message: 'x' }] },
    { t: P.frames.status, addresses: ['127.0.0.1'], ports: [{ port: 40002, scope: SCOPES.loopback, hostPort: 70000, fallback: false }] },
    { t: P.frames.status, addresses: ['127.0.0.1'], ports: [{ port: 40002, scope: SCOPES.loopback, hostPort: 0, fallback: false }] },
    { t: P.frames.status, addresses: ['not an ip'], ports: [] },
    { t: P.frames.incoming, port: 40002, scope: 'everywhere', conn: 'c'.repeat(16) },
    { t: P.frames.incoming, port: 40002, scope: SCOPES.loopback, conn: 'c'.repeat(16), target: '10.0.0.1:22' },
    { t: P.frames.incoming, port: 80, scope: SCOPES.loopback, conn: 'c'.repeat(16) },
    { t: P.frames.incoming, port: 40002, scope: SCOPES.loopback, conn: 'not a conn!' },
    { t: P.frames.incoming, port: 40002, scope: SCOPES.loopback, conn: 'c'.repeat(65) },
  ];
  for (const [i, frame] of malformed.entries()) {
    await waitFor(() => fake.controls.length === i + 1 && hostRelay.status().state === 'up', { timeout: 8000 });
    const c = fake.control();
    fake.send(frame);
    await waitFor(() => c.closed);
    assert.match(hostRelay.status().error, /bad frame from the relay|malformed|invalid/, JSON.stringify(frame));
  }
  // A well-formed status, by contrast, keeps the session.
  await waitFor(() => fake.controls.length === malformed.length + 1 && hostRelay.status().state === 'up', { timeout: 8000 });
  fake.send({ t: P.frames.status, addresses: ['127.0.0.1'], ports: [{ port: 40002, scope: SCOPES.loopback, code: P.errorCodes.bindFailed, message: 'x' }] });
  await sleep(200);
  assert.equal(fake.control().closed, false);
  assert.equal(hostRelay.status().state, 'up');
});

// Invariant (S4): a relay that goes silent takes the session down within
// keepaliveTimeoutMs, and every handle hears it.
test('H3: a silent relay drives code-hub down within the keepalive timeout', async (t) => {
  const root = await setup(t, { timings: { pingIntervalMs: 100, keepaliveTimeoutMs: 400 } });
  const fake = await fakeFor(t, root, { silent: true });
  const { handle, seen } = exposeFor(t, 40003, SCOPES.loopback);
  await hostRelay.init();
  await waitFor(() => handle.info()?.state === 'up');
  const upAt = Date.now();
  await waitFor(() => hostRelay.status().state !== 'up', { timeout: 2000, interval: 10 });
  const took = Date.now() - upAt;
  assert.ok(took >= 300 && took < 1200, `down after ${took}ms`);
  assert.match(hostRelay.status().error, /connection to the relay lost: no frame from the relay for over 400ms/);
  assert.equal(seen.at(-1)?.state, 'down');
  const first = fake.controls[0];
  await waitFor(() => first.closed);
});

// Invariant (S2): failed attempts back off with growing gaps, and a change of
// the relay file resets the backoff and triggers an attempt at once.
test('H4: backoff gaps grow, and a relay-file change cuts the wait short', async (t) => {
  const root = await setup(t);
  const times = [];
  const refuser = net.createServer((s) => { times.push(Date.now()); s.destroy(); });
  await new Promise((r) => refuser.listen(0, '127.0.0.1', r));
  t.after(() => refuser.close());
  const hostFile = path.join(root, '.code-hub', P.rendezvous.dir, P.rendezvous.relayFile);
  const publish = (pid) => fs.writeFile(hostFile, JSON.stringify({ protocolVersion: P.protocolVersion, listen: `127.0.0.1:${refuser.address().port}`, pid }));
  await publish(1);
  const { handle } = exposeFor(t, 40004, SCOPES.lan);
  await hostRelay.init();
  await waitFor(() => times.length >= 4, { timeout: 8000 });
  const gaps = times.slice(1).map((x, i) => x - times[i]);
  assert.ok(gaps[0] < gaps[1] && gaps[1] < gaps[2], `gaps ${gaps}`);
  assert.equal(hostRelay.status().state, 'retrying');
  assert.equal(handle.info().recovery, 'retrying');
  // The next attempt is now a gap of several seconds away; a file change skips it.
  const changedAt = Date.now();
  await publish(2);
  await waitFor(() => times.length >= 5, { timeout: 1500 });
  assert.ok(times[4] - changedAt < 1000, `attempted ${times[4] - changedAt}ms after the change`);
});

// Invariant (S2): a relay file of another protocol version is reported and not
// dialled at all until the file changes — a `waiting` state, which handles
// report as recovery 'relay-file' (no retry is coming), unlike 'retrying'.
test('H5: an incompatible relay file gives the version error and no dial until it changes', async (t) => {
  const root = await setup(t);
  const fake = await fakeFor(t, root);
  await fake.publish({ protocolVersion: 1 });
  const { handle } = exposeFor(t, 40005, SCOPES.lan);
  await hostRelay.init();
  await waitFor(() => /speaks protocol 1, this code-hub speaks 2 — update the relay\/ copy on the host/.test(hostRelay.status().error ?? ''));
  assert.equal(hostRelay.status().state, 'waiting');
  assert.deepEqual({ state: handle.info().state, recovery: handle.info().recovery }, { state: 'down', recovery: 'relay-file' });
  await sleep(700);
  assert.equal(fake.accepted.length, 0);
  await fake.publish();
  await waitFor(() => hostRelay.status().state === 'up');
});

// Invariant (S3/S10): the ports frame is always the full set of both scopes —
// on connect, after every expose and close, and first thing after a reconnect.
test('H6: ports frames carry the full set, both scopes, on connect, on change and after a reconnect', async (t) => {
  const root = await setup(t);
  const fake = await fakeFor(t, root);
  exposeFor(t, 40011, SCOPES.loopback);
  const b = exposeFor(t, 40012, SCOPES.lan);
  await hostRelay.init();
  await waitFor(() => fake.control()?.ports.length === 1);
  assert.deepEqual(pairs(fake.control().ports[0]), ['40011/loopback', '40012/lan']);
  exposeFor(t, 40013, SCOPES.loopback);
  await waitFor(() => fake.control().ports.length === 2);
  assert.deepEqual(pairs(fake.control().ports[1]), ['40011/loopback', '40012/lan', '40013/loopback']);
  b.handle.close();
  await waitFor(() => fake.control().ports.length === 3);
  assert.deepEqual(pairs(fake.control().ports[2]), ['40011/loopback', '40013/loopback']);
  const first = fake.control();
  first.socket.destroy();
  await waitFor(() => fake.controls.length === 2 && fake.control().ports.length >= 1, { timeout: 4000 });
  assert.deepEqual(pairs(fake.control().ports[0]), ['40011/loopback', '40013/loopback']);
});

// Invariant (S5): the secret file is created private (dir 0700 — a wider
// existing dir is narrowed — file 0600), left byte-identical while valid, and
// replaced when invalid or too short.
test('H7: relay.json is created 0700/0600, kept when valid, replaced when invalid or short', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const dir = path.join(root, '.code-hub', P.rendezvous.dir);
  const file = path.join(dir, P.rendezvous.hubFile);
  await fs.mkdir(dir, { recursive: true, mode: 0o755 });
  await fs.chmod(dir, 0o755);
  const secret = await relayStore.ensureSecret();
  assert.ok(secret.length >= P.minSecretLength);
  const raw = await fs.readFile(file, 'utf8');
  assert.deepEqual(JSON.parse(raw), { protocolVersion: P.protocolVersion, secret });
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  }
  assert.equal(await relayStore.ensureSecret(), secret);
  assert.equal(await fs.readFile(file, 'utf8'), raw, 'left byte-identical');
  for (const bad of ['not json', '[]', JSON.stringify({ secret: 'short' }), JSON.stringify({ secret: 5 })]) {
    await fs.writeFile(file, bad);
    const fresh = await relayStore.ensureSecret();
    assert.ok(fresh.length >= P.minSecretLength, bad);
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).secret, fresh, bad);
  }
});

const posixOnly = process.platform === 'win32' ? 'FIFOs, symlinks and modes are POSIX' : false;

// Invariant (S5): a rendezvous file is read only when it is a regular file
// within maxRendezvousBytes — a FIFO never blocks a read, a huge file is never
// loaded — and the hub's tmp file is created exclusively, so a symlink planted
// at its path is removed, never written through.
test('H12: rendezvous reads refuse FIFOs and oversize files; the tmp write never follows a planted symlink', { skip: posixOnly }, async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const { execFileSync } = await import('node:child_process');
  const dir = path.join(root, '.code-hub', P.rendezvous.dir);
  const hubFile = path.join(dir, P.rendezvous.hubFile);
  const hostFile = path.join(dir, P.rendezvous.relayFile);
  await relayStore.ensureSecret();

  await fs.rm(hubFile);
  execFileSync('mkfifo', [hubFile]);
  const fromFifo = await relayStore.ensureSecret(); // a blocking read would hang here
  assert.ok((await fs.stat(hubFile)).isFile(), 'the FIFO was replaced by a fresh secret file');
  assert.equal(JSON.parse(await fs.readFile(hubFile, 'utf8')).secret, fromFifo);
  await fs.writeFile(hubFile, JSON.stringify({ secret: 'x'.repeat(P.maxRendezvousBytes) }));
  const fromHuge = await relayStore.ensureSecret();
  assert.notEqual(fromHuge, 'x'.repeat(P.maxRendezvousBytes), 'an oversize file is not used');

  execFileSync('mkfifo', [hostFile]);
  assert.match((await relayStore.readHost()).error, /is not a regular file/);
  await fs.rm(hostFile);
  await fs.writeFile(hostFile, JSON.stringify({ protocolVersion: P.protocolVersion, listen: '127.0.0.1:7077', pid: 1, pad: 'x'.repeat(P.maxRendezvousBytes) }));
  assert.match((await relayStore.readHost()).error, new RegExp(`is larger than ${P.maxRendezvousBytes} bytes`));

  const victim = path.join(root, 'victim');
  await fs.writeFile(victim, 'untouched');
  await fs.symlink(victim, path.join(dir, `.${P.rendezvous.hubFile}.${process.pid}.tmp`));
  await fs.writeFile(hubFile, 'invalid');
  const fresh = await relayStore.ensureSecret();
  assert.equal(await fs.readFile(victim, 'utf8'), 'untouched');
  assert.equal(JSON.parse(await fs.readFile(hubFile, 'utf8')).secret, fresh);
  assert.ok(!(await fs.lstat(hubFile)).isSymbolicLink());

  // The create itself is exclusive: a symlink planted right after the removal
  // (the race the removal alone can't close) makes the write refuse.
  const tmp = path.join(dir, `.${P.rendezvous.hubFile}.${process.pid}.tmp`);
  const realRm = fs.rm;
  t.mock.method(fs, 'rm', async (p, ...rest) => {
    await realRm.call(fs, p, ...rest);
    if (p === tmp) await fs.symlink(victim, tmp);
  });
  await fs.writeFile(hubFile, 'invalid');
  await assert.rejects(relayStore.ensureSecret(), /cannot provision the host-relay secret .*EEXIST/);
  assert.equal(await fs.readFile(victim, 'utf8'), 'untouched');
});

// Invariant (S2): a relay that accepts the connection but never says hello
// costs at most handshakeTimeoutMs per attempt — code-hub reports the timeout
// and keeps retrying with backoff.
test('H13: a relay that never sends hello times out the handshake, and code-hub keeps retrying', async (t) => {
  const root = await setup(t, { timings: { handshakeTimeoutMs: 200 } });
  const fake = await fakeFor(t, root, { mute: true });
  await hostRelay.init();
  await waitFor(() => /did not complete the handshake within 200ms/.test(hostRelay.status().error ?? ''), { timeout: 2000 });
  assert.equal(hostRelay.status().state, 'retrying');
  await waitFor(() => fake.accepted.length >= 3, { timeout: 4000 });
  const gaps = fake.accepted.slice(1).map((x, i) => x - fake.accepted[i]);
  assert.ok(gaps.every((g) => g >= 200 + 400), `each attempt waited out the timeout and a backoff (${gaps})`);
});

// Invariant (S5): code-hub checks the relay's handshake frames strictly — a
// hello of another version is a version mismatch (not an auth failure); a
// malformed nonce (length or alphabet), an extra, missing or mistyped key in
// the hello or the welcome, or a malformed session id is a bad frame; in the
// hello cases code-hub sends no auth at all.
test('H14: hello and welcome are validated strictly: version, nonce, shape, session id', async (t) => {
  const root = await setup(t);
  const nonce = (n) => n.repeat(Math.ceil((P.nonceBytes * 8) / 6));
  const cases = [
    [{ helloOver: (f) => ({ ...f, v: P.protocolVersion + 1 }) }, new RegExp(`speaks protocol ${P.protocolVersion + 1}, this code-hub speaks ${P.protocolVersion}`), false],
    [{ helloOver: (f) => ({ ...f, nonce: f.nonce.slice(1) }) }, /malformed nonce/, false],
    [{ helloOver: (f) => ({ ...f, nonce: `${nonce('a').slice(1)}+` }) }, /malformed nonce/, false],
    [{ helloOver: (f) => ({ ...f, extra: 1 }) }, /hello must have exactly the keys/, false],
    [{ helloOver: ({ nonce: _n, ...f }) => f }, /hello must have exactly the keys/, false],
    [{ helloOver: (f) => ({ ...f, nonce: 5 }) }, /hello: nonce is malformed/, false],
    [{ welcomeOver: (f) => ({ ...f, extra: 1 }) }, /welcome must have exactly the keys/, true],
    [{ welcomeOver: ({ addresses: _a, ...f }) => f }, /welcome must have exactly the keys/, true],
    [{ welcomeOver: (f) => ({ ...f, addresses: '127.0.0.1' }) }, /welcome: addresses is malformed/, true],
    [{ welcomeOver: (f) => ({ ...f, session: 'not a session!' }) }, /malformed session id/, true],
  ];
  for (const [opts, error, authSent] of cases) {
    const fake = await fakeFor(t, root, opts); // closed by t.after even when an assertion fails
    await hostRelay.init();
    await waitFor(() => error.test(hostRelay.status().error ?? ''), { timeout: 3000 });
    assert.notEqual(hostRelay.status().state, 'up');
    assert.equal(fake.auths.length > 0, authSent, String(error));
    hostRelay.stop();
    await fake.close();
  }
});

// Invariant (S4): the silence timer restarts on every frame — a relay that
// answers keeps the session up across many keepalive windows, on one connection.
test('H15: a responsive relay keeps the session up across several keepalive windows', async (t) => {
  const root = await setup(t, { timings: { pingIntervalMs: 100, keepaliveTimeoutMs: 300 } });
  const fake = await fakeFor(t, root);
  await hostRelay.init();
  await waitFor(() => hostRelay.status().state === 'up');
  await sleep(1500); // five windows
  assert.equal(hostRelay.status().state, 'up');
  assert.equal(fake.controls.length, 1, 'never reconnected');
  assert.equal(fake.control().closed, false);
});

// Invariant (S2): the relay file's content poll alone finds a relay — with
// filesystem events suppressed entirely (Docker Desktop bind mounts).
test('H16: the relay-file poll finds a relay with fs.watch suppressed', async (t) => {
  const root = await setup(t);
  let watched = 0;
  relayStore._setWatch(() => { watched += 1; return { on() {}, unref() {}, close() {} }; });
  t.after(() => relayStore._setWatch(null));
  const changes = [];
  const stop = relayStore.watchHost(() => changes.push(Date.now()));
  t.after(stop);
  assert.equal(watched, 1, 'the watcher was replaced, not merely unused');
  const fake = await fakeFor(t, root);
  await waitFor(() => changes.length >= 1, { timeout: 1000 });
  await fs.rm(fake.hostFile);
  await waitFor(() => changes.length >= 2, { timeout: 1000 });
});

// Invariant (S10): a mirrored app whose port changed is re-mirrored — its old
// pair is withdrawn and the new one exposed.
test('H17: loopbackMirror.sync moves an app\'s mirror to its new port', async (t) => {
  const root = await setup(t);
  const { sync, reset, hostPort } = await import('../src/loopbackMirror.js');
  t.after(reset);
  const fake = await fakeFor(t, root);
  await hostRelay.init();
  await waitFor(() => hostRelay.status().state === 'up');
  sync([{ id: 'a', port: 40101 }]);
  await waitFor(() => hostPort('a') !== null);
  sync([{ id: 'a', port: 40102 }]);
  await waitFor(() => pairs(fake.control().ports.at(-1)).join() === `40102/${SCOPES.loopback}`);
  await waitFor(() => hostPort('a') !== null);
  const settled = fake.control().ports.length;
  sync([{ id: 'a', port: 40102 }]);
  await sleep(100);
  assert.equal(fake.control().ports.length, settled, 'an unchanged set sends nothing');
});

// Invariant (S5): a session that is up but has no answer about a pair yet
// reports it 'binding' — no retry is pending, the relay's status is.
test('H18: a pair awaiting the relay\'s status reports recovery binding', async (t) => {
  const root = await setup(t);
  const fake = await fakeFor(t, root, { autoStatus: false });
  const { handle } = exposeFor(t, 40041, SCOPES.loopback);
  await hostRelay.init();
  await waitFor(() => hostRelay.status().state === 'up' && fake.control()?.ports.length === 1);
  assert.deepEqual({ state: handle.info().state, recovery: handle.info().recovery }, { state: 'down', recovery: 'binding' });
  fake.send({ t: P.frames.status, addresses: ['127.0.0.1'], ports: [{ port: 40041, scope: SCOPES.loopback, hostPort: 40041, fallback: false }] });
  await waitFor(() => handle.info().state === 'up');
  assert.equal(handle.info().recovery, null);
});

// Invariant (S2): a relay file that couldn't be READ (an fs error, which may
// pass) is retried with backoff — unlike unusable content, which waits for a
// change. Here exactly one read fails and the file never changes, so neither
// fs events (suppressed) nor the content poll could ever trigger the attempt
// that connects: only the retry can.
test('H19: a one-off relay-file read error is retried; it does not wait for a change', async (t) => {
  const root = await setup(t);
  relayStore._setWatch(() => ({ on() {}, unref() {}, close() {} }));
  t.after(() => relayStore._setWatch(null));
  const fake = await fakeFor(t, root);
  const realOpen = fs.open;
  let failed = false;
  t.mock.method(fs, 'open', async (p, ...rest) => {
    if (!failed && p === fake.hostFile) {
      failed = true;
      throw Object.assign(new Error(`EIO: i/o error, open '${p}'`), { code: 'EIO' });
    }
    return realOpen.call(fs, p, ...rest);
  });
  const { handle } = exposeFor(t, 40042, SCOPES.loopback);
  await hostRelay.init();
  await waitFor(() => /cannot read .*EIO/.test(hostRelay.status().error ?? ''));
  assert.equal(hostRelay.status().state, 'retrying');
  assert.equal(handle.info().recovery, 'retrying');
  await waitFor(() => hostRelay.status().state === 'up', { timeout: 4000 });
  assert.equal(fake.controls.length, 1);
});

// Invariant (S2): rendezvous reads gather the whole file however the reads
// are chunked — readHost parses it, and the watcher's baseline matches the
// poll's reading, so no change is reported for an unchanged file.
test('H20: rendezvous reads survive short reads', async (t) => {
  const root = await setup(t);
  const { createRequire, syncBuiltinESMExports } = await import('node:module');
  const fsCjs = createRequire(import.meta.url)('node:fs');
  const fake = await fakeFor(t, root);
  const realOpen = fs.open;
  t.mock.method(fs, 'open', async (...a) => {
    const h = await realOpen.apply(fs, a);
    return { stat: () => h.stat(), close: () => h.close(), read: (buf, off, len, pos) => h.read(buf, off, Math.min(len, 7), pos) };
  });
  const realReadSync = fsCjs.readSync;
  fsCjs.readSync = (fd, buf, off, len, pos) => realReadSync(fd, buf, off, Math.min(len, 7), pos);
  syncBuiltinESMExports();
  t.after(() => { fsCjs.readSync = realReadSync; syncBuiltinESMExports(); });
  const host = await relayStore.readHost();
  assert.equal(host.listenPort, fake.port);
  const changes = [];
  const stop = relayStore.watchHost(() => changes.push(1));
  t.after(stop);
  await sleep(300); // several polls
  assert.deepEqual(changes, []);
  assert.equal(await relayStore.ensureSecret(), await relaySecret(root), 'the hub file read whole too, so kept');
});

// Invariant (S2/S5): rendezvous reads stay bounded even when the file is far
// larger than its fstat size said (it grew after the check): neither the async
// read nor the watcher's sync read ever asks for or gathers more than
// maxRendezvousBytes + 1 bytes, and the file is refused as oversize.
test('H20b: a file that grew past its stat size is read no further than the bound', async (t) => {
  const root = await setup(t);
  const { createRequire, syncBuiltinESMExports } = await import('node:module');
  const fsCjs = createRequire(import.meta.url)('node:fs');
  const hostFile = path.join(root, '.code-hub', P.rendezvous.dir, P.rendezvous.relayFile);
  await fs.writeFile(hostFile, 'x'.repeat(P.maxRendezvousBytes * 64));
  const limit = P.maxRendezvousBytes + 1;
  const lying = (info) => Object.assign(Object.create(Object.getPrototypeOf(info)), info, { size: 10 });

  const asked = []; // [position, length] of every async read
  let gathered = 0;
  const realOpen = fs.open;
  t.mock.method(fs, 'open', async (...a) => {
    const h = await realOpen.apply(fs, a);
    return {
      stat: async () => lying(await h.stat()),
      close: () => h.close(),
      read: async (buf, off, len, pos) => {
        asked.push([pos, len]);
        const r = await h.read(buf, off, Math.min(len, 7), pos);
        gathered += r.bytesRead;
        return r;
      },
    };
  });
  assert.match((await relayStore.readHost()).error, new RegExp(`is larger than ${P.maxRendezvousBytes} bytes`));
  assert.ok(asked.length > 1, 'chunked: the read loop ran');
  assert.ok(asked.every(([pos, len]) => pos + len <= limit), JSON.stringify(asked.at(-1)));
  assert.ok(gathered <= limit, `gathered ${gathered}`);

  const askedSync = [];
  let gatheredSync = 0;
  const realFstat = fsCjs.fstatSync;
  const realReadSync = fsCjs.readSync;
  fsCjs.fstatSync = (...a) => lying(realFstat(...a));
  fsCjs.readSync = (fd, buf, off, len, pos) => {
    askedSync.push([pos, len]);
    const n = realReadSync(fd, buf, off, Math.min(len, 7), pos);
    gatheredSync += n;
    return n;
  };
  syncBuiltinESMExports();
  t.after(() => { fsCjs.fstatSync = realFstat; fsCjs.readSync = realReadSync; syncBuiltinESMExports(); });
  const stop = relayStore.watchHost(() => {}); // its baseline is a sync read
  stop();
  assert.ok(askedSync.length > 1, 'chunked: the sync read loop ran');
  assert.ok(askedSync.every(([pos, len]) => pos + len <= limit), JSON.stringify(askedSync.at(-1)));
  assert.ok(gatheredSync <= limit, `gathered ${gatheredSync}`);
});

// Invariant (S2): a relay file whose CONTENT can't be used — a FIFO, an
// oversize file — waits for a change (state waiting, recovery relay-file):
// it is not mistaken for a passing read error and retried with backoff, and
// no dial is made even though the oversize file names a live relay.
test('H22: an unusable relay file waits for a change; it is not retried', { skip: posixOnly }, async (t) => {
  const { execFileSync } = await import('node:child_process');
  const root = await setup(t);
  const fake = await fakeFor(t, root);
  const valid = await fs.readFile(fake.hostFile, 'utf8');
  const oversize = JSON.stringify({ ...JSON.parse(valid), pad: 'x'.repeat(P.maxRendezvousBytes) });
  for (const [what, plant] of [
    ['FIFO', async () => { await fs.rm(fake.hostFile); execFileSync('mkfifo', [fake.hostFile]); }],
    ['oversize', () => fs.writeFile(fake.hostFile, oversize)],
  ]) {
    await plant();
    const { handle } = exposeFor(t, 40043, SCOPES.loopback);
    await hostRelay.init();
    await waitFor(() => hostRelay.status().state === 'waiting', { timeout: 2000 });
    assert.equal(handle.info().recovery, 'relay-file', what);
    await sleep(1200); // past the first backoff steps: still waiting, never dialled
    assert.equal(hostRelay.status().state, 'waiting', what);
    assert.equal(fake.controls.length, 0, what);
    hostRelay.stop();
    handle.close();
    await fs.rm(fake.hostFile, { force: true });
  }
});

// Invariant (S5): relay.json is 0600 whatever the umask — under a restrictive
// umask (0477) the created file is still owner-readable and -writable, so the
// next boot keeps the same secret instead of failing to read it.
test('H21: ensureSecret writes relay.json 0600 under a restrictive umask', { skip: posixOnly }, async (t) => {
  const root = await setup(t);
  const hubFile = path.join(root, '.code-hub', P.rendezvous.dir, P.rendezvous.hubFile);
  await fs.rm(hubFile);
  const old = process.umask(0o477);
  t.after(() => process.umask(old));
  const secret = await relayStore.ensureSecret();
  assert.equal((await fs.stat(hubFile)).mode & 0o777, 0o600);
  assert.equal(await relayStore.ensureSecret(), secret, 'readable again: kept, not replaced');
});

// Invariant (S6): a loopback listen is dialled through the Docker Desktop host
// name; any other address as written, then the default gateway, deduplicated.
test('H8: dialCandidates', () => {
  assert.deepEqual(hostRelay.dialCandidates('127.0.0.1', '172.17.0.1', 'host.docker.internal'), ['host.docker.internal']);
  assert.deepEqual(hostRelay.dialCandidates('127.0.0.5', null, 'h'), ['h']);
  assert.deepEqual(hostRelay.dialCandidates('172.17.0.1', '172.18.0.1', 'h'), ['172.17.0.1', '172.18.0.1']);
  assert.deepEqual(hostRelay.dialCandidates('172.17.0.1', '172.17.0.1', 'h'), ['172.17.0.1']);
  assert.deepEqual(hostRelay.dialCandidates('192.168.1.5', null, 'h'), ['192.168.1.5']);
});

// Invariant (S6): the default gateway is the first default route's gateway in
// /proc/net/route, read little-endian; no default route gives null.
test('H9: parseDefaultGateway', () => {
  const head = 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n';
  assert.equal(parseDefaultGateway(`${head}eth0\t00000000\t010011AC\t0003\t0\t0\t0\t00000000\t0\t0\t0\neth0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0\n`), '172.17.0.1');
  assert.equal(parseDefaultGateway(`${head}eth0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0\n`), null);
  assert.equal(parseDefaultGateway(`${head}eth0\t00000000\t0101A8C0\t0001\t0\t0\t0\t00000000\t0\t0\t0\n`), null, 'no RTF_GATEWAY flag');
  assert.equal(parseDefaultGateway(`${head}wlan0\t00000000\t0102A8C0\t0003\t0\t0\t600\t00000000\t0\t0\t0\n`), '192.168.2.1');
  assert.equal(parseDefaultGateway(''), null);
});

// Invariant (S10): an incoming for a pair code-hub no longer exposes opens no
// data connection, while one for an exposed pair does.
test('H10: an incoming for an unexposed pair is ignored', async (t) => {
  const root = await setup(t);
  const fake = await fakeFor(t, root);
  const target = await echoServer(t);
  const gone = exposeFor(t, 40021, SCOPES.loopback);
  exposeFor(t, target.address().port, SCOPES.loopback);
  await hostRelay.init();
  await waitFor(() => fake.control()?.ports.length === 1);
  gone.handle.close();
  await waitFor(() => fake.control().ports.length === 2);
  fake.send({ t: P.frames.incoming, port: 40021, scope: SCOPES.loopback, conn: 'g'.repeat(16) });
  fake.send({ t: P.frames.incoming, port: target.address().port, scope: SCOPES.lan, conn: 'h'.repeat(16) });
  await sleep(300);
  assert.equal(fake.dataAuths.length, 0);
  assert.equal(hostRelay.status().state, 'up', 'ignored, not fatal');
  fake.send({ t: P.frames.incoming, port: target.address().port, scope: SCOPES.loopback, conn: 'i'.repeat(16) });
  await waitFor(() => target.connections === 1);
  assert.deepEqual(fake.dataAuths.map((d) => d.conn), ['i'.repeat(16)]);
});

// Invariant (S3): a pair withdrawn and exposed again (an app restarted on the
// same port) never reports a host port the relay gave its earlier exposure —
// neither one cached before, nor one in an answer still in flight.
test('H11: a re-exposed pair reports only the host port bound for it, never a stale one', async (t) => {
  const root = await setup(t);
  for (const statusDelayMs of [0, 150]) {
    const fake = await fakeFor(t, root, { statusDelayMs });
    await hostRelay.init();
    await waitFor(() => hostRelay.status().state === 'up');
    const before = fake.controls.at(-1).ports.length;
    const first = hostRelay.expose(40031, SCOPES.loopback, { host: '127.0.0.1', port: 40031 });
    if (!statusDelayMs) await waitFor(() => first.hostPort() !== null);
    const stale = 50000 + before + 1;
    first.close();
    const again = exposeFor(t, 40031, SCOPES.loopback).handle;
    const seen = new Set();
    const sampler = setInterval(() => seen.add(again.hostPort()), 1);
    await waitFor(() => again.hostPort() !== null);
    clearInterval(sampler);
    seen.add(again.hostPort());
    assert.ok(!seen.has(stale), `reported the stale host port (delay ${statusDelayMs})`);
    assert.equal(again.hostPort(), 50000 + before + 3, 'the answer to the frame that re-exposed it');
    again.close();
    hostRelay.stop();
    await fake.close();
  }
});

// Invariant (S5): code-hub alone can never trip the relay's cap on
// unauthenticated connections — its own bound is below the cap, and a burst of
// incoming frames never has more than that many handshakes in flight, yet all
// of them complete.
test('B2: a burst of 50 incoming frames never exceeds maxHubHandshakes in flight, and all open', async (t) => {
  assert.ok(P.maxHubHandshakes < P.maxPendingHandshakes, 'the hub\'s bound is below the relay\'s cap');
  const root = await setup(t);
  const fake = await fakeFor(t, root, { dataDelayMs: 40 });
  const target = await echoServer(t);
  const port = target.address().port;
  exposeFor(t, port, SCOPES.loopback);
  await hostRelay.init();
  await waitFor(() => hostRelay.status().state === 'up');
  let maxSeen = 0;
  const sampler = setInterval(() => { maxSeen = Math.max(maxSeen, hostRelay._handshakesInFlight()); }, 2);
  t.after(() => clearInterval(sampler));
  for (let i = 0; i < 50; i++) fake.send({ t: P.frames.incoming, port, scope: SCOPES.loopback, conn: `burst${String(i).padStart(4, '0')}` });
  await waitFor(() => target.connections === 50, { timeout: 10000 });
  assert.equal(fake.dataWelcomed, 50);
  assert.ok(fake.maxPreAuth <= P.maxHubHandshakes, `the relay saw ${fake.maxPreAuth} pre-auth connections at once`);
  assert.ok(fake.maxPreAuth > 1, 'handshakes do run in parallel');
  assert.ok(maxSeen <= P.maxHubHandshakes, `${maxSeen} in flight`);
});
