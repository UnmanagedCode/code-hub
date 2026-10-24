import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import * as runner from '../src/runner.js';
import { allocatePort } from '../src/net.js';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { mkRoot, rmRoot, mkProject, waitFor, pidAlive, fakeAppCmd } from './helpers.mjs';

function get(port) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/' }, (res) => { res.resume(); resolve(res.statusCode); })
      .on('error', reject);
  });
}

test('start injects PORT, becomes ready (TCP), and serves; stop kills the process group', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const dir = await mkProject(root, 'app', { start: fakeAppCmd() });
  const app = { id: 'app', path: dir, manifest: { start: fakeAppCmd(), healthPath: null, readyWhen: null } };

  const port = await allocatePort();
  const rec = await runner.start(app, port);
  assert.equal(rec.port, port);
  assert.equal(rec.pid, rec.pgid);

  await waitFor(() => runner.runtime('app')?.status === 'ready');
  assert.equal(await get(port), 200);

  runner.stop({ id: 'app', pgid: rec.pgid });
  await waitFor(() => !pidAlive(rec.pgid));
  assert.equal(pidAlive(rec.pgid), false);
});

test('readyWhen regex drives readiness from stdout', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const dir = await mkProject(root, 'app', { start: fakeAppCmd() });
  const app = { id: 'rw', path: dir, manifest: { start: fakeAppCmd(), healthPath: null, readyWhen: 'listening on' } };

  const port = await allocatePort();
  const rec = await runner.start(app, port);
  await waitFor(() => runner.runtime('rw')?.status === 'ready');
  runner.stop({ id: 'rw', pgid: rec.pgid });
  await waitFor(() => !pidAlive(rec.pgid));
});

test('readyWhen matches a ready line split across two output chunks', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const dir = await mkProject(root, 'app', { start: fakeAppCmd('split') });
  const app = { id: 'rwsplit', path: dir, manifest: { start: fakeAppCmd('split'), healthPath: null, readyWhen: 'listening on \\d+' } };

  const port = await allocatePort();
  const rec = await runner.start(app, port);
  t.after(() => runner.stop({ id: 'rwsplit', pgid: rec.pgid }));
  await waitFor(() => runner.runtime('rwsplit')?.status === 'ready');
  runner.stop({ id: 'rwsplit', pgid: rec.pgid });
  await waitFor(() => !pidAlive(rec.pgid));
});

// Pins: the runner advances the matcher's `total` with every chunk. A frozen
// total makes each scan cover only the overlap tail, so a ready line followed
// by at least READY_OVERLAP_CHARS more output in the same tick is never seen.
test('readyWhen still finds a ready line buried under more than READY_OVERLAP_CHARS of later output', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const dir = await mkProject(root, 'app', { start: fakeAppCmd('flood') });
  const app = { id: 'rwflood', path: dir, manifest: { start: fakeAppCmd('flood'), healthPath: null, readyWhen: 'listening on \\d+' } };

  const port = await allocatePort();
  const rec = await runner.start(app, port);
  t.after(() => runner.stop({ id: 'rwflood', pgid: rec.pgid }));
  await waitFor(() => runner.runtime('rwflood')?.status === 'ready');
});

test('a start command that exits immediately is reported crashed with a tail', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const dir = await mkProject(root, 'app', { start: fakeAppCmd('crash') });
  const app = { id: 'boom', path: dir, manifest: { start: fakeAppCmd('crash'), healthPath: null, readyWhen: null } };

  const port = await allocatePort();
  await runner.start(app, port);
  await waitFor(() => runner.runtime('boom')?.status === 'crashed');
  assert.match(runner.runtime('boom').error, /exited|boom/);
});

test('EADDRINUSE on first bind triggers a retry on a new port', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const dir = await mkProject(root, 'app', { start: fakeAppCmd() });
  const app = { id: 'race', path: dir, manifest: { start: fakeAppCmd(), healthPath: null, readyWhen: null } };

  const port = await allocatePort();
  // Occupy the allocated port ourselves to force a real EADDRINUSE in the child.
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(port, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => blocker.close(resolve)));

  const rec = await runner.start(app, port);
  assert.notEqual(rec.port, port);
  await waitFor(() => runner.runtime('race')?.status === 'ready');

  runner.stop({ id: 'race', pgid: rec.pgid });
  await waitFor(() => !pidAlive(rec.pgid));
});

