import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from '../server.js';
import * as appManager from '../src/appManager.js';
import { mkRoot, rmRoot, mkProject, waitFor, fakeAppCmd, fakeCloudflaredBin } from './helpers.mjs';

async function bootFakeConductor() {
  const srv = http.createServer((req, res) => { res.writeHead(200); res.end('conductor-ui'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, port: srv.address().port };
}

async function bootHub() {
  await appManager.init();
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base };
}

const j = async (base, method, path) => {
  const r = await fetch(base + path, { method });
  return { status: r.status, body: await r.json() };
};

test('embedded: host code-conductor is always-on (share works, start/stop blocked), its worktree stays normal', async (t) => {
  process.env.CODEHUB_CLOUDFLARED_BIN = fakeCloudflaredBin;
  const { srv: conductorSrv, port: conductorPort } = await bootFakeConductor();
  process.env.CONDUCTOR_PLUGIN_ID = 'code-hub';
  process.env.CONDUCTOR_URL = `http://127.0.0.1:${conductorPort}`;

  const root = await mkRoot();
  await mkProject(root, 'code-conductor', { start: fakeAppCmd() });
  await mkProject(root, 'code-conductor_worktree_ab12cd', { start: fakeAppCmd() });
  const { server, base } = await bootHub();

  t.after(async () => {
    delete process.env.CONDUCTOR_PLUGIN_ID;
    delete process.env.CONDUCTOR_URL;
    await appManager.stop('code-conductor_worktree_ab12cd').catch(() => {});
    server.close();
    conductorSrv.close();
    await rmRoot(root);
  });

  // Listing: the main checkout is always-on with the conductor's own port;
  // its worktree is an ordinary, independent, stopped app.
  let res = await j(base, 'GET', '/api/apps');
  assert.equal(res.status, 200);
  const main = res.body.apps.find((a) => a.id === 'code-conductor');
  assert.equal(main.status, 'running');
  assert.equal(main.alwaysOn, true);
  assert.equal(main.port, conductorPort);
  assert.equal(main.isWorktree, false);

  const wt = res.body.apps.find((a) => a.id === 'code-conductor_worktree_ab12cd');
  assert.equal(wt.isWorktree, true);
  assert.equal(wt.alwaysOn, false);
  assert.equal(wt.status, 'stopped');

  // Start/stop/restart are blocked on the main checkout.
  assert.equal((await j(base, 'POST', '/api/apps/code-conductor/start')).status, 409);
  assert.equal((await j(base, 'POST', '/api/apps/code-conductor/stop')).status, 409);
  assert.equal((await j(base, 'POST', '/api/apps/code-conductor/restart')).status, 409);

  // Share works against the externally-running conductor.
  res = await j(base, 'POST', '/api/apps/code-conductor/share');
  assert.equal(res.status, 200);
  assert.match(res.body.url, /trycloudflare\.com$/);
  assert.match(res.body.qrSvg, /<svg/);

  res = await j(base, 'DELETE', '/api/apps/code-conductor/share');
  assert.equal(res.status, 200);
  assert.equal(res.body.tunnel, null);

  // The worktree remains fully independent: normal start/stop lifecycle.
  res = await j(base, 'POST', '/api/apps/code-conductor_worktree_ab12cd/start');
  assert.equal(res.status, 200);
  await waitFor(async () => {
    const { body } = await j(base, 'GET', '/api/apps');
    return ['ready', 'running'].includes(body.apps.find((a) => a.id === 'code-conductor_worktree_ab12cd').status);
  });
  res = await j(base, 'POST', '/api/apps/code-conductor_worktree_ab12cd/stop');
  assert.equal(res.status, 200);
});

test('standalone (no CONDUCTOR_* env vars): a project literally named code-conductor behaves like any ordinary app', async (t) => {
  delete process.env.CONDUCTOR_PLUGIN_ID;
  delete process.env.CONDUCTOR_URL;

  const root = await mkRoot();
  await mkProject(root, 'code-conductor', { start: fakeAppCmd() });
  const { server, base } = await bootHub();
  t.after(async () => { await appManager.stop('code-conductor').catch(() => {}); server.close(); await rmRoot(root); });

  let res = await j(base, 'GET', '/api/apps');
  const app0 = res.body.apps.find((a) => a.id === 'code-conductor');
  assert.equal(app0.status, 'stopped');
  assert.equal(app0.alwaysOn, false);

  res = await j(base, 'POST', '/api/apps/code-conductor/start');
  assert.equal(res.status, 200);
  await waitFor(async () => {
    const { body } = await j(base, 'GET', '/api/apps');
    return ['ready', 'running'].includes(body.apps.find((a) => a.id === 'code-conductor').status);
  });

  res = await j(base, 'POST', '/api/apps/code-conductor/stop');
  assert.equal(res.status, 200);
});
