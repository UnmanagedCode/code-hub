import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createServer } from '../server.js';
import * as appManager from '../src/appManager.js';
import { unregisterInMemory } from '../src/projects.js';
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
    unregisterInMemory('code-conductor');
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

test('embedded, no .hub.json on the conductor dir: init() still surfaces it via an in-memory registration, not sourceMissing', async (t) => {
  const { srv: conductorSrv, port: conductorPort } = await bootFakeConductor();
  process.env.CONDUCTOR_PLUGIN_ID = 'code-hub';
  process.env.CONDUCTOR_URL = `http://127.0.0.1:${conductorPort}`;

  const root = await mkRoot();
  await mkProject(root, 'code-conductor', null); // no .hub.json — the deleted-manifest scenario
  const { server, base } = await bootHub();

  t.after(async () => {
    delete process.env.CONDUCTOR_PLUGIN_ID;
    delete process.env.CONDUCTOR_URL;
    unregisterInMemory('code-conductor');
    server.close();
    conductorSrv.close();
    await rmRoot(root);
  });

  const res = await j(base, 'GET', '/api/apps');
  assert.equal(res.status, 200);
  const main = res.body.apps.find((a) => a.id === 'code-conductor');
  assert.ok(main);
  assert.equal(main.status, 'running');
  assert.equal(main.alwaysOn, true);
  assert.equal(main.port, conductorPort);
  assert.equal(main.sourceMissing, false);
  assert.equal(main.error, null);
});

test('embedded with CONDUCTOR_PROJECT_DIR outside the projects root: host conductor still surfaces always-on from the injected dir', async (t) => {
  process.env.CODEHUB_CLOUDFLARED_BIN = fakeCloudflaredBin;
  const { srv: conductorSrv, port: conductorPort } = await bootFakeConductor();
  process.env.CONDUCTOR_PLUGIN_ID = 'code-hub';
  process.env.CONDUCTOR_URL = `http://127.0.0.1:${conductorPort}`;

  // Scanned projects root has NO code-conductor dir; the conductor checkout
  // lives under a separate parent, outside the root (git repo, no .hub.json).
  const root = await mkRoot();
  const outsideParent = await fs.mkdtemp(path.join(os.tmpdir(), 'codehub-conductor-'));
  const conductorDir = await mkProject(outsideParent, 'code-conductor', null, { git: true });
  process.env.CONDUCTOR_PROJECT_DIR = conductorDir;

  const { server, base } = await bootHub();

  t.after(async () => {
    delete process.env.CONDUCTOR_PLUGIN_ID;
    delete process.env.CONDUCTOR_URL;
    delete process.env.CONDUCTOR_PROJECT_DIR;
    server.close();
    conductorSrv.close();
    await rmRoot(root);
    await rmRoot(outsideParent);
  });

  let res = await j(base, 'GET', '/api/apps');
  assert.equal(res.status, 200);
  const main = res.body.apps.find((a) => a.id === 'code-conductor');
  assert.ok(main, 'host conductor should surface even though its dir is outside the root');
  assert.equal(main.status, 'running');
  assert.equal(main.alwaysOn, true);
  assert.equal(main.port, conductorPort);
  assert.equal(main.isWorktree, false);
  assert.equal(main.sourceMissing, false);
  assert.equal(main.path, conductorDir);
  // Git info reads from the injected dir (proves path-based git works out-of-root).
  assert.ok(main.currentSha, 'currentSha read from the injected dir');
  assert.ok(main.lastCommitAt, 'lastCommitAt read from the injected dir');

  // Start/stop/restart are blocked; share works against the running conductor.
  assert.equal((await j(base, 'POST', '/api/apps/code-conductor/start')).status, 409);
  assert.equal((await j(base, 'POST', '/api/apps/code-conductor/stop')).status, 409);
  assert.equal((await j(base, 'POST', '/api/apps/code-conductor/restart')).status, 409);

  res = await j(base, 'POST', '/api/apps/code-conductor/share');
  assert.equal(res.status, 200);
  assert.match(res.body.url, /trycloudflare\.com$/);

  res = await j(base, 'DELETE', '/api/apps/code-conductor/share');
  assert.equal(res.status, 200);
  assert.equal(res.body.tunnel, null);
});

