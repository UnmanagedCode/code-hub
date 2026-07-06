import { discoverApps } from './projects.js';
import * as state from './state.js';
import * as runner from './runner.js';
import * as tunnel from './tunnel.js';
import { allocatePort, enumerateUrls, routeUrls } from './net.js';
import { qrSvg } from './qr.js';
import { headSha, currentBranch, lastCommitAt } from './git.js';

// In-memory mirror of the persisted state, loaded once at init and kept in
// sync on every mutation. This module is the single source of truth for
// "what is running"; routes.js is a thin layer over it.
let store = { apps: {} };

export async function init() {
  store = await state.load();
  await state.reconcile(store); // drop dead pids / tunnels; adopt live ones
}

async function persist() {
  await state.save(store);
}

// Merge discoverable apps (main checkouts + worktrees with a `.hub.json`)
// with running records. A running app whose source dir has since been removed
// still appears, flagged sourceMissing, so it can be stopped.
export async function list() {
  const discovered = await discoverApps();
  const byId = new Map(discovered.map((a) => [a.id, a]));
  const entries = [];
  let mutated = false;

  const build = async (base, rec) => {
    const sourceMissing = !byId.has(base.id);
    let status = 'stopped';
    let error = base.manifestError ?? null;
    let port, urls, startedSha, tunnelInfo = null;

    if (rec) {
      port = rec.port; urls = rec.urls; startedSha = rec.startedSha;
      tunnelInfo = rec.tunnel ? { url: rec.tunnel.url } : null;
      const rt = runner.runtime(base.id);
      if (rt && (rt.status === 'crashed' || rt.status === 'exited')) {
        status = 'crashed'; error = rt.error;
      } else if (state.pidAlive(rec.pid)) {
        status = rt ? rt.status : 'running'; // no runtime ⇒ adopted after restart
      } else {
        // Died without our runtime noticing (e.g. after a code-hub restart).
        delete store.apps[base.id]; mutated = true;
        status = 'stopped'; port = urls = startedSha = undefined; tunnelInfo = null;
      }
    }

    const currentSha = sourceMissing ? null : await headSha(base.path);
    const branch = base.isWorktree ? (sourceMissing ? (rec?.branch ?? null) : await currentBranch(base.path)) : null;
    const commitAt = sourceMissing ? null : await lastCommitAt(base.path);

    // Named routes from the manifest, else a single implicit route at `/`
    // (backward compatible). URLs are enumerated live from the running port.
    const routeDefs = base.manifest?.routes ?? [{ name: base.manifest?.name ?? base.id, path: '/' }];
    const routes = routeDefs.map((r) => ({
      name: r.name, path: r.path,
      urls: port ? routeUrls(port, r.path) : [],
    }));

    return {
      id: base.id,
      project: base.project,
      name: base.manifest?.name ?? base.id,
      path: base.path,
      isWorktree: base.isWorktree,
      branch,
      status,
      port, urls, startedSha,
      currentSha,
      lastCommitAt: commitAt,
      outOfDate: !!(startedSha && currentSha && startedSha !== currentSha),
      sourceMissing,
      routes,
      tunnel: tunnelInfo,
      error,
    };
  };

  for (const app of discovered) entries.push(await build(app, store.apps[app.id]));
  for (const [id, rec] of Object.entries(store.apps)) {
    if (byId.has(id)) continue; // already built above
    entries.push(await build({ ...rec, manifest: null, manifestError: null }, rec));
  }
  if (mutated) await persist();

  entries.sort((a, b) => a.id.localeCompare(b.id));
  return { cloudflaredAvailable: await tunnel.available(), apps: entries };
}

async function findDiscovered(id) {
  const app = (await discoverApps()).find((a) => a.id === id);
  if (!app) { const e = new Error(`unknown app '${id}'`); e.statusCode = 404; throw e; }
  if (!app.manifest) { const e = new Error(app.manifestError || 'no valid .hub.json'); e.statusCode = 400; throw e; }
  return app;
}

export async function start(id) {
  const existing = store.apps[id];
  if (existing && state.pidAlive(existing.pid)) {
    const e = new Error(`'${id}' is already running`); e.statusCode = 409; throw e;
  }
  const app = await findDiscovered(id);
  const port = await allocatePort();
  const proc = runner.start(app, port);
  store.apps[id] = {
    id, project: app.project, path: app.path,
    isWorktree: app.isWorktree, branch: app.isWorktree ? await currentBranch(app.path) : null,
    pid: proc.pid, pgid: proc.pgid, port,
    urls: enumerateUrls(port),
    startedSha: await headSha(app.path),
    startedAt: proc.startedAt,
    tunnel: null,
  };
  await persist();
  return store.apps[id];
}

export async function stop(id) {
  const rec = store.apps[id];
  if (!rec) { const e = new Error(`'${id}' is not running`); e.statusCode = 404; throw e; }
  if (rec.tunnel) tunnel.stopTunnel(rec.tunnel.pid);
  runner.stop({ id, pgid: rec.pgid });
  delete store.apps[id];
  await persist();
  return { id, status: 'stopped' };
}

export async function restart(id) {
  if (store.apps[id]) await stop(id);
  return start(id);
}

export async function share(id) {
  const rec = store.apps[id];
  if (!rec || !state.pidAlive(rec.pid)) { const e = new Error(`'${id}' is not running`); e.statusCode = 409; throw e; }
  if (!(await tunnel.available())) {
    const e = new Error('cloudflared is not installed — install it to share via a public URL');
    e.statusCode = 501; throw e;
  }
  if (rec.tunnel) tunnel.stopTunnel(rec.tunnel.pid); // replace a stale tunnel
  const { url, pid } = await tunnel.startTunnel(rec.port);
  rec.tunnel = { url, pid };
  await persist();
  return { url, qrSvg: await qrSvg(url) };
}

export async function unshare(id) {
  const rec = store.apps[id];
  if (rec?.tunnel) { tunnel.stopTunnel(rec.tunnel.pid); rec.tunnel = null; await persist(); }
  return { id, tunnel: null };
}
