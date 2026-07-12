import { discoverApps } from './projects.js';
import * as state from './state.js';
import * as runner from './runner.js';
import * as tunnel from './tunnel.js';
import { allocatePort, enumerateUrls, routeUrls } from './net.js';
import { qrSvg } from './qr.js';
import { headSha, currentBranch, lastCommitAt } from './git.js';
import { startAuthProxy } from './authproxy.js';
import { isEmbedded, isHostConductorId, hostConductorPort, HOST_CONDUCTOR_ID } from './hostConductor.js';

// In-memory mirror of the persisted state, loaded once at init and kept in
// sync on every mutation. This module is the single source of truth for
// "what is running"; routes.js is a thin layer over it.
let store = { apps: {} };

// Live auth-proxy handles, keyed by app id. In-memory only: the password and
// the proxy server never survive a code-hub restart (see init teardown).
const proxies = new Map();

export async function init() {
  store = await state.load();
  await state.reconcile(store); // drop dead pids / tunnels; adopt live ones
  // A persisted tunnel from before a restart points at an auth proxy that no
  // longer exists (in-process, gone with the old code-hub). Tear the orphaned
  // cloudflared tunnel down so it can't serve a broken URL — the share simply
  // needs re-creating (the UI's Share button reappears).
  let mutated = false;
  for (const rec of Object.values(store.apps)) {
    if (rec.tunnel) { tunnel.stopTunnel(rec.tunnel.pid); rec.tunnel = null; mutated = true; }
  }
  // Embedded as a code-conductor plugin: the host conductor is already
  // running (started by something else), so synthesize a record for it with
  // no pid/pgid to track — list()/start()/stop()/share() special-case this
  // id to treat it as always-on instead of an ordinary app. It has no real
  // pid, so state.reconcile() prunes it again on the next boot; we simply
  // re-synthesize it here every time, same as any other share not
  // surviving a restart.
  if (isEmbedded()) {
    const discovered = await discoverApps();
    const app = discovered.find((a) => a.id === HOST_CONDUCTOR_ID && !a.isWorktree);
    const port = hostConductorPort();
    if (app && port) {
      store.apps[HOST_CONDUCTOR_ID] = {
        id: HOST_CONDUCTOR_ID, project: app.project, path: app.path,
        isWorktree: false, branch: null,
        pid: null, pgid: null, port,
        urls: enumerateUrls(port),
        startedSha: null, startedAt: null, tunnel: null,
      };
      mutated = true;
    }
  }
  if (mutated) await persist();
}

// Tear down a share: close the auth proxy (if any) and kill the cloudflared
// tunnel. Leaves rec.tunnel null. Safe to call when nothing is shared.
function teardownShare(id, rec) {
  const proxy = proxies.get(id);
  if (proxy) { proxy.close(); proxies.delete(id); }
  if (rec?.tunnel) tunnel.stopTunnel(rec.tunnel.pid);
  if (rec) rec.tunnel = null;
}

async function persist() {
  await state.save(store);
}