test('embedded, worktree with no .hub.json of its own inherits the host conductor\'s in-memory manifest', async (t) => {
  const { srv: conductorSrv, port: conductorPort } = await bootFakeConductor();
  process.env.CONDUCTOR_PLUGIN_ID = 'code-hub';
  process.env.CONDUCTOR_URL = `http://127.0.0.1:${conductorPort}`;

  const root = await mkRoot();
  await mkProject(root, 'code-conductor', null); // no .hub.json — init() registers it in-memory
  await mkProject(root, 'code-conductor_worktree_ab12cd', null); // no .hub.json, no own registration
  const { server, base } = await bootHub();

  t.after(async () => {
    delete process.env.CONDUCTOR_PLUGIN_ID;
    delete process.env.CONDUCTOR_URL;
    unregisterInMemory('code-conductor');
    server.close();
    conductorSrv.close();
    await rmRoot(root);
  });

  const res = await j(base, 'GET', '/api/apps');
  assert.equal(res.status, 200);
  const wt = res.body.apps.find((a) => a.id === 'code-conductor_worktree_ab12cd');
  assert.ok(wt, 'worktree should be surfaced via parent in-memory-manifest inheritance');
  assert.equal(wt.isWorktree, true);
  assert.equal(wt.project, 'code-conductor');
  assert.equal(wt.source, 'memory');
  assert.equal(wt.alwaysOn, false);
  assert.equal(wt.status, 'stopped');
  assert.equal(wt.error, null);
});

test('embedded with CONDUCTOR_PROJECT_DIR pointing in-root: its own worktree still inherits the in-memory manifest', async (t) => {
  // Regression coverage: a prior version only called registerInMemory() in
  // the discovery-fallback branch (no CONDUCTOR_PROJECT_DIR), so this
  // injected-dir path never registered code-conductor's manifest in memory
  // and any code-conductor_worktree_* dir silently vanished from the listing
  // — even though its checkout was right there on disk.
  const { srv: conductorSrv, port: conductorPort } = await bootFakeConductor();
  process.env.CONDUCTOR_PLUGIN_ID = 'code-hub';
  process.env.CONDUCTOR_URL = `http://127.0.0.1:${conductorPort}`;

  const root = await mkRoot();
  const conductorDir = await mkProject(root, 'code-conductor', null); // no .hub.json, lives in-root
  process.env.CONDUCTOR_PROJECT_DIR = conductorDir; // modern conductor injects its own dir
  await mkProject(root, 'code-conductor_worktree_ab12cd', null, { git: true }); // no .hub.json, no own registration

  const { server, base } = await bootHub();

  t.after(async () => {
    delete process.env.CONDUCTOR_PLUGIN_ID;
    delete process.env.CONDUCTOR_URL;
    delete process.env.CONDUCTOR_PROJECT_DIR;
    unregisterInMemory('code-conductor');
    server.close();
    conductorSrv.close();
    await rmRoot(root);
  });

  const res = await j(base, 'GET', '/api/apps');
  assert.equal(res.status, 200);

  const main = res.body.apps.find((a) => a.id === 'code-conductor');
  assert.ok(main);
  assert.equal(main.status, 'running');
  assert.equal(main.alwaysOn, true);
  assert.equal(main.isWorktree, false);
  assert.equal(main.path, conductorDir); // still resolved from the injected dir

  const wt = res.body.apps.find((a) => a.id === 'code-conductor_worktree_ab12cd');
  assert.ok(wt, 'worktree of an in-root, injected-dir host conductor should still be surfaced via manifest inheritance');
  assert.equal(wt.isWorktree, true);
  assert.equal(wt.project, 'code-conductor');
  assert.equal(wt.source, 'memory');
  assert.equal(wt.alwaysOn, false);
  assert.equal(wt.status, 'stopped');
  assert.equal(wt.error, null);
  assert.ok(wt.branch); // some default branch name, resolved via git.js
});
