import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { existsSync, promises as fs } from 'node:fs';
import * as bridgeForward from '../src/bridgeForward.js';
import { ALT_LOOPBACK, altLoopbackBindable, listeningAddrs, waitFor } from './helpers.mjs';

// The bridge forwarder module alone, against in-test servers on 127.0.0.1.
// ALT_LOOPBACK stands in for the container's bridge address: a bind target
// distinct from 127.0.0.1 that a 0.0.0.0 bind covers, just like a real one.

const ANOTHER_LOOPBACK = '127.0.0.3';
const tick = () => new Promise((r) => setImmediate(r));

async function guard(t) {
  if (process.platform !== 'linux' || !existsSync(`/proc/${process.pid}/net/tcp`) || !(await altLoopbackBindable())) {
    t.skip(`${ALT_LOOPBACK} is not a bindable loopback alias here, or /proc is unavailable`);
    return false;
  }
  t.after(() => bridgeForward.reset());
  t.mock.method(console, 'error', () => {});
  return true;
}

function listen(server, host = '127.0.0.1', port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(server.address().port); });
  });
}

// An HTTP app on 127.0.0.1 only, closed after `t`: its port.
async function upstreamApp(t, body = 'up') {
  const server = http.createServer((req, res) => res.end(body));
  const port = await listen(server);
  t.after(() => server.close());
  return port;
}

