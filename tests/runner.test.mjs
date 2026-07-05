import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
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
  const rec = runner.start(app, port);
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
  const rec = runner.start(app, port);
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
  runner.start(app, port);
  await waitFor(() => runner.runtime('boom')?.status === 'crashed');
  assert.match(runner.runtime('boom').error, /exited|boom/);
});
