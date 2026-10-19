import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer, start as startServer } from '../server.js';
import * as appManager from '../src/appManager.js';
import * as appSettings from '../src/appSettings.js';
import { unregisterInMemory } from '../src/projects.js';
import * as conductorProjects from '../src/conductorProjects.js';
import { mkRoot, rmRoot, mkProject, mkWorktree, gitCommit, waitFor, fakeAppCmd, fakeCloudflaredBin, fakeTailscaleBin, ccProject, holdShareAtSettingsRead } from './helpers.mjs';

// `projects` are served at `/api/projects` exactly as the conductor serves
// them (a bare array of ProjectInfo), so the overlay exercises its real
// transport here rather than the fetch seam.
async function bootFakeConductor(projects = []) {
  const srv = http.createServer((req, res) => {
    if (req.url === '/api/projects') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(projects));
      return;
    }
    res.writeHead(200); res.end('conductor-ui');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, port: srv.address().port };
}

async function bootHub() {
  process.env.CODEHUB_TAILSCALE_BIN = fakeTailscaleBin;
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
  await mkWorktree(root, 'code-conductor', 'ab12cd', { start: fakeAppCmd() });
  const { server, base } = await bootHub();

  t.after(async () => {
    delete process.env.CONDUCTOR_PLUGIN_ID;
    delete process.env.CONDUCTOR_URL;
    unregisterInMemory('code-conductor');
    await appManager.stop('code-conductor:ab12cd').catch(() => {});
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

  const wt = res.body.apps.find((a) => a.id === 'code-conductor:ab12cd');
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
  res = await j(base, 'POST', '/api/apps/code-conductor%3Aab12cd/start');
  assert.equal(res.status, 200);
  await waitFor(async () => {
    const { body } = await j(base, 'GET', '/api/apps');
    return ['ready', 'running'].includes(body.apps.find((a) => a.id === 'code-conductor:ab12cd').status);
  });
  res = await j(base, 'POST', '/api/apps/code-conductor%3Aab12cd/stop');
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

  const warnMock = t.mock.method(console, 'warn', () => {});
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
  // No in-root sibling and no in-memory registration for an out-of-root
  // checkout ⇒ discoverApps()'s orphaned-registry-key warning must never fire.
  assert.equal(warnMock.mock.callCount(), 0);

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

test('embedded with CONDUCTOR_PROJECT_DIR outside the root, plus a stale same-named dir under the root: the injected dir still wins', async (t) => {
  // Regression coverage: registering code-conductor in-memory unconditionally
  // let discoverApps() resolve a stale in-root `code-conductor/` sibling via
  // that registration, which then shadowed the real out-of-root checkout in
  // list() (wrong path/currentSha/lastCommitAt, right port). The fix only
  // registers in-memory when the injected dir is itself under the scanned
  // root, so an out-of-root checkout must never be affected by an unrelated
  // same-named dir under the root.
  process.env.CODEHUB_CLOUDFLARED_BIN = fakeCloudflaredBin;
  const { srv: conductorSrv, port: conductorPort } = await bootFakeConductor();
  process.env.CONDUCTOR_PLUGIN_ID = 'code-hub';
  process.env.CONDUCTOR_URL = `http://127.0.0.1:${conductorPort}`;

  const root = await mkRoot();
  // Stale/unrelated dir that happens to share the id, with its own distinct
  // git history (an extra commit) — if it ever won, its sha would differ
  // from the real one.
  const staleDir = await mkProject(root, 'code-conductor', null, { git: true });
  gitCommit(staleDir, 'stale, unrelated commit');

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

  const res = await j(base, 'GET', '/api/apps');
  assert.equal(res.status, 200);
  const main = res.body.apps.find((a) => a.id === 'code-conductor');
  assert.ok(main);
  assert.equal(main.path, conductorDir, 'must resolve from the injected dir, not the stale in-root sibling');
  assert.notEqual(main.path, staleDir);

  const expectedSha = execFileSync('git', ['-C', conductorDir, 'rev-parse', 'HEAD']).toString().trim();
  const staleSha = execFileSync('git', ['-C', staleDir, 'rev-parse', 'HEAD']).toString().trim();
  assert.notEqual(expectedSha, staleSha, 'test setup sanity: the two checkouts must have distinct history');
  assert.equal(main.currentSha, expectedSha, 'currentSha must read from the injected dir, not the stale sibling');
  assert.equal(main.sourceMissing, false);
});

test('embedded, worktree with no .hub.json of its own inherits the host conductor\'s in-memory manifest', async (t) => {
  const { srv: conductorSrv, port: conductorPort } = await bootFakeConductor();
  process.env.CONDUCTOR_PLUGIN_ID = 'code-hub';
  process.env.CONDUCTOR_URL = `http://127.0.0.1:${conductorPort}`;

  const root = await mkRoot();
  await mkProject(root, 'code-conductor', null); // no .hub.json — init() registers it in-memory
  await mkWorktree(root, 'code-conductor', 'ab12cd', null); // no .hub.json, no own registration
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
  const wt = res.body.apps.find((a) => a.id === 'code-conductor:ab12cd');
  assert.ok(wt, 'worktree should be surfaced via parent in-memory-manifest inheritance');
  assert.equal(wt.isWorktree, true);
  assert.equal(wt.project, 'code-conductor');
  assert.equal(wt.source, 'memory');
  assert.equal(wt.alwaysOn, false);
  assert.equal(wt.status, 'stopped');
  assert.equal(wt.error, null);
});

test('embedded, conductor checkout OUTSIDE the root: its in-root worktree still inherits the in-memory manifest', async (t) => {
  // A worktree is not necessarily a sibling of its checkout: for a project on
  // cc's local system, worktrees are rooted at `<root>/.worktrees/<project>/`
  // wherever the project's own tree lives, so an out-of-root checkout DOES get
  // in-root worktrees. This is the case the second arm of `init()`'s
  // registration condition exists for — without it the worktree has nothing to
  // inherit and vanishes from the listing.
  const { srv: conductorSrv, port: conductorPort } = await bootFakeConductor();
  process.env.CONDUCTOR_PLUGIN_ID = 'code-hub';
  process.env.CONDUCTOR_URL = `http://127.0.0.1:${conductorPort}`;

  const root = await mkRoot();
  // No `<root>/code-conductor` at all — the checkout lives elsewhere.
  const outsideParent = await fs.mkdtemp(path.join(os.tmpdir(), 'codehub-conductor-'));
  const conductorDir = await mkProject(outsideParent, 'code-conductor', null, { git: true });
  process.env.CONDUCTOR_PROJECT_DIR = conductorDir;
  await mkWorktree(root, 'code-conductor', 'ab12cd', null, { git: true }); // no manifest of its own

  const { server, base } = await bootHub();

  t.after(async () => {
    delete process.env.CONDUCTOR_PLUGIN_ID;
    delete process.env.CONDUCTOR_URL;
    delete process.env.CONDUCTOR_PROJECT_DIR;
    unregisterInMemory('code-conductor');
    server.close();
    conductorSrv.close();
    await rmRoot(root);
    await rmRoot(outsideParent);
  });

  const res = await j(base, 'GET', '/api/apps');
  assert.equal(res.status, 200);

  const main = res.body.apps.find((a) => a.id === 'code-conductor');
  assert.ok(main);
  assert.equal(main.path, conductorDir);
  assert.equal(main.alwaysOn, true);

  const wt = res.body.apps.find((a) => a.id === 'code-conductor:ab12cd');
  assert.ok(wt, 'an in-root worktree of an out-of-root conductor must still surface');
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
  // and any `code-conductor:<key>` worktree silently vanished from the listing
  // — even though its checkout was right there on disk.
  const { srv: conductorSrv, port: conductorPort } = await bootFakeConductor();
  process.env.CONDUCTOR_PLUGIN_ID = 'code-hub';
  process.env.CONDUCTOR_URL = `http://127.0.0.1:${conductorPort}`;

  const root = await mkRoot();
  const conductorDir = await mkProject(root, 'code-conductor', null); // no .hub.json, lives in-root
  process.env.CONDUCTOR_PROJECT_DIR = conductorDir; // modern conductor injects its own dir
  await mkWorktree(root, 'code-conductor', 'ab12cd', null, { git: true }); // no .hub.json, no own registration

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

  const wt = res.body.apps.find((a) => a.id === 'code-conductor:ab12cd');
  assert.ok(wt, 'worktree of an in-root, injected-dir host conductor should still be surfaced via manifest inheritance');
  assert.equal(wt.isWorktree, true);
  assert.equal(wt.project, 'code-conductor');
  assert.equal(wt.source, 'memory');
  assert.equal(wt.alwaysOn, false);
  assert.equal(wt.status, 'stopped');
  assert.equal(wt.error, null);
  assert.ok(wt.branch); // some default branch name, resolved via git.js
});

test('embedded: a conductor-known project outside the root becomes a real parent card, worktree and all', async (t) => {
  // The end-to-end shape of the overlay: the conductor's own /api/projects
  // answer (over HTTP, its real transport) turns a header-only "no main
  // checkout" grouping into a main card with the tree's path and git facts,
  // while the worktree stays independently startable.
  const root = await mkRoot();
  const outsideParent = await fs.mkdtemp(path.join(os.tmpdir(), 'codehub-outside-'));
  const treeDir = await mkProject(outsideParent, 'wanderer', { start: fakeAppCmd() }, { git: true });
  const { srv: conductorSrv, port: conductorPort } = await bootFakeConductor([ccProject('wanderer', treeDir)]);
  process.env.CONDUCTOR_PLUGIN_ID = 'code-hub';
  process.env.CONDUCTOR_URL = `http://127.0.0.1:${conductorPort}`;
  await mkWorktree(root, 'wanderer', 'ab12cd', { start: fakeAppCmd() }, { git: true });

  const { server, base } = await bootHub();
  t.after(async () => {
    delete process.env.CONDUCTOR_PLUGIN_ID;
    delete process.env.CONDUCTOR_URL;
    conductorProjects._reset();
    // This env shape (embedded, no CONDUCTOR_PROJECT_DIR) is the older-conductor
    // fallback, which registers the conductor in-memory; drop it so it can't
    // leak into the next test in this file.
    unregisterInMemory('code-conductor');
    await appManager.stop('wanderer:ab12cd').catch(() => {});
    server.close();
    conductorSrv.close();
    await rmRoot(root);
    await rmRoot(outsideParent);
  });

  const res = await j(base, 'GET', '/api/apps');
  assert.equal(res.status, 200);
  const main = res.body.apps.find((a) => a.id === 'wanderer');
  assert.ok(main, 'the conductor-known tree must surface as a main checkout');
  assert.equal(main.isWorktree, false);
  assert.equal(main.path, treeDir);
  assert.equal(main.sourceMissing, false);
  assert.equal(main.alwaysOn, false);
  // Git facts are read from the overlay path, which proves the row carries a
  // real directory and not just a name.
  assert.equal(main.currentSha, execFileSync('git', ['-C', treeDir, 'rev-parse', 'HEAD']).toString().trim());
  assert.ok(main.lastCommitAt);

  const wt = res.body.apps.find((a) => a.id === 'wanderer:ab12cd');
  assert.ok(wt);
  assert.equal(wt.project, 'wanderer', 'the worktree nests under the new parent row');

  assert.equal((await j(base, 'POST', '/api/apps/wanderer%3Aab12cd/start')).status, 200);
  await waitFor(async () => {
    const { body } = await j(base, 'GET', '/api/apps');
    return ['ready', 'running'].includes(body.apps.find((a) => a.id === 'wanderer:ab12cd').status);
  });
  assert.equal((await j(base, 'POST', '/api/apps/wanderer%3Aab12cd/stop')).status, 200);
});

test('embedded: a conductor project with no manifest source gets no card at all', async (t) => {
  const root = await mkRoot();
  const outsideParent = await fs.mkdtemp(path.join(os.tmpdir(), 'codehub-outside-'));
  const treeDir = await mkProject(outsideParent, 'bare', null, { git: true }); // no .hub.json, no registration
  const { srv: conductorSrv, port: conductorPort } = await bootFakeConductor([ccProject('bare', treeDir)]);
  process.env.CONDUCTOR_PLUGIN_ID = 'code-hub';
  process.env.CONDUCTOR_URL = `http://127.0.0.1:${conductorPort}`;
  await mkWorktree(root, 'bare', 'ab12cd', null);

  const { server, base } = await bootHub();
  t.after(async () => {
    delete process.env.CONDUCTOR_PLUGIN_ID;
    delete process.env.CONDUCTOR_URL;
    conductorProjects._reset();
    // This env shape (embedded, no CONDUCTOR_PROJECT_DIR) is the older-conductor
    // fallback, which registers the conductor in-memory; drop it so it can't
    // leak into the next test in this file.
    unregisterInMemory('code-conductor');
    server.close();
    conductorSrv.close();
    await rmRoot(root);
    await rmRoot(outsideParent);
  });

  const res = await j(base, 'GET', '/api/apps');
  assert.equal(res.status, 200);
  assert.equal(res.body.apps.find((a) => a.id === 'bare'), undefined, 'no .hub.json and no registration ⇒ no card');

  // Not shown ⇒ not startable through the API either.
  const start = await j(base, 'POST', '/api/apps/bare/start');
  assert.equal(start.status, 404);
  assert.match(start.body.error, /unknown app 'bare'/);
});

test('embedded: CONDUCTOR_PROJECT_DIR still wins over the conductor\'s record of its OWN project', async (t) => {
  // `CONDUCTOR_PROJECT_DIR` is the checkout the conductor is RUNNING from,
  // which may be a worktree of itself; its project record names the main
  // checkout instead. The injected dir is the authority for this one id, so
  // the overlay must never move the always-on card onto the recorded tree.
  const { srv: conductorSrv, port: conductorPort } = await bootFakeConductor();
  const root = await mkRoot();
  const outsideParent = await fs.mkdtemp(path.join(os.tmpdir(), 'codehub-conductor-'));
  const runningDir = await mkProject(outsideParent, 'running-checkout', null, { git: true });
  const recordedDir = await mkProject(outsideParent, 'recorded-checkout', null, { git: true });
  gitCommit(recordedDir, 'a commit only the recorded checkout has');
  process.env.CONDUCTOR_PROJECT_DIR = runningDir;
  process.env.CONDUCTOR_PLUGIN_ID = 'code-hub';
  process.env.CONDUCTOR_URL = `http://127.0.0.1:${conductorPort}`;
  await mkWorktree(root, 'code-conductor', 'ab12cd', null, { git: true });

  // Re-serve /api/projects with the conductor naming its own project at a
  // DIFFERENT directory than the one it injected.
  conductorSrv.removeAllListeners('request');
  conductorSrv.on('request', (req, res) => {
    if (req.url === '/api/projects') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([ccProject('code-conductor', recordedDir)]));
      return;
    }
    res.writeHead(200); res.end('conductor-ui');
  });

  const { server, base } = await bootHub();
  t.after(async () => {
    delete process.env.CONDUCTOR_PLUGIN_ID;
    delete process.env.CONDUCTOR_URL;
    delete process.env.CONDUCTOR_PROJECT_DIR;
    unregisterInMemory('code-conductor');
    conductorProjects._reset();
    server.close();
    conductorSrv.close();
    await rmRoot(root);
    await rmRoot(outsideParent);
  });

  const res = await j(base, 'GET', '/api/apps');
  const main = res.body.apps.find((a) => a.id === 'code-conductor');
  assert.ok(main);
  assert.equal(main.path, runningDir, 'the injected running checkout, not the conductor\'s project record');
  assert.equal(main.alwaysOn, true);
  const runningSha = execFileSync('git', ['-C', runningDir, 'rev-parse', 'HEAD']).toString().trim();
  const recordedSha = execFileSync('git', ['-C', recordedDir, 'rev-parse', 'HEAD']).toString().trim();
  assert.notEqual(runningSha, recordedSha, 'test setup sanity: the two checkouts must have distinct history');
  assert.equal(main.currentSha, runningSha);
  assert.equal(res.body.apps.find((a) => a.id === 'code-conductor:ab12cd').project, 'code-conductor');
});

// Invariant: the API refuses exactly what the UI disables for the always-on
// host code-conductor: auto-start (code-hub never starts it) — auto-share, a
// login and clearing auto-start are accepted, and a refused body writes nothing.
test('embedded: PUT autoStart:true on the host code-conductor is a 400; autoShare and a login are accepted', async (t) => {
  const { srv: conductorSrv, port: conductorPort } = await bootFakeConductor();
  process.env.CONDUCTOR_PLUGIN_ID = 'code-hub';
  process.env.CONDUCTOR_URL = `http://127.0.0.1:${conductorPort}`;
  const root = await mkRoot();
  await mkProject(root, 'code-conductor', { start: fakeAppCmd() });
  const { server, base } = await bootHub();
  t.after(async () => {
    delete process.env.CONDUCTOR_PLUGIN_ID;
    delete process.env.CONDUCTOR_URL;
    unregisterInMemory('code-conductor');
    server.close();
    conductorSrv.close();
    await rmRoot(root);
  });
  const put = (body) => fetch(`${base}/api/apps/code-conductor/settings`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const refused = await put({ autoStart: true });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /host code-conductor/);

  const shared = await put({ autoShare: { mode: 'lan' } });
  assert.equal(shared.status, 200);
  const stored = { autoStart: false, autoShare: { mode: 'lan', auth: true, tls: true }, port: null };
  assert.deepEqual((await j(base, 'GET', '/api/apps/code-conductor/settings')).body, { id: 'code-conductor', username: null, hasPassword: false, ...stored });

  const both = await put({ autoStart: true, autoShare: { mode: 'tunnel' } });
  assert.equal(both.status, 400);
  assert.match(both.body.error, /host code-conductor/);
  assert.deepEqual((await j(base, 'GET', '/api/apps/code-conductor/settings')).body, { id: 'code-conductor', username: null, hasPassword: false, ...stored });

  // A fixed port is refused like auto-start: code-hub never starts the always-on app.
  const port = await put({ port: 4100 });
  assert.equal(port.status, 400);
  assert.equal(port.body.error, "auto-start and a fixed port don't apply to 'code-conductor' — it is the host code-conductor, which is always on (auto-share does apply)");
  assert.equal((await put({ port: null })).status, 200);
  assert.equal((await put({ autoStart: false })).status, 200);
  const ok = await put({ username: 'alice' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.autoStart, false);
});

// Embedded hub with the host conductor surfaced from an in-root checkout. The
// caller runs init() itself, so it can tick settings first.
async function embeddedConductor(t) {
  process.env.CODEHUB_CLOUDFLARED_BIN = fakeCloudflaredBin;
  process.env.CODEHUB_TAILSCALE_BIN = fakeTailscaleBin;
  const { srv, port } = await bootFakeConductor();
  process.env.CONDUCTOR_PLUGIN_ID = 'code-hub';
  process.env.CONDUCTOR_URL = `http://127.0.0.1:${port}`;
  const root = await mkRoot();
  await mkProject(root, 'code-conductor', { start: fakeAppCmd() });
  t.after(async () => {
    await appManager.unshare('code-conductor').catch(() => {});
    delete process.env.CONDUCTOR_PLUGIN_ID;
    delete process.env.CONDUCTOR_URL;
    unregisterInMemory('code-conductor');
    srv.close();
    await rmRoot(root);
  });
  return { root, conductorPort: port };
}

const getApp = async (id) => (await appManager.list()).apps.find((a) => a.id === id);
const LAN_PLAIN = { mode: 'lan', auth: false, tls: false };

// Invariant: an always-on conductor ticked for auto-share is shared when
// code-hub boots, with no start step — the share fronts the conductor's own port.
test('embedded: the always-on conductor ticked for auto-share is shared at boot with no start', async (t) => {
  await embeddedConductor(t);
  await appSettings.update('code-conductor', { autoShare: LAN_PLAIN });
  await appManager.init();
  assert.equal(await appManager.autoShareAlwaysOn(), true);
  assert.deepEqual(await appManager.awaitSettled('code-conductor'), { id: 'code-conductor', settled: true });
  const app = await getApp('code-conductor');
  assert.equal(app.status, 'running');
  assert.equal(app.alwaysOn, true);
  assert.equal(app.tunnel?.kind, 'lan');
  assert.equal(app.autoShareStatus, null);
  assert.equal(app.autoShareError, null);
  const res = await fetch(`http://127.0.0.1:${app.tunnel.proxyPort}/`);
  assert.equal(await res.text(), 'conductor-ui');
});

// Invariant: every code-hub boot (a plugin-backend restart while cc keeps
// running included) shares the always-on conductor again, and the previous
// boot's share is gone rather than left alongside the new one.
test('embedded: a plugin-backend restart while cc runs shares the conductor again, once', async (t) => {
  await embeddedConductor(t);
  await appSettings.update('code-conductor', { autoShare: LAN_PLAIN });
  await appManager.init();
  await appManager.autoShareAlwaysOn();
  await appManager.awaitSettled('code-conductor');
  const first = (await getApp('code-conductor')).tunnel;
  assert.equal(first?.kind, 'lan');

  await appManager.init(); // the restart
  await assert.rejects(fetch(`http://127.0.0.1:${first.proxyPort}/`));
  assert.equal((await getApp('code-conductor')).tunnel, null);
  assert.equal(await appManager.autoShareAlwaysOn(), true);
  await appManager.awaitSettled('code-conductor');
  const app = await getApp('code-conductor');
  assert.equal(app.tunnel?.kind, 'lan');
  assert.equal(app.autoShareStatus, null);
  assert.equal(await (await fetch(`http://127.0.0.1:${app.tunnel.proxyPort}/`)).text(), 'conductor-ui');
});

// Invariant: an always-on conductor that already has a share is not shared
// again — nothing is duplicated or replaced.
test('embedded: an already-shared always-on conductor is not shared again', async (t) => {
  await embeddedConductor(t);
  await appSettings.update('code-conductor', { autoShare: LAN_PLAIN });
  await appManager.init();
  await appManager.share('code-conductor', { mode: 'lan', tls: false });
  const before = (await getApp('code-conductor')).tunnel;
  assert.equal(await appManager.autoShareAlwaysOn(), false);
  await appManager.awaitSettled('code-conductor');
  const app = await getApp('code-conductor');
  assert.equal(app.tunnel?.proxyPort, before.proxyPort);
  assert.equal(app.tunnel?.auth, true); // the manual share's options, not the ticked config's
  assert.equal(app.autoShareStatus, null);
});

// Invariant: an always-on auto-share failure is reported on the card exactly
// like a normal app's (autoShareStatus 'failed' + the reason), with no share.
test('embedded: an always-on auto-share failure is reported like a normal app\'s', async (t) => {
  const { root } = await embeddedConductor(t);
  const real = console.error;
  console.error = () => {};
  t.after(() => { console.error = real; });
  process.env.CODEHUB_CLOUDFLARED_BIN = path.join(root, 'no-such-cloudflared');
  t.after(() => { process.env.CODEHUB_CLOUDFLARED_BIN = fakeCloudflaredBin; });
  await appSettings.update('code-conductor', { autoShare: { mode: 'tunnel' } });
  await appManager.init();
  assert.equal(await appManager.autoShareAlwaysOn(), true);
  await appManager.awaitSettled('code-conductor');
  const app = await getApp('code-conductor');
  assert.equal(app.status, 'running');
  assert.equal(app.tunnel, null);
  assert.equal(app.autoShareStatus, 'failed');
  assert.match(app.autoShareError, /cloudflared/);
  // autoRun's outcome is process state a re-run init() keeps (a real boot is a
  // fresh process); a successful share clears it, so later tests boot clean.
  process.env.CODEHUB_CLOUDFLARED_BIN = fakeCloudflaredBin;
  await appManager.share('code-conductor', { mode: 'lan', tls: false });
});

// Invariant: autoShareAlwaysOn() re-checks the record after its settings read
// — a fresh init() landing during that read supersedes it, so the call begins
// nothing: no share, no proxy, nothing pending.
test('embedded: an init() during the always-on settings read makes autoShareAlwaysOn() begin nothing', async (t) => {
  await embeddedConductor(t);
  await appSettings.update('code-conductor', { autoShare: LAN_PLAIN });
  await appManager.init();
  const hold = holdShareAtSettingsRead(t);
  const call = appManager.autoShareAlwaysOn();
  await hold.parked;
  await appManager.init();
  hold.release();
  assert.equal(await call, false);
  assert.deepEqual(await appManager.awaitSettled('code-conductor'), { id: 'code-conductor', settled: true });
  const app = await getApp('code-conductor');
  assert.equal(app.tunnel, null);
  assert.equal(app.autoShareStatus, null);
  assert.deepEqual(hold.listening(), []);
});

// Invariant: autoShareAlwaysOn() re-checks for a share after its settings
// read — a manual share completing during that read wins, and the call begins
// nothing: the manual share stays the only one, nothing pending.
test('embedded: a manual share during the always-on settings read makes autoShareAlwaysOn() begin nothing', async (t) => {
  await embeddedConductor(t);
  await appSettings.update('code-conductor', { autoShare: LAN_PLAIN });
  await appManager.init();
  const hold = holdShareAtSettingsRead(t);
  const call = appManager.autoShareAlwaysOn();
  await hold.parked;
  await appManager.share('code-conductor', { mode: 'lan', tls: false });
  const manual = (await getApp('code-conductor')).tunnel;
  hold.release();
  assert.equal(await call, false);
  await appManager.awaitSettled('code-conductor');
  const app = await getApp('code-conductor');
  assert.equal(app.tunnel?.proxyPort, manual.proxyPort);
  assert.equal(app.tunnel?.auth, true); // the manual share's options, not the ticked config's
  assert.equal(app.autoShareStatus, null);
  assert.equal(hold.listening().length, 1);
});

// Invariant: an unreadable settings file at boot is reported on the
// conductor's card as an auto-share failure — never swallowed into a silent,
// unshared boot — the same as a start() of a normal app.
test('embedded: an unreadable app-settings.json at boot shows an always-on auto-share failure', async (t) => {
  await embeddedConductor(t);
  const real = console.error;
  console.error = () => {};
  t.after(() => { console.error = real; });
  await appManager.init();
  const file = appSettings.appSettingsFile();
  await fs.mkdir(file, { recursive: true }); // a directory where the file belongs: EISDIR, even as root
  t.after(() => fs.rm(file, { recursive: true, force: true }));
  assert.equal(await appManager.autoShareAlwaysOn(), true);
  assert.deepEqual(await appManager.awaitSettled('code-conductor'), { id: 'code-conductor', settled: true });
  await fs.rm(file, { recursive: true }); // the listing reads the file too
  const app = await getApp('code-conductor');
  assert.equal(app.tunnel, null);
  assert.equal(app.autoShareStatus, 'failed');
  assert.match(app.autoShareError, /EISDIR|directory/);
  // autoRun's outcome outlives a re-run init(); a successful share clears it.
  await appManager.share('code-conductor', { mode: 'lan', tls: false });
});

// Invariant: embedded with no synthesized conductor record (an unparseable
// CONDUCTOR_URL), autoShareAlwaysOn() begins nothing and doesn't throw.
test('embedded with no conductor record: autoShareAlwaysOn() returns false', async (t) => {
  await embeddedConductor(t);
  process.env.CONDUCTOR_URL = 'not a url';
  await appSettings.update('code-conductor', { autoShare: LAN_PLAIN });
  await appManager.init();
  assert.equal(await appManager.autoShareAlwaysOn(), false);
  assert.deepEqual(await appManager.awaitSettled('code-conductor'), { id: 'code-conductor', settled: true });
});

// Invariant: an unticked always-on conductor is left unshared, and no
// transition is left for a settle wait to follow.
test('embedded: an unticked always-on conductor is left unshared with nothing pending', async (t) => {
  await embeddedConductor(t);
  await appManager.init();
  assert.equal(await appManager.autoShareAlwaysOn(), false);
  assert.deepEqual(await appManager.awaitSettled('code-conductor'), { id: 'code-conductor', settled: true });
  const app = await getApp('code-conductor');
  assert.equal(app.tunnel, null);
  assert.equal(app.autoShareStatus, null);
});

// Invariant: the always-on boot rule never widens to adoption — a normal app
// code-hub adopts at boot stays unshared even while the conductor is
// auto-shared alongside it.
test('embedded: an adopted normal app ticked for auto-share stays unshared while the conductor is auto-shared', async (t) => {
  const { root } = await embeddedConductor(t);
  await mkProject(root, 'web', { start: fakeAppCmd() }, { git: true });
  t.after(() => appManager.stop('web').catch(() => {}));
  await appSettings.update('web', { autoStart: true, autoShare: LAN_PLAIN });
  await appSettings.update('code-conductor', { autoShare: LAN_PLAIN });
  await appManager.init();
  await appManager.start('web');
  await appManager.awaitSettled('web');
  assert.equal((await getApp('web')).tunnel?.kind, 'lan'); // shared before the "restart"

  await appManager.init(); // web's live pid is adopted
  await appManager.autoShareAlwaysOn();
  await appManager.autoStartAll();
  await appManager.awaitSettled('code-conductor');
  await appManager.awaitSettled('web');
  const web = await getApp('web');
  assert.ok(['ready', 'running'].includes(web.status));
  assert.equal(web.tunnel, null);
  assert.equal(web.autoShareStatus, null);
  assert.equal((await getApp('code-conductor')).tunnel?.kind, 'lan');
});

// Invariant: server.js's start() runs the always-on auto-share once it is
// listening, in the background.
test('embedded: server start() auto-shares the always-on conductor in the background', async (t) => {
  await embeddedConductor(t);
  await appSettings.update('code-conductor', { autoShare: LAN_PLAIN });
  const server = await startServer({ port: 0 });
  t.after(() => new Promise((r) => server.close(r)));
  await waitFor(async () => (await getApp('code-conductor')).tunnel?.kind === 'lan');
  await appManager.awaitSettled('code-conductor');
  assert.equal((await getApp('code-conductor')).autoShareStatus, null);
});

// Invariant: the boot auto-share keys on the always-on classification, not the
// id — standalone, an adopted project named code-conductor is not auto-shared.
test('standalone: a project named code-conductor gets no boot auto-share', async (t) => {
  delete process.env.CONDUCTOR_PLUGIN_ID;
  delete process.env.CONDUCTOR_URL;
  process.env.CODEHUB_TAILSCALE_BIN = fakeTailscaleBin;
  const root = await mkRoot();
  await mkProject(root, 'code-conductor', { start: fakeAppCmd() }, { git: true });
  t.after(async () => { await appManager.stop('code-conductor').catch(() => {}); await rmRoot(root); });
  await appSettings.update('code-conductor', { autoShare: LAN_PLAIN });
  await appManager.init();
  await appManager.start('code-conductor');
  await appManager.awaitSettled('code-conductor');
  await appManager.unshare('code-conductor');
  await appManager.init(); // adopted
  assert.equal(await appManager.autoShareAlwaysOn(), false);
  await appManager.awaitSettled('code-conductor');
  const app = await getApp('code-conductor');
  assert.equal(app.alwaysOn, false);
  assert.equal(app.tunnel, null);
});
