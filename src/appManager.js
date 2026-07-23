import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  discoverApps, projectsRoot, MANIFEST_FILENAME,
  validateManifestObject, readRegistry, writeRegistry, registerInMemory,
} from './projects.js';
import * as state from './state.js';
import * as runner from './runner.js';
import * as tunnel from './tunnel.js';
import { allocatePort, enumerateUrls, routeUrls, localIPv4s } from './net.js';
import { qrSvg } from './qr.js';
import { headSha, currentBranch, lastCommitAt } from './git.js';
import { startAuthProxy } from './authproxy.js';
import { generateSelfSigned } from './selfsigned.js';
import { isEmbedded, isHostConductorId, hostConductorPort, hostConductorDir, HOST_CONDUCTOR_ID } from './hostConductor.js';

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
    const port = hostConductorPort();
    const injectedDir = hostConductorDir();
    let appPath = null;
    if (injectedDir) {
      // Modern conductor: it injected its own checkout dir, which may live
      // OUTSIDE the scanned projects root. Use it directly — no under-root
      // discovery and no in-memory registration (a dir absent from the root
      // would only make discoverApps() warn about an orphaned key). list()'s
      // second loop surfaces this store.apps record even though discoverApps()
      // never returns it.
      appPath = injectedDir;
    } else {
      // Older conductor (no CONDUCTOR_PROJECT_DIR): fall back to discovering a
      // `code-conductor/` dir under the root. The conductor carries no
      // `.hub.json` of its own, so register it in-memory (never persisted)
      // before discovering — this is what makes discoverApps() find it at all.
      registerInMemory(HOST_CONDUCTOR_ID, { start: 'npm start', name: 'code-conductor', healthPath: '/' });
      const discovered = await discoverApps();
      const app = discovered.find((a) => a.id === HOST_CONDUCTOR_ID && !a.isWorktree);
      appPath = app ? app.path : null;
    }
    if (appPath && port) {
      store.apps[HOST_CONDUCTOR_ID] = {
        id: HOST_CONDUCTOR_ID, project: HOST_CONDUCTOR_ID, path: appPath,
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
    // The always-on host conductor may live at an injected dir OUTSIDE the
    // scanned projects root, so discoverApps() never returns it (byId misses
    // it) even though its checkout is present. Don't flag it sourceMissing —
    // the git-info lines below then read from base.path (the injected dir) as
    // usual. Under-root (discovered) and standalone cases are unaffected.
    const sourceMissing = !byId.has(base.id) && !isHostConductorId(base.id);
    let status = 'stopped';
    const manifestError = base.manifestError ?? null;
    let error = manifestError;
    let port, urls, startedSha, tunnelInfo = null;

    if (rec) {
      port = rec.port; urls = rec.urls; startedSha = rec.startedSha;
      // username/password come from the live proxy (proxies map), never
      // from rec.tunnel — that's how the password persists across a page
      // reload (in-memory, for the share's lifetime) without ever touching
      // state.json. rec.tunnel itself holds only non-secret fields.
      if (rec.tunnel) {
        const proxy = proxies.get(base.id);
        tunnelInfo = {
          url: rec.tunnel.url, kind: rec.tunnel.kind, urls: rec.tunnel.urls ?? null,
          proxyPort: rec.tunnel.proxyPort ?? null,
          auth: rec.tunnel.auth !== false,
          tls: rec.tunnel.tls === true,
          username: proxy ? proxy.username : null,
          password: proxy ? proxy.password : null,
        };
      } else {
        tunnelInfo = null;
      }
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
      manifestError,
      alwaysOn: isHostConductorId(base.id) && !!rec,
      source: base.source,
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
//   so the public *.trycloudflare.com URL goes through it. Always gated.
// - 'lan': the auth proxy itself binds 0.0.0.0 instead of loopback, so other
//   devices on the local network can reach it directly — no cloudflared.
//   `auth: false` (LAN only) drops the gate entirely: no token/cookie/Basic,
//   the proxy forwards every request/upgrade unconditionally and the share
//   URL is the plain proxy URL. `tls` (LAN only, default on — see
//   lanTlsDefault) wraps the proxy in HTTPS with a per-share self-signed cert
//   so the LAN hop is encrypted; set it false for plain HTTP.
// For a gated share, a fresh token + password are generated per share, kept
// in memory only (see the `proxies` map). The QR/authUrl carries the token
// (opening it exchanges the token for an httpOnly session cookie server-side
// — no credentials ever appear in the URL); username/password remain
// available as a Basic-Auth fallback for curl/API clients, and persist
// (in-memory) for the lifetime of the share — see `list()`.
export async function share(id, { mode = 'tunnel', auth = true, tls } = {}) {
  if (mode !== 'tunnel' && mode !== 'lan') {
    const e = new Error(`invalid share mode '${mode}' — must be 'tunnel' or 'lan'`); e.statusCode = 400; throw e;
  }
  if (typeof auth !== 'boolean') { const e = new Error("'auth' must be a boolean"); e.statusCode = 400; throw e; }
  if (mode === 'tunnel' && auth === false) {
    const e = new Error('authentication cannot be disabled for tunnel shares'); e.statusCode = 400; throw e;
  }
  if (tls !== undefined && typeof tls !== 'boolean') { const e = new Error("'tls' must be a boolean"); e.statusCode = 400; throw e; }
  const rec = store.apps[id];
  const alwaysOn = isHostConductorId(id);
  if (!rec || (!alwaysOn && !state.pidAlive(rec.pid))) { const e = new Error(`'${id}' is not running`); e.statusCode = 409; throw e; }

  if (mode === 'lan') {
    teardownShare(id, rec); // replace any existing share
    const useTls = tls ?? true; // TLS on by default; the UI/API `tls` flag overrides
    // Self-signed cert covering the LAN IPs + loopback, generated per share and
    // held in memory only (via the proxy) — nothing on disk. Browsers show a
    // one-time "not private" warning (self-signed); documented as a limitation.
    let tlsOpt = null;
    if (useTls) {
      const ips = localIPv4s({ lanFallback: true });
      const { key, cert } = generateSelfSigned({ ipAddresses: [...ips, '127.0.0.1'], dnsNames: ['localhost'] });
      tlsOpt = { key, cert };
    }
    const proxy = await startAuthProxy(rec.port, { host: '0.0.0.0', auth, tls: tlsOpt });
    proxies.set(id, proxy);
    const scheme = useTls ? 'https' : 'http';
    // Drop the loopback entry — it's not reachable from another device.
    const loopbackPrefix = `${scheme}://localhost:`;
    const urls = enumerateUrls(proxy.port, { lanFallback: true, scheme }).filter((u) => !u.startsWith(loopbackPrefix));
    const url = urls[0] ?? `${scheme}://localhost:${proxy.port}`; // no LAN interface found
    rec.tunnel = { kind: 'lan', url, urls, pid: null, proxyPort: proxy.port, auth, tls: useTls };
    await persist();
    if (!auth) {
      // Nothing to authenticate — but a QR of the plain URL is still a
      // handy scan-to-open shortcut.
      return { kind: 'lan', url, urls, auth: false, tls: useTls, qrSvg: await qrSvg(url) };
    }
    const authUrl = withToken(url, proxy.token);
    return { kind: 'lan', url, urls, auth: true, tls: useTls, authUrl, username: proxy.username, password: proxy.password, qrSvg: await qrSvg(authUrl) };
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
  rec.tunnel = { kind: 'tunnel', url, pid, proxyPort: proxy.port, auth: true };
  await persist();

  const authUrl = withToken(url, proxy.token);
  return { kind: 'tunnel', url, auth: true, authUrl, username: proxy.username, password: proxy.password, qrSvg: await qrSvg(authUrl) };
}

// Edit the active share's Basic-Auth credentials in place — mutates the live
// proxy (see authproxy.js's setCredentials), so the share URL/token/proxy
// port never change. Custom creds are per-share-instance only: share()
// always tears down and recreates the proxy, so the next share starts fresh
// with an auto-generated password again.
export async function updateShareCredentials(id, { username, password } = {}) {
  const proxy = proxies.get(id);
  if (!proxy) { const e = new Error(`'${id}' has no active share`); e.statusCode = 409; throw e; }
  if (!proxy.auth) {
    const e = new Error(`share for '${id}' has authentication disabled — nothing to edit`); e.statusCode = 400; throw e;
  }
  const hasUsername = username !== undefined;
  const hasPassword = password !== undefined;
  if (!hasUsername && !hasPassword) { const e = new Error('provide username and/or password to update'); e.statusCode = 400; throw e; }
  if (hasUsername && (typeof username !== 'string' || !username.trim())) {
    const e = new Error('username must be a non-empty string'); e.statusCode = 400; throw e;
  }
  if (hasPassword && (typeof password !== 'string' || !password.trim())) {
    const e = new Error('password must be a non-empty string'); e.statusCode = 400; throw e;
  }
  proxy.setCredentials({
    username: hasUsername ? username.trim() : undefined,
    password: hasPassword ? password.trim() : undefined,
  });
  return { id, username: proxy.username, password: proxy.password };
}

// Flip a live LAN share's auth gate in place — mutates the proxy (see
// authproxy.js's setAuth), so the share URL/token/proxy port never change.
// Tunnel shares are always gated and reject this (mirrors the mode==='tunnel'
// guard in share()); a token/authUrl handed out earlier stays valid either
// way since the proxy never regenerates them on a toggle.
export async function setShareAuth(id, enabled) {
  if (typeof enabled !== 'boolean') { const e = new Error("'enabled' must be a boolean"); e.statusCode = 400; throw e; }
  const rec = store.apps[id];
  const proxy = proxies.get(id);
  if (!rec?.tunnel || !proxy) { const e = new Error(`'${id}' has no active share`); e.statusCode = 409; throw e; }
  if (rec.tunnel.kind !== 'lan') {
    const e = new Error('authentication cannot be toggled for tunnel shares — tunnel shares are always gated'); e.statusCode = 400; throw e;
  }
  proxy.setAuth(enabled);
  rec.tunnel.auth = enabled;
  await persist();
  return { id, auth: enabled };
}

export async function unshare(id) {
  const rec = store.apps[id];
  if (rec?.tunnel || proxies.has(id)) { teardownShare(id, rec); await persist(); }
  return { id, tunnel: null };
}

async function hasManifestFile(dir) {
  try {
    await fs.access(path.join(dir, MANIFEST_FILENAME));
    return true;
  } catch {
    return false;
  }
}

// Register a sibling dir that has no `.hub.json` of its own as a startable
// app, by writing an entry into registrations.json (see projects.js). A dir
// that already has a `.hub.json` — even a broken one — needs no registration
// and is rejected outright; it always wins over any registry entry.
export async function registerApp({ id, start, name, healthPath, readyWhen, routes } = {}) {
  if (typeof id !== 'string' || id.length === 0 || id.startsWith('.') || path.basename(id) !== id) {
    const e = new Error('id is required and must be a plain, non-dot-prefixed directory basename (no path separators)'); e.statusCode = 400; throw e;
  }
  const dir = path.join(projectsRoot(), id);
  let stat;
  try {
    stat = await fs.stat(dir);
  } catch {
    stat = null;
  }
  if (!stat || !stat.isDirectory()) {
    const e = new Error(`'${id}' is not an existing directory under the projects root`); e.statusCode = 400; throw e;
  }
  if (await hasManifestFile(dir)) {
    const e = new Error(`'${id}' already has a .hub.json — no registration needed`); e.statusCode = 409; throw e;
  }
  const manifest = validateManifestObject({ start, name, healthPath, readyWhen, routes }, `register_app:${id}`);
  const registry = await readRegistry();
  registry[id] = manifest;
  await writeRegistry(registry);
  return (await discoverApps()).find((a) => a.id === id);
}

export async function unregisterApp(id) {
  const registry = await readRegistry();
  if (!(id in registry)) { const e = new Error(`'${id}' is not registered`); e.statusCode = 404; throw e; }
  delete registry[id];
  await writeRegistry(registry);
  return { id, registered: false };
}
