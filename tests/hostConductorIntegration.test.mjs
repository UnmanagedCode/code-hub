import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer } from '../server.js';
import * as appManager from '../src/appManager.js';
import { unregisterInMemory } from '../src/projects.js';
import * as conductorProjects from '../src/conductorProjects.js';
import { mkRoot, rmRoot, mkProject, mkWorktree, gitCommit, waitFor, fakeAppCmd, fakeCloudflaredBin, fakeTailscaleBin, ccProject } from './helpers.mjs';

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
