import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import * as runner from '../src/runner.js';
import { allocatePort } from '../src/net.js';
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
