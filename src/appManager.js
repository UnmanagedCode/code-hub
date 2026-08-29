import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  discoverApps, projectsRoot, MANIFEST_FILENAME,
  validateManifestObject, readRegistry, writeRegistry, registerInMemory,
} from './projects.js';
import * as state from './state.js';
import * as runner from './runner.js';
import * as tunnel from './tunnel.js';
import * as tailscale from './tailscale.js';
import { allocatePort, isPortFree, probeWildcardHold, enumerateUrls, routeUrls, localIPv4s } from './net.js';
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

// True when `dir` is `root` itself or a descendant of it. Used to decide
// whether the injected host-conductor dir is reachable by discoverApps()'s
// root scan at all — an out-of-root checkout (and therefore any worktree of
// it, which is always a sibling of the checkout) never is.
function isUnderRoot(root, dir) {
  const rel = path.relative(root, dir);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export async function init() {
  store = await state.load();
  // reconcile drops records whose app pid is dead — which, for an app that
  // died in the same window code-hub did, would delete the only record of a
  // still-running share child. It hands those back instead of stranding them
  // (see state.reconcile) and they are killed here, BEFORE the sweep below,
  // because their records no longer exist to be swept.
  const { strandedTunnels } = await state.reconcile(store);
  for (const { id, tunnel: t } of strandedTunnels) killShareChild(id, t, { verify: true });
  // A persisted share from before a restart points at an auth proxy that no
  // longer exists (in-process, gone with the old code-hub). Tear the orphaned
  // child down so it can't serve a broken URL — the share simply needs
  // re-creating (the UI's Share button reappears). Routed through
  // teardownShare so the per-kind kill lives in one place; at init the
  // proxies/qrCache maps are empty, so it does exactly the same thing.
  let mutated = false;
  for (const [id, rec] of Object.entries(store.apps)) {
    // `verify`: these pids come off disk, so they may have been recycled since
    // the process that wrote them died — every other teardown site signals a
    // child this process spawned and needs no check.
    if (rec.tunnel) { teardownShare(id, rec, { verify: true }); mutated = true; }
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
      // discovery needed. list()'s second loop surfaces this store.apps
      // record even though discoverApps() never returns it.
      appPath = injectedDir;
      // Only register in-memory when that dir is actually reachable by
      // discoverApps()'s root scan. Worktrees are always created as siblings
      // of the checkout they branch from, so an out-of-root checkout can
      // never have an in-root worktree either — registering here would do
      // nothing useful, and would either shadow the injected dir with a
      // same-named but unrelated sibling under root (wrong path/git info) or,
      // with no such sibling, make discoverApps() warn about an orphaned key
      // on every call.
      if (isUnderRoot(projectsRoot(), injectedDir)) {
        registerInMemory(HOST_CONDUCTOR_ID, { start: 'npm start', name: 'code-conductor', healthPath: '/' });
      }
    } else {
      // Older conductor (no CONDUCTOR_PROJECT_DIR): fall back to discovering a
      // `code-conductor/` dir under the root. The conductor carries no
      // `.hub.json` of its own, so register it in-memory (never persisted)
      // before discovering — this is what makes discoverApps() find it at
      // all, and lets a code-conductor_worktree_* dir with no manifest of its
      // own inherit one via projects.js's worktree-parent-fallback.
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

// THE authority for "which app holds the node's Tailscale Funnel". Funnel
// occupies port 443 machine-wide, so exactly one can exist, and every 409 is
// derived from this — nothing scans the app records for a holder. Two sources
// of truth is precisely what went wrong before: any site that dropped a record
// without telling the slot left it naming a share that no longer existed,
// wedging the feature until a restart.
//
//   { id, pid, pending }
//     pending — the share is still coming up: no pid yet, no record yet.
//               share() claims this SYNCHRONOUSLY before its first await,
//               because rec.tunnel isn't written until the funnel is up (up to
//               the full readiness backstop), so two concurrent requests would
//               otherwise both pass any records-based check. A pending slot
//               blocks its OWN app too — a second concurrent share of A would
//               orphan the first one's proxy and funnel child.
//     pid     — the funnel child this slot names, once it is up.
//
// Released precisely when the child it NAMES is killed (see killShareChild),
// never on an id match: share() claims the slot and then tears down that same
// app's previous funnel, so an id-keyed release would drop the claim it just
// made. Keying on pid makes teardownShare the single release point, which is
// what lets "route every record-dropping site through teardownShare" close the
// whole class rather than three instances of it.
let funnelSlot = null;

// pid of the most recently SIGTERMed tailscale funnel, while it may still be
// exiting. The CLI reverts the node's WHOLE serve config when it exits, not
// just its own registration, so a funnel spawned while an older one is still
// shutting down can have its URL torn out from under it moments later. The
// next tailscale share waits this out (see share()). Covers both re-sharing
// one app and unsharing A then sharing B.
let expiringFunnelPid = null;

// SIGTERM the child publishing a share, dispatching on its kind. Split out of
// teardownShare so init() can also kill a child whose record reconcile already
// dropped — at that point there is no record left to tear down, only a pid.
//
// `verify` guards the ONLY case where the pid did not come from a child we
// spawned in this process: pids read back from state.json can have been
// recycled across a reboot, and signalling a recycled pid would SIGTERM (and,
// on an unresponsive one, SIGKILL) an unrelated process group on the user's
// machine. See tailscale.looksLikeFunnel.
function killShareChild(id, t, { verify = false } = {}) {
  if (!t) return;
  if (t.kind === 'tailscale') {
    if (verify && !tailscale.looksLikeFunnel(t.pid)) {
      console.error(`[appManager] ${id}: persisted funnel pid ${t.pid} is not a tailscale funnel (recycled?) — not signalling it`);
    } else {
      tailscale.stopFunnel(t.pid);
      if (t.pid) expiringFunnelPid = t.pid;
    }
    if (funnelSlot && !funnelSlot.pending && funnelSlot.pid === t.pid) funnelSlot = null;
  } else {
    tunnel.stopTunnel(t.pid);
  }
}

// Tear down a share: close the auth proxy (if any) and kill the child that
// publishes it. Leaves rec.tunnel null. Safe to call when nothing is shared.
// A tailscale funnel runs in the foreground, so SIGTERM is the whole teardown
// — the CLI removes its own funnel config on exit (see src/tailscale.js).
//
// EVERY site that drops or replaces a record carrying a share must come
// through here — init's sweep, list()'s prune and reap, stop(), start()'s
// replacement of a dead app's record, unshare(). That is the single-authority
// rule that keeps funnelSlot from ever naming a share that no longer exists.
//
// Synchronous, so the in-memory maps are consistent the instant it returns.
// The SIGTERM it sends is NOT awaited, though, so the killed child may still
// be exiting afterwards — which matters only for tailscale, where a lingering
// exit would revert the node's serve config: `expiringFunnelPid` records it
// and the next tailscale share waits for it.
function teardownShare(id, rec, opts) {
  const proxy = proxies.get(id);
  if (proxy) { proxy.close(); proxies.delete(id); }
  if (rec?.tunnel) killShareChild(id, rec.tunnel, opts);
  if (rec) rec.tunnel = null;
  qrCache.delete(id);
}

// Free the slot when the funnel it names has died on its own (an OOM kill, a
// stray kill) — refusing every other app on behalf of a funnel that no longer
// exists would wedge the feature until a restart. A pending claim is never
// stale: its share() call is still running.
function reapFunnelSlot() {
  if (!funnelSlot || funnelSlot.pending || state.pidAlive(funnelSlot.pid)) return;
  const rec = store.apps[funnelSlot.id];
  if (rec?.tunnel) teardownShare(funnelSlot.id, rec); // drops the stale URL/creds/QR too
  funnelSlot = null;
}

function tailscaleUnavailable() {
  const e = new Error('tailscale is not available — start tailscaled and log in to share via a Tailscale Funnel URL');
  e.statusCode = 501;
  return e;
}

// Which app blocks a tailscale share of `id`, or null when nothing does.
// Reads funnelSlot ONLY. A slot held by this same app does not block — that is
// a re-share, which replaces it.
function funnelBlockedBy(id) {
  reapFunnelSlot();
  if (!funnelSlot) return null;
  if (funnelSlot.pending) return funnelSlot.id; // blocks everyone, its own app included
  return funnelSlot.id === id ? null : funnelSlot.id;
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

// In-memory QR cache keyed by app id. The QR's only inputs are
// { url, authUrl } (gated → the token URL via `withToken`; ungated/no-auth →
// the plain `url`), so an entry is reused until one of them changes —
// share()/creds-edit/auth-toggle — NOT on every list() poll. Lives in memory
// like the `proxies` map and is cleared in teardownShare. This is what lets
// list() recover the QR after a UI refresh (state.share is gone) without
// re-rendering a QR every few seconds. Used by
// share()/updateShareCredentials()/setShareAuth() AND list(), so the QR served
// to every client and returned by every PATCH comes from one place.
const qrCache = new Map(); // id → { key, svg }

async function cachedQrSvg(id, { url, authUrl }) {
  const key = JSON.stringify({ url, authUrl });
  const hit = qrCache.get(id);
  if (hit && hit.key === key) return hit.svg;
  const svg = await qrSvg(authUrl ?? url);
  qrCache.set(id, { key, svg });
  return svg;
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
      // state.json. rec.tunnel itself holds only non-secret fields. authUrl and
      // qrSvg likewise recover from the live proxy: authUrl is rebuilt from the
      // proxy token, and qrSvg is served from cachedQrSvg (regenerated only on
      // share/creds-edit/auth-toggle, not per poll) — so a full UI refresh (which
      // wipes the client's in-memory state.share) still shows the QR and Open's
      // magic-link. Omitted for a no-auth share (no token path) or a gone proxy.
      // A tailscale funnel that died on its own (OOM kill, a stray kill) leaves
      // a record advertising a public URL that answers nothing — and keeps
      // refusing every other app's tailscale share on behalf of a holder that
      // holds nothing. Reap it on the poll that notices, before anything is
      // built from it. (A LAN share has pid null by design and a cloudflared
      // tunnel is untouched here — only the tailscale slot has a machine-wide
      // consequence worth a per-poll probe.)
      if (rec.tunnel?.kind === 'tailscale' && !state.pidAlive(rec.tunnel.pid)) {
        teardownShare(base.id, rec); mutated = true;
      }
      if (rec.tunnel) {
        const proxy = proxies.get(base.id);
        const url = rec.tunnel.url;
        const auth = rec.tunnel.auth !== false;
        const username = proxy ? proxy.username : null;
        const password = proxy ? proxy.password : null;
        const authUrl = proxy && auth ? withToken(url, proxy.token) : null;
        const svg = proxy ? await cachedQrSvg(base.id, { url, authUrl }) : null;
        tunnelInfo = {
          url, kind: rec.tunnel.kind, urls: rec.tunnel.urls ?? null,
          proxyPort: rec.tunnel.proxyPort ?? null,
          fixedPortFallback: rec.tunnel.fixedPortFallback === true,
          fixedPortHolder: rec.tunnel.fixedPortHolder ?? null,
          auth, tls: rec.tunnel.tls === true,
          username, password,
          ...(authUrl ? { authUrl } : {}),
          ...(svg ? { qrSvg: svg } : {}),
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
          // Tear the share down BEFORE dropping the record: the record holds
          // the only copy of the share child's pid, so deleting it first would
          // strand that child with nothing left able to kill it — a tailscale
          // funnel would keep 443 published in front of a proxy that is about
          // to close, and would block every other app's share forever.
          teardownShare(base.id, rec);
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
  return { cloudflaredAvailable: await tunnel.available(), tailscaleAvailable: await tailscale.available(), apps: entries };
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
  // Past that guard the app's pid is dead, but its SHARE child may not be:
  // the record below is overwritten wholesale with `tunnel: null`, which would
  // drop the only reference to a live funnel — orphaning it on 443 and leaving
  // the slot naming an app with no share, blocking every future tailscale
  // share until a restart. Same single-authority rule as every other site that
  // drops a record: tear the share down first.
  if (existing?.tunnel) teardownShare(id, existing);
  const app = await findDiscovered(id);
  // A manifest `port` pins the app's port for this checkout. projects.js already
  // nulls it for worktrees, so this is only ever set for a default checkout.
  const fixedPort = app.manifest.port ?? null;
  const busy = `port ${fixedPort} is already in use — '${id}' declares a fixed port and will not fall back to a free one`;
  if (fixedPort !== null) {
    const holder = Object.values(store.apps).find((r) => r.port === fixedPort && state.pidAlive(r.pid));
    if (holder) { const e = new Error(`${busy} (held by '${holder.id}')`); e.statusCode = 409; throw e; }
    if (!(await isPortFree(fixedPort))) { const e = new Error(busy); e.statusCode = 409; throw e; }
  }
  let port = fixedPort ?? await allocatePort();
  const proc = await runner.start(app, port, { fixed: fixedPort !== null });
  port = proc.port; // runner.start() may have retried onto a different port (dynamic only)
  if (fixedPort !== null) {
    // Closes the TOCTOU window between the probe above and the child's own
    // bind — and catches a child that failed to bind for a reason isPortFree
    // can't see. This is what makes "a fixed port never silently moves" true
    // rather than merely likely: refuse loudly instead of leaving a dead record.
    const rt = runner.runtime(id);
    if (rt?.status === 'crashed' && /EADDRINUSE/.test(rt.error ?? '')) {
      runner.stop({ id, pgid: proc.pgid });
      const e = new Error(busy); e.statusCode = 409; throw e;
    }
  }
  store.apps[id] = {
    id, project: app.project, path: app.path,
    isWorktree: app.isWorktree, branch: app.isWorktree ? await currentBranch(app.path) : null,
    pid: proc.pid, pgid: proc.pgid, port, fixedPort,
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

// Share a running app behind a local auth proxy. Three modes:
// - 'tunnel' (default): cloudflared points at the auth proxy (not the app),
//   so the public *.trycloudflare.com URL goes through it. Always gated.
// - 'lan': the auth proxy itself binds 0.0.0.0 instead of loopback, so other
//   devices on the local network can reach it directly — no cloudflared.
//   `auth: false` (LAN only) drops the gate entirely: no token/cookie/Basic,
//   the proxy forwards every request/upgrade unconditionally and the share
//   URL is the plain proxy URL. `tls` (LAN only, default on — see
//   lanTlsDefault) wraps the proxy in HTTPS with a per-share self-signed cert
//   so the LAN hop is encrypted; set it false for plain HTTP.
// - 'tailscale': a Tailscale Funnel points at the auth proxy, publishing the
//   node's MagicDNS name (https://<machine>.<tailnet>.ts.net) — public, and
//   unlike cloudflared's random hostname it is stable across restarts. Always
//   gated. Funnel occupies port 443 machine-wide, so only ONE tailscale share
//   can exist at a time (409 naming the holder).
// For a gated share, a fresh token + password are generated per share, kept
// in memory only (see the `proxies` map). The QR/authUrl carries the token
// (opening it exchanges the token for an httpOnly session cookie server-side
// — no credentials ever appear in the URL); username/password remain
// available as a Basic-Auth fallback for curl/API clients, and persist
// (in-memory) for the lifetime of the share — see `list()`.
export async function share(id, { mode = 'tunnel', auth = true, tls } = {}) {
  if (mode !== 'tunnel' && mode !== 'lan' && mode !== 'tailscale') {
    const e = new Error(`invalid share mode '${mode}' — must be 'tunnel', 'lan' or 'tailscale'`); e.statusCode = 400; throw e;
  }
  if (typeof auth !== 'boolean') { const e = new Error("'auth' must be a boolean"); e.statusCode = 400; throw e; }
  if ((mode === 'tunnel' || mode === 'tailscale') && auth === false) {
    const e = new Error(`authentication cannot be disabled for ${mode} shares`); e.statusCode = 400; throw e;
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
    const lanIps = localIPv4s({ lanFallback: true }); // one list for the cert SAN and the bind hosts
    let tlsOpt = null;
    if (useTls) {
      const { key, cert } = generateSelfSigned({ ipAddresses: [...lanIps, '127.0.0.1'], dnsNames: ['localhost'] });
      tlsOpt = { key, cert };
    }
    // Same-port LAN share: measured on Linux, a proxy CAN bind
    // <lanIp>:<fixedPort> while the app holds 127.0.0.1:<fixedPort>, but NOT
    // while the app holds the wildcard (SO_REUSEADDR doesn't permit
    // overlapping listen binds). code-hub injects only PORT and can't know
    // which host the child chose, so attempt the bind and let EADDRINUSE
    // answer — never guess.
    let proxy = null;
    let fixedPortFallback = false;
    let fixedPortHolder = null;
    if (rec.fixedPort && lanIps.length) {
      try {
        proxy = await startAuthProxy(rec.port, { host: lanIps, port: rec.fixedPort, auth, tls: tlsOpt });
      } catch (e) {
        if (e.code !== 'EADDRINUSE') throw e;
        fixedPortFallback = true;
        // EADDRINUSE alone does not say WHO holds the port, and the two possible
        // causes mean opposite things to the user: either the app itself bound
        // every interface (it really is answering on the LAN, ungated), or an
        // unrelated process holds a LAN address at that port (the app is not
        // LAN-reachable at all). Never assert the first without establishing it —
        // telling someone their app is already exposed when it isn't invites
        // them to conclude the gate is pointless.
        //
        // A wildcard hold is STRONGLY indicative of the app's own bind, not
        // proof of it: start() proved this port free on every address before
        // spawning, so the app was its first holder and anything arriving later
        // could only take addresses the app left free. That premise is
        // spawn-time, though, and this is a share-time conclusion — share()'s
        // liveness gate only establishes that the start command's wrapper
        // process is alive (rec.pid is the `bash -lc` wrapper, see
        // runner.spawnChild), not that the app's own listener is still up. A
        // reloader restarting the server frees the port machine-wide for a
        // moment, during which something else could take the wildcard. So 'app' means "almost
        // certainly the app", and every message built from it is phrased to
        // match (see public/shareState.js).
        //
        // 'inconclusive' maps to 'unknown', which callers must treat as
        // possible exposure rather than as an all-clear: on a host with no
        // loopback aliases the probe can never run at all.
        const hold = await probeWildcardHold(rec.fixedPort);
        fixedPortHolder = hold === 'held' ? 'app' : hold === 'free' ? 'other' : 'unknown';
        const why = fixedPortHolder === 'app'
          ? 'held on every interface, almost certainly by the app itself — if so it is already reachable there ungated'
          : fixedPortHolder === 'other'
            ? 'another process holds a LAN address at that port — not the app, which is not LAN-reachable there'
            : 'code-hub could not identify what holds it; if the app binds all interfaces it is already reachable there ungated';
        console.error(`[appManager] ${id}: fixed port ${rec.fixedPort} is not bindable on the LAN interfaces — ${why}; gated share falling back to a free port`);
      }
    }
    if (!proxy) proxy = await startAuthProxy(rec.port, { host: '0.0.0.0', auth, tls: tlsOpt });
    proxies.set(id, proxy);
    const scheme = useTls ? 'https' : 'http';
    // Drop the loopback entry — it's not reachable from another device, and in
    // the fixed-port case that's load-bearing rather than cosmetic: the proxy
    // isn't bound on loopback at all there, so `<scheme>://localhost:<fixedPort>`
    // would reach the app DIRECTLY, ungated.
    const loopbackPrefix = `${scheme}://localhost:`;
    const urls = enumerateUrls(proxy.port, { lanFallback: true, scheme }).filter((u) => !u.startsWith(loopbackPrefix));
    const url = urls[0] ?? `${scheme}://localhost:${proxy.port}`; // no LAN interface found
    rec.tunnel = { kind: 'lan', url, urls, pid: null, proxyPort: proxy.port, auth, tls: useTls, fixedPortFallback, fixedPortHolder };
    await persist();
    if (!auth) {
      // Nothing to authenticate — but a QR of the plain URL is still a
      // handy scan-to-open shortcut.
      return { kind: 'lan', url, urls, auth: false, tls: useTls, proxyPort: proxy.port, fixedPortFallback, fixedPortHolder, qrSvg: await cachedQrSvg(id, { url, authUrl: null }) };
    }
    const authUrl = withToken(url, proxy.token);
    return { kind: 'lan', url, urls, auth: true, tls: useTls, proxyPort: proxy.port, fixedPortFallback, fixedPortHolder, authUrl, username: proxy.username, password: proxy.password, qrSvg: await cachedQrSvg(id, { url, authUrl }) };
  }

  if (mode === 'tailscale') {
    const blocker = funnelBlockedBy(id);
    if (blocker) {
      // No claim is made on this path, so this await races nothing — and
      // "tailscale isn't available" is the more actionable message when both
      // are true, so it is reported in preference to the 409.
      if (!(await tailscale.available())) throw tailscaleUnavailable();
      const e = new Error(blocker === id
        ? `'${id}' already has a tailscale share starting — wait for it to come up before sharing again`
        : `'${blocker}' already has a tailscale share — Tailscale Funnel occupies port 443 machine-wide, so only one is possible at a time; unshare it first`);
      e.statusCode = 409; throw e;
    }
    // Claim the slot SYNCHRONOUSLY — no await between the check above and
    // this line, so two concurrent requests cannot both get here.
    const prior = funnelSlot; // null, or this app's own held slot (a re-share)
    funnelSlot = { id, pid: null, pending: true };
    try {
      if (!(await tailscale.available())) throw tailscaleUnavailable();
      teardownShare(id, rec); // replace any existing share

      // A funnel still shutting down reverts the node's WHOLE serve config
      // when it finally exits, which would silently take the new funnel's URL
      // with it. Wait it out rather than racing it.
      if (expiringFunnelPid) {
        await tailscale.waitForExit(expiringFunnelPid);
        expiringFunnelPid = null;
      }

      // No `tls` option: tailscaled terminates TLS on-machine and forwards plain
      // HTTP here, exactly as cloudflared does (see authproxy.js).
      const proxy = await startAuthProxy(rec.port);
      let url, pid;
      try {
        ({ url, pid } = await tailscale.startFunnel(proxy.port));
      } catch (e) {
        proxy.close(); // don't leak the proxy if the funnel failed to come up
        throw e;
      }
      proxies.set(id, proxy);
      rec.tunnel = { kind: 'tailscale', url, pid, proxyPort: proxy.port, auth: true };
      funnelSlot = { id, pid, pending: false };
      await persist();

      const authUrl = withToken(url, proxy.token);
      return { kind: 'tailscale', url, auth: true, authUrl, username: proxy.username, password: proxy.password, qrSvg: await cachedQrSvg(id, { url, authUrl }) };
    } catch (e) {
      // Hand the slot back to whoever held it, if their funnel survived this
      // attempt: a refusal thrown BEFORE teardownShare (an unavailable daemon)
      // leaves the previous share fully intact, and freeing the slot there
      // would let another app start a competing funnel in front of it. If the
      // old funnel is gone — torn down above, or it was never there — free it.
      funnelSlot = (prior && !prior.pending && state.pidAlive(prior.pid)) ? prior : null;
      throw e;
    }
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
  return { kind: 'tunnel', url, auth: true, authUrl, username: proxy.username, password: proxy.password, qrSvg: await cachedQrSvg(id, { url, authUrl }) };
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
  // The QR encodes the token URL, which is stable across a creds edit (the
  // token/proxy/URL are untouched), so this is a cache hit — but the field is
  // still returned so the caller can fold it back into its share state on the
  // same shape as the auth-toggle response. `auth` is guaranteed true here
  // (guarded above), so the token URL always exists.
  const url = store.apps[id].tunnel.url;
  const authUrl = withToken(url, proxy.token);
  return {
    id, username: proxy.username, password: proxy.password,
    qrSvg: await cachedQrSvg(id, { url, authUrl }),
  };
}

// Flip a live LAN share's auth gate in place — mutates the proxy (see
// authproxy.js's setAuth), so the share URL/token/proxy port never change.
// Tunnel and tailscale shares are always gated and reject this (mirrors the
// same guard in share()); a token/authUrl handed out earlier stays valid
// either way since the proxy never regenerates them on a toggle.
export async function setShareAuth(id, enabled) {
  if (typeof enabled !== 'boolean') { const e = new Error("'enabled' must be a boolean"); e.statusCode = 400; throw e; }
  const rec = store.apps[id];
  const proxy = proxies.get(id);
  if (!rec?.tunnel || !proxy) { const e = new Error(`'${id}' has no active share`); e.statusCode = 409; throw e; }
  if (rec.tunnel.kind !== 'lan') {
    const e = new Error(`authentication cannot be toggled for '${rec.tunnel.kind}' shares — they are always gated`); e.statusCode = 400; throw e;
  }
  proxy.setAuth(enabled);
  rec.tunnel.auth = enabled;
  await persist();
  // The QR tracks the gate: gated → the token URL (the proxy's stable token,
  // available again now that auth is on); ungated → the plain URL (no token
  // exists). Returned so the client can refresh the QR shown from the
  // pre-toggle share response, which would otherwise be stale (a plain QR
  // scanned after re-gating would 401).
  const url = rec.tunnel.url;
  const authUrl = enabled ? withToken(url, proxy.token) : null;
  const qr = await cachedQrSvg(id, { url, authUrl });
  return { id, auth: enabled, qrSvg: qr };
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
export async function registerApp({ id, start, name, healthPath, readyWhen, port, routes } = {}) {
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
  const manifest = validateManifestObject({ start, name, healthPath, readyWhen, port, routes }, `register_app:${id}`);
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