test('EADDRINUSE that never clears still surfaces as crashed after the retry budget', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const dir = await mkProject(root, 'app', { start: fakeAppCmd('addrinuse') });
  const app = { id: 'stuck', path: dir, manifest: { start: fakeAppCmd('addrinuse'), healthPath: null, readyWhen: null } };

  const port = await allocatePort();
  await runner.start(app, port);
  assert.equal(runner.runtime('stuck').status, 'crashed');
  assert.match(runner.runtime('stuck').error, /EADDRINUSE/);
});

test('a pinned port that is busy does NOT move — no retry, surfaces as crashed', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const dir = await mkProject(root, 'app', { start: fakeAppCmd() });
  const app = { id: 'pinned', path: dir, manifest: { start: fakeAppCmd(), healthPath: null, readyWhen: null } };

  const port = await allocatePort();
  // Same deliberate-blocker setup as the retry test above — the only difference
  // is `{ fixed: true }`, so this pins exactly the behaviour that flag buys:
  // the retry path would have returned a DIFFERENT port here.
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(port, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => blocker.close(resolve)));

  const rec = await runner.start(app, port, { fixed: true });
  assert.equal(rec.port, port, 'a fixed port must never be silently reallocated');
  assert.equal(runner.runtime('pinned').status, 'crashed');
  assert.match(runner.runtime('pinned').error, /EADDRINUSE/);
});

test('a pinned port that is free starts normally', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const dir = await mkProject(root, 'app', { start: fakeAppCmd() });
  const app = { id: 'pinned-ok', path: dir, manifest: { start: fakeAppCmd(), healthPath: null, readyWhen: null } };

  const port = await allocatePort();
  const rec = await runner.start(app, port, { fixed: true });
  assert.equal(rec.port, port);
  await waitFor(() => runner.runtime('pinned-ok')?.status === 'ready');
  assert.equal(await get(port), 200);

  runner.stop({ id: 'pinned-ok', pgid: rec.pgid });
  await waitFor(() => !pidAlive(rec.pgid));
});

// Invariant: the readiness outcome is observable as a promise on start()'s
// result — 'ready' once the app answers, 'crashed' for one that exits first.
test('start() returns a settled promise: ready for a healthy app, crashed for one that exits', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const dir = await mkProject(root, 'app', { start: fakeAppCmd() });
  const ok = { id: 'settle-ok', path: dir, manifest: { start: fakeAppCmd(), healthPath: null, readyWhen: null } };
  const rec = await runner.start(ok, await allocatePort());
  t.after(() => runner.stop({ id: 'settle-ok', pgid: rec.pgid }));
  assert.equal(await rec.settled, 'ready');
  assert.equal(runner.runtime('settle-ok').status, 'ready');

  const bad = { id: 'settle-crash', path: dir, manifest: { start: fakeAppCmd('crash'), healthPath: null, readyWhen: null } };
  const crashed = await runner.start(bad, await allocatePort());
  assert.equal(await crashed.settled, 'crashed');
});

// Invariant: an app never inherits the host-relay configuration — its secret is a capability to listen on the host's LAN.
test('apps are spawned without CODEHUB_RELAY_URL or CODEHUB_RELAY_SECRET in their environment', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const prev = { url: process.env.CODEHUB_RELAY_URL, secret: process.env.CODEHUB_RELAY_SECRET };
  process.env.CODEHUB_RELAY_URL = 'http://127.0.0.1:7077';
  process.env.CODEHUB_RELAY_SECRET = 'relay-secret-that-must-not-leak-0123456789';
  t.after(() => {
    for (const [k, v] of [['CODEHUB_RELAY_URL', prev.url], ['CODEHUB_RELAY_SECRET', prev.secret]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
  const marker = path.join(root, 'env.json');
  const cmd = fakeAppCmd('envdump', marker);
  const dir = await mkProject(root, 'app', { start: cmd });
  const port = await allocatePort();
  const rec = await runner.start({ id: 'envdump', path: dir, manifest: { start: cmd, healthPath: null, readyWhen: null } }, port);
  t.after(() => runner.stop({ id: 'envdump', pgid: rec.pgid }));
  await waitFor(() => runner.runtime('envdump')?.status === 'ready');
  const env = JSON.parse(await fs.readFile(marker, 'utf8'));
  assert.equal(env.PORT, String(port), 'the app did get its environment');
  assert.equal('CODEHUB_RELAY_URL' in env, false);
  assert.equal('CODEHUB_RELAY_SECRET' in env, false);
  assert.ok(!JSON.stringify(env).includes('relay-secret-that-must-not-leak'));
});