function get(port, host) {
  return new Promise((resolve, reject) => {
    http.get({ host, port, path: '/', agent: false }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

const own = () => listeningAddrs(process.pid);
const bound = (host) => waitFor(() => bridgeForward.urlHost('a') === host, { timeout: 2000 });

// Invariant: a forwarder binds the given host at the app's port — that address
// only, never 0.0.0.0 — and forwards bytes to the app on 127.0.0.1.
test('F1: binds only the given host and forwards to the app', async (t) => {
  if (!(await guard(t))) return;
  const port = await upstreamApp(t);
  bridgeForward.sync([{ id: 'a', port }], ALT_LOOPBACK);
  await bound(ALT_LOOPBACK);
  const addrs = await own();
  assert.ok(addrs.has(`${ALT_LOOPBACK}:${port}`), [...addrs].join(' '));
  assert.ok(!addrs.has(`0.0.0.0:${port}`), [...addrs].join(' '));
  assert.deepEqual(await get(port, ALT_LOOPBACK), { status: 200, body: 'up' });
});

// Invariant: when the address is already taken (the app bound 0.0.0.0), the
// app is presumed reachable there itself — the bridge URL is still offered,
// with no forwarder of ours, and nothing throws.
test('F2: a collision offers the bridge address with no listener', async (t) => {
  if (!(await guard(t))) return;
  const holder = net.createServer();
  const port = await listen(holder, '0.0.0.0');
  t.after(() => holder.close());
  assert.doesNotThrow(() => bridgeForward.sync([{ id: 'a', port }], ALT_LOOPBACK));
  await bound(ALT_LOOPBACK);
  assert.ok(!(await own()).has(`${ALT_LOOPBACK}:${port}`));
  assert.match(console.error.mock.calls.at(-1).arguments[0], /already taken/);
});

// Invariant: any other bind error leaves the app on its localhost URL (no
// host offered) and never throws to the caller.
test('F3: another bind error offers no host and never throws', async (t) => {
  if (!(await guard(t))) return;
  const port = await upstreamApp(t);
  assert.doesNotThrow(() => bridgeForward.sync([{ id: 'a', port }], '192.0.2.1'));
  await waitFor(() => console.error.mock.callCount() > 0, { timeout: 2000 });
  assert.match(console.error.mock.calls[0].arguments[0], /could not bind 192\.0\.2\.1/);
  assert.equal(bridgeForward.urlHost('a'), null);
});

// Invariant: a failed entry is never retried while it stands — a later sync
// of the same (id, port, host) binds nothing and offers no host.
test('F3b: a failed bind is not retried by a later sync', async (t) => {
  if (!(await guard(t))) return;
  const listenSpy = t.mock.method(net.Server.prototype, 'listen');
  const port = await upstreamApp(t);
  bridgeForward.sync([{ id: 'a', port }], '192.0.2.1');
  await waitFor(() => console.error.mock.callCount() > 0, { timeout: 2000 });
  const binds = listenSpy.mock.callCount();
  bridgeForward.sync([{ id: 'a', port }], '192.0.2.1');
  await tick();
  assert.equal(listenSpy.mock.callCount(), binds, 'no new bind');
  assert.equal(console.error.mock.callCount(), 1, 'no second failure');
  assert.equal(bridgeForward.urlHost('a'), null);
});

// Invariant: closing a forwarder leaks no accepted connection — a client held
// open through it is closed along with the listener.
test('F4: closing a forwarder closes its accepted connections', async (t) => {
  if (!(await guard(t))) return;
  const held = new Set();
  const app = net.createServer((s) => held.add(s));
  const port = await listen(app);
  t.after(() => { for (const s of held) s.destroy(); app.close(); });
  bridgeForward.sync([{ id: 'a', port }], ALT_LOOPBACK);
  await bound(ALT_LOOPBACK);
  const client = net.connect(port, ALT_LOOPBACK);
  client.on('error', () => {});
  const closed = new Promise((r) => client.once('close', r));
  await waitFor(() => held.size === 1, { timeout: 2000 });
  bridgeForward.sync([], ALT_LOOPBACK);
  await closed;
  assert.ok(!(await own()).has(`${ALT_LOOPBACK}:${port}`));
});

// This process's open TCP sockets connected to 127.0.0.1:`port` (from /proc,
// matched by socket inode), i.e. the forwarder's upstream connections to an
// in-test app on that port.
async function ownConnectionsTo(port) {
  const inodes = new Set();
  for (const fd of await fs.readdir(`/proc/${process.pid}/fd`)) {
    const m = /^socket:\[(\d+)\]$/.exec(await fs.readlink(`/proc/${process.pid}/fd/${fd}`).catch(() => ''));
    if (m) inodes.add(m[1]);
  }
  const remote = `0100007F:${port.toString(16).toUpperCase().padStart(4, '0')}`;
  return (await fs.readFile(`/proc/${process.pid}/net/tcp`, 'utf8')).split('\n').slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((f) => f.length >= 10 && f[2] === remote && inodes.has(f[9])).length;
}

// Invariant: the two sides of a forwarded connection close together — the
// client hanging up destroys the forwarder's upstream connection, even to an
// app that keeps its side half-open.
test('F4b: a client that hangs up closes its upstream connection', async (t) => {
  if (!(await guard(t))) return;
  const held = new Set();
  const app = net.createServer({ allowHalfOpen: true }, (s) => { s.on('error', () => {}); held.add(s); });
  const port = await listen(app);
  t.after(() => { for (const s of held) s.destroy(); app.close(); });
  bridgeForward.sync([{ id: 'a', port }], ALT_LOOPBACK);
  await bound(ALT_LOOPBACK);
  const client = net.connect(port, ALT_LOOPBACK);
  client.on('error', () => {});
  await waitFor(() => held.size === 1, { timeout: 2000 });
  assert.equal(await ownConnectionsTo(port), 1);
  client.destroy();
  await waitFor(async () => (await ownConnectionsTo(port)) === 0, { timeout: 2000 });
  assert.equal(bridgeForward.urlHost('a'), ALT_LOOPBACK, 'the forwarder itself stays up');
});

// Invariant: no listener survives a close that races its still-pending bind.
test('F5: a close in the same tick as the open leaves no listener', async (t) => {
  if (!(await guard(t))) return;
  const port = await upstreamApp(t);
  bridgeForward.sync([{ id: 'a', port }], ALT_LOOPBACK);
  bridgeForward.sync([], ALT_LOOPBACK);
  await tick();
  assert.ok(!(await own()).has(`${ALT_LOOPBACK}:${port}`));
  assert.equal(bridgeForward.urlHost('a'), null);
});

// Invariant: a bind failing after its entry was closed is ignored — no
// failure is reported for a forwarder nobody wants any more.
test('F5b: a bind error arriving after the close is ignored', async (t) => {
  if (!(await guard(t))) return;
  const port = await upstreamApp(t);
  bridgeForward.sync([{ id: 'a', port }], '192.0.2.1');
  bridgeForward.sync([], '192.0.2.1');
  await tick();
  await tick();
  assert.equal(console.error.mock.callCount(), 0);
  assert.equal(bridgeForward.urlHost('a'), null);
});

// Invariant: an entry follows its (port, host) — a change closes the old
// address and binds the new one.
test('F6: a port or host change moves the listener', async (t) => {
  if (!(await guard(t))) return;
  const p1 = await upstreamApp(t);
  const p2 = await upstreamApp(t);
  bridgeForward.sync([{ id: 'a', port: p1 }], ALT_LOOPBACK);
  await bound(ALT_LOOPBACK);
  bridgeForward.sync([{ id: 'a', port: p2 }], ALT_LOOPBACK);
  await waitFor(async () => (await own()).has(`${ALT_LOOPBACK}:${p2}`), { timeout: 2000 });
  assert.ok(!(await own()).has(`${ALT_LOOPBACK}:${p1}`));
  bridgeForward.sync([{ id: 'a', port: p2 }], ANOTHER_LOOPBACK);
  await bound(ANOTHER_LOOPBACK);
  const addrs = await own();
  assert.ok(addrs.has(`${ANOTHER_LOOPBACK}:${p2}`) && !addrs.has(`${ALT_LOOPBACK}:${p2}`), [...addrs].join(' '));
  assert.deepEqual(await get(p2, ANOTHER_LOOPBACK), { status: 200, body: 'up' });
});

// Invariant: a standing entry is never re-bound — a repeated sync keeps the
// same listener, and a `direct` entry stays direct after the address frees up
// (a reloading app can't lose it to the forwarder) until the entry is removed.
test('F7: no retry — repeated syncs bind once, and a direct entry stays direct', async (t) => {
  if (!(await guard(t))) return;
  const listenSpy = t.mock.method(net.Server.prototype, 'listen');
  const port = await upstreamApp(t);
  const before = listenSpy.mock.callCount();
  for (let i = 0; i < 3; i++) bridgeForward.sync([{ id: 'a', port }], ALT_LOOPBACK);
  await bound(ALT_LOOPBACK);
  bridgeForward.sync([{ id: 'a', port }], ALT_LOOPBACK);
  assert.equal(listenSpy.mock.callCount() - before, 1);

  const holder = net.createServer();
  const held = await listen(holder, '0.0.0.0');
  t.after(() => holder.close());
  bridgeForward.sync([{ id: 'b', port: held }], ALT_LOOPBACK);
  await waitFor(() => bridgeForward.urlHost('b') === ALT_LOOPBACK, { timeout: 2000 });
  await new Promise((r) => holder.close(r));
  const binds = listenSpy.mock.callCount();
  bridgeForward.sync([{ id: 'b', port: held }], ALT_LOOPBACK);
  await tick();
  assert.equal(listenSpy.mock.callCount(), binds, 'no new bind');
  assert.equal(bridgeForward.urlHost('b'), ALT_LOOPBACK);
  assert.ok(!(await own()).has(`${ALT_LOOPBACK}:${held}`));
  bridgeForward.sync([], ALT_LOOPBACK);
  bridgeForward.sync([{ id: 'b', port: held }], ALT_LOOPBACK);
  await waitFor(async () => (await own()).has(`${ALT_LOOPBACK}:${held}`), { timeout: 2000 });
});