// Append the share token as a query param so opening/scanning the link
// exchanges it for an httpOnly cookie server-side (see authproxy.js) — no
// credentials ever appear in the URL or QR. Handles a URL that may already
// carry a query string.
function withToken(url, token) {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}__hubauth=${encodeURIComponent(token)}`;
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
      tunnelInfo = rec.tunnel ? { url: rec.tunnel.url, kind: rec.tunnel.kind, urls: rec.tunnel.urls ?? null, username: rec.tunnel.username ?? null, proxyPort: rec.tunnel.proxyPort ?? null } : null;
      if (isHostConductorId(base.id)) {
        status = 'running'; // host code-conductor: always on, no pid/runtime to track
      } else {
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
      alwaysOn: isHostConductorId(base.id) && !!rec,
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
  if (isHostConductorId(id)) {
    const e = new Error(`'${id}' is the host code-conductor and cannot be started`); e.statusCode = 409; throw e;
  }
  const existing = store.apps[id];
  if (existing && state.pidAlive(existing.pid)) {
    const e = new Error(`'${id}' is already running`); e.statusCode = 409; throw e;
  }
  const app = await findDiscovered(id);
  let port = await allocatePort();
  const proc = await runner.start(app, port);
  port = proc.port; // runner.start() may have retried onto a different port
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
  if (isHostConductorId(id)) {
    const e = new Error(`'${id}' is managed by the host code-conductor and cannot be stopped`); e.statusCode = 409; throw e;
  }
  const rec = store.apps[id];
  if (!rec) { const e = new Error(`'${id}' is not running`); e.statusCode = 404; throw e; }
  teardownShare(id, rec);
  runner.stop({ id, pgid: rec.pgid });
  delete store.apps[id];
  await persist();
  return { id, status: 'stopped' };
}

export async function restart(id) {
  if (store.apps[id]) await stop(id);
  return start(id);
}

// Share a running app behind a local auth proxy. Two modes:
// - 'tunnel' (default): cloudflared points at the auth proxy (not the app),
//   so the public *.trycloudflare.com URL goes through it.
// - 'lan': the auth proxy itself binds 0.0.0.0 instead of loopback, so other
//   devices on the local network can reach it directly — no cloudflared.
// Either way, a fresh token + password are generated per share, kept in
// memory only. The QR/authUrl carries the token (opening it exchanges the
// token for an httpOnly session cookie server-side — no credentials ever
// appear in the URL); username/password remain available as a Basic-Auth
// fallback for curl/API clients and are shown once as plaintext.
export async function share(id, { mode = 'tunnel' } = {}) {
  if (mode !== 'tunnel' && mode !== 'lan') {
    const e = new Error(`invalid share mode '${mode}' — must be 'tunnel' or 'lan'`); e.statusCode = 400; throw e;
  }
  const rec = store.apps[id];
  const alwaysOn = isHostConductorId(id);
  if (!rec || (!alwaysOn && !state.pidAlive(rec.pid))) { const e = new Error(`'${id}' is not running`); e.statusCode = 409; throw e; }

  if (mode === 'lan') {
    teardownShare(id, rec); // replace any existing share
    const proxy = await startAuthProxy(rec.port, { host: '0.0.0.0' });
    proxies.set(id, proxy);
    // Drop the loopback entry — it's not reachable from another device.
    const urls = enumerateUrls(proxy.port).filter((u) => !u.startsWith('http://localhost:'));
    const url = urls[0] ?? `http://localhost:${proxy.port}`; // no LAN interface found
    rec.tunnel = { kind: 'lan', url, urls, pid: null, username: proxy.username, proxyPort: proxy.port };
    await persist();
    const authUrl = withToken(url, proxy.token);
    return { kind: 'lan', url, urls, authUrl, username: proxy.username, password: proxy.password, qrSvg: await qrSvg(authUrl) };
  }

  if (!(await tunnel.available())) {
    const e = new Error('cloudflared is not installed — install it to share via a public URL');
    e.statusCode = 501; throw e;
  }
  teardownShare(id, rec); // replace any existing share

  const proxy = await startAuthProxy(rec.port);
  let url, pid;
  try {
    ({ url, pid } = await tunnel.startTunnel(proxy.port));
  } catch (e) {
    proxy.close(); // don't leak the proxy if the tunnel failed to come up
    throw e;
  }
  proxies.set(id, proxy);
  rec.tunnel = { kind: 'tunnel', url, pid, username: proxy.username, proxyPort: proxy.port };
  await persist();

  const authUrl = withToken(url, proxy.token);
  return { kind: 'tunnel', url, authUrl, username: proxy.username, password: proxy.password, qrSvg: await qrSvg(authUrl) };
}

export async function unshare(id) {
  const rec = store.apps[id];
  if (rec?.tunnel || proxies.has(id)) { teardownShare(id, rec); await persist(); }
  return { id, tunnel: null };
}
