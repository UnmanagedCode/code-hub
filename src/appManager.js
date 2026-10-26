import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  discoverApps, projectsRoot, MANIFEST_FILENAME, appDir, listWorktreeDirs, isWorktreeId,
  WORKTREE_ID_QUALIFIER,
  validateManifestObject, readRegistry, writeRegistry, registerInMemory,
} from './projects.js';
import * as state from './state.js';
import * as runner from './runner.js';
import * as tunnel from './tunnel.js';
import * as tailscale from './tailscale.js';
import { allocatePort, isPortFree, probeWildcardHold, enumerateUrls, localIPv4s, runningInContainer, bridgeOnlyLan, bridgeIPv4 } from './net.js';
import * as hostRelay from './hostRelay.js';
import * as loopbackMirror from './loopbackMirror.js';
import * as bridgeForward from './bridgeForward.js';
import * as hubSettings from './hubSettings.js';
import { appUrls } from './appUrls.js';
import { qrSvg } from './qr.js';
import { headSha, currentBranch, lastCommitAt } from './git.js';
import { startAuthProxy } from './authproxy.js';
import { generateSelfSigned } from './selfsigned.js';
import { isEmbedded, isHostConductorId, hostConductorPort, hostConductorDir, HOST_CONDUCTOR_ID } from './hostConductor.js';
import * as conductorProjects from './conductorProjects.js';
import * as appSettings from './appSettings.js';
import * as autoRun from './autoRun.js';
import { validateShareOptions, FUNNEL_PORTS } from './shareOptions.js';

// In-memory mirror of the persisted state, loaded once at init and kept in
// sync on every mutation. This module is the single source of truth for
// "what is running"; routes.js is a thin layer over it.
let store = { apps: {} };

// Live auth-proxy handles, keyed by app id. In-memory only: the password and
// the proxy server never survive a code-hub restart (see init teardown).
const proxies = new Map();
// proxy → the running record it was committed for (see teardownShare).
const proxyOwner = new WeakMap();
// A LAN share's host-relay exposure, keyed by app id beside its proxy (and
// owner-checked with it): closed whenever the proxy is.
const relayHandles = new Map();

// Ids whose live proxy holds the app's stored default password: added when
// share() seeds from it; removed by a password edit or teardownShare. Drives
// the `passwordIsDefault` flag the UI masks on.
const defaultPasswordShares = new Set();

// startAuthProxy options for an app's stored default login: only the fields
// that are set, so an unset username stays 'hub' and an unset password stays
// random.
function credOpts(creds) {
  return {
    ...(creds.username ? { username: creds.username } : {}),
    ...(creds.password ? { password: creds.password } : {}),
  };
}

// True when `dir` is `root` itself or a descendant of it. Used to decide
// whether the injected host-conductor dir is reachable by discoverApps()'s
// root scan at all.
function isUnderRoot(root, dir) {
  const rel = path.relative(root, dir);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export async function init() {
  await appSettings.migrateLegacyFile();
  // The ONE awaited conductor call: it lands the project overlay before the
  // first listing, off the request path and bounded by the overlay's own
  // timeout. No-op when standalone; every later refresh is fired lazily by
  // discovery and never awaited.
  await conductorProjects.refresh();
  // Every record is about to be replaced by a fresh object, so no in-process
  // share state may outlive this point: kill the share children of the
  // records being discarded (one still inside its post-commit persist isn't
  // on disk yet, so the sweep below would never see it) — which also releases
  // its committed funnel slot — and close every proxy (teardownShare is
  // record-scoped and would skip one committed for a record that no longer
  // exists). A share still in flight is left to abandon itself: its record no
  // longer exists, so it can't commit, and it keeps its `sharing` entry and
  // any pending slot claim until it has closed what it started, so a later
  // share of the app waits for it instead of racing it. Nothing of this
  // exists on a real boot; only a re-run init() in one process finds any.
  //
  // The store is emptied FIRST, before any await: an in-flight share checks
  // `store.apps[id] === rec` right before committing, so for as long as the
  // old store were still in place (the load below awaits) it could commit a
  // live, unlisted share after the sweep had already run.
  const discarded = store;
  store = { apps: {} };
  for (const [id, rec] of Object.entries(discarded.apps)) if (rec.tunnel) killShareChild(id, rec.tunnel);
  for (const proxy of proxies.values()) proxy.close();
  proxies.clear();
  for (const handle of relayHandles.values()) handle.close();
  relayHandles.clear();
  defaultPasswordShares.clear();
  qrCache.clear();
  store = await state.load();
  // reconcile drops records whose app pid is dead — which, for an app that
  // died in the same window code-hub did, would delete the only record of a
  // still-running share child. It hands those back instead of stranding them
  // (see state.reconcile) and they are killed here, BEFORE the sweep below,
  // because their records no longer hold them to be swept.
  const { strandedShares } = await state.reconcile(store);
  for (const { id, tunnel: t } of strandedShares) killShareChild(id, t, { verify: true });
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
      // Register in-memory only when the id actually resolves to something
      // under the root: the checkout itself, or — since a worktree need not
      // be a sibling of its checkout, cc rooting a local-system project's
      // worktrees at `<root>/.worktrees/<project>/` wherever its tree lives —
      // at least one worktree of it, which needs the registration to inherit
      // a manifest at all. Registering
      // when neither exists would make discoverApps() warn about an orphaned
      // key on every call, and could shadow the injected dir with a same-named
      // but unrelated sibling under the root (wrong path/git info).
      const hasInRootWorktree = (await listWorktreeDirs()).worktrees.some((w) => w.project === HOST_CONDUCTOR_ID);
      if (isUnderRoot(projectsRoot(), injectedDir) || hasInRootWorktree) {
        registerInMemory(HOST_CONDUCTOR_ID, { start: 'npm start', name: 'code-conductor', healthPath: '/' });
      }
    } else {
      // Older conductor (no CONDUCTOR_PROJECT_DIR): fall back to discovering a
      // `code-conductor/` dir under the root. The conductor carries no
      // `.hub.json` of its own, so register it in-memory (never persisted)
      // before discovering — this is what makes discoverApps() find it at
      // all, and lets a `code-conductor:<key>` worktree with no manifest of
      // its own inherit one via projects.js's worktree-parent-fallback.
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
        startedSha: null, startedAt: null, tunnel: null,
      };
      mutated = true;
    }
  }
  if (mutated) await persist();
  else syncExposures();
}

// THE authority for "which app holds which Tailscale Funnel port". Funnel
// serves a fixed set of public ports (shareOptions.FUNNEL_PORTS), and tailscaled
// lets exactly one funnel hold each, so there is one slot per port and every
// per-port 409 is derived from this — nothing scans the app records for a
// holder. Two sources of truth is precisely what went wrong before: any site
// that dropped a record without telling the slot left it naming a share that
// no longer existed, wedging that port until a restart.
//
//   Funnel port → { id, pid, pending }
//     pending — the share is still coming up: no pid yet, no record yet.
//               share() claims its port SYNCHRONOUSLY before its first await,
//               because rec.tunnel isn't written until the funnel is up (up to
//               the full readiness backstop), so two concurrent requests for
//               one port would otherwise both pass any records-based check. A
//               pending slot blocks its OWN app too — a second concurrent share
//               of A would orphan the first one's proxy and funnel child.
//     pid     — the funnel child this slot names, once it is up.
//
// Released precisely when the child it NAMES is killed (see killShareChild),
// never on an id or port match: share() claims a slot and then tears down that
// same app's previous funnel — on this port or another — so an id-keyed
// release would drop the claim it just made. Keying on pid makes teardownShare
// the single release point, which is what lets "route every record-dropping
// site through teardownShare" close the whole class rather than three
// instances of it.
const funnelSlots = new Map();

// pids of SIGTERMed tailscale funnels that may still be exiting. Until one is
// gone, tailscaled still holds its Funnel port and refuses a new funnel there,
// so the next tailscale share waits all of them out (see share()) — bounded by
// waitForExit's timeout, and with no need to know which port each one held.
// Covers re-sharing one app, moving it to another port, and unsharing A then
// sharing B.
const expiringFunnelPids = new Set();

// SIGTERM the child publishing a share, dispatching on its kind (a LAN share
// has none). Split out of teardownShare so init() can also kill a child whose
// record reconcile already dropped — at that point there is no record left to
// tear down, only a pid.
//
// `verify` guards the ONLY case where the pid did not come from a child we
// spawned in this process: pids read back from state.json can have been
// recycled across a reboot, and signalling a recycled pid would SIGTERM (and,
// on an unresponsive one, SIGKILL) an unrelated process group on the user's
// machine. See tailscale.looksLikeFunnel.
function killShareChild(id, t, { verify = false } = {}) {
  if (!t || t.kind === 'lan') return;
  if (t.kind === 'tailscale') {
    if (verify && !tailscale.looksLikeFunnel(t.pid)) {
      console.error(`[appManager] ${id}: persisted funnel pid ${t.pid} is not a tailscale funnel (recycled?) — not signalling it`);
    } else {
      tailscale.stopFunnel(t.pid);
      if (t.pid) expiringFunnelPids.add(t.pid);
    }
    for (const [port, slot] of funnelSlots) {
      if (!slot.pending && slot.pid === t.pid) funnelSlots.delete(port);
    }
  } else {
    tunnel.stopTunnel(t.pid);
  }
}

// Tear down a share: close the auth proxy (if any) and its host-relay exposure,
// and kill the child that publishes it. Leaves rec.tunnel null. Safe to call when nothing is shared.
// A tailscale funnel runs in the foreground, so SIGTERM is the whole teardown
// — the CLI removes its own funnel config on exit (see src/tailscale.js).
//
// EVERY site that drops or replaces a record carrying a share must come
// through here — init's sweep, list()'s prune and reap, stop(), start()'s
// replacement of a dead app's record, unshare(). That is the single-authority
// rule that keeps funnelSlots from ever naming a share that no longer exists.
//
// Synchronous, so the in-memory maps are consistent the instant it returns.
// The SIGTERM it sends is NOT awaited, though, so the killed child may still
// be exiting afterwards — which matters only for tailscale, where a lingering
// funnel still holds its Funnel port: `expiringFunnelPids` records it and the
// next tailscale share waits for it.
//
// Record-scoped: the live proxy (and the id-keyed state that describes it) is
// touched only when it belongs to `rec`, so a caller holding a stopped or
// replaced record can never close the share of the record that replaced it.
// `rec` undefined means "no record left": whatever proxy remains is an orphan.
function teardownShare(id, rec, opts) {
  const proxy = proxies.get(id);
  if (!proxy || !rec || proxyOwner.get(proxy) === rec) {
    if (proxy) { proxy.close(); proxies.delete(id); }
    relayHandles.get(id)?.close();
    relayHandles.delete(id);
    defaultPasswordShares.delete(id);
    qrCache.delete(id);
  }
  if (rec?.tunnel) killShareChild(id, rec.tunnel, opts);
  if (rec) rec.tunnel = null;
}

// Free every slot whose funnel has died on its own (an OOM kill, a stray
// kill) — refusing every other app on behalf of a funnel that no longer exists
// would wedge that port until a restart. A pending claim is never stale: its
// share() call is still running. Returns whether it tore a share down (the
// caller persists).
function reapFunnelSlots() {
  let toreDown = false;
  for (const [port, slot] of funnelSlots) {
    if (slot.pending || state.pidAlive(slot.pid)) continue;
    const rec = store.apps[slot.id];
    if (rec?.tunnel?.pid === slot.pid) { teardownShare(slot.id, rec); toreDown = true; } // drops the stale URL/creds/QR too
    funnelSlots.delete(port);
  }
  return toreDown;
}

function tailscaleUnavailable() {
  const e = new Error('tailscale is not available — start tailscaled and log in to share via a Tailscale Funnel URL');
  e.statusCode = 501;
  return e;
}

// Which app blocks a tailscale share of `id` on `funnelPort`, or null when
// nothing does. Reads funnelSlots ONLY. A slot held by this same app does not
// block — that is a re-share, which replaces it.
function funnelBlockedBy(id, funnelPort) {
  reapFunnelSlots();
  const slot = funnelSlots.get(funnelPort);
  if (!slot) return null;
  if (slot.pending) return slot.id; // blocks everyone (its own app can't get here: share() serialises an app's shares)
  return slot.id === id ? null : slot.id;
}

// Every Funnel port and the app holding it (a pending claim included), or null
// when free — the listing's `funnelPorts`. Reaps dead holders first, so a
// funnel that died on its own reads as free; `toreDown` tells list() to persist.
function funnelOccupancy() {
  const toreDown = reapFunnelSlots();
  return { toreDown, ports: FUNNEL_PORTS.map((port) => ({ port, holder: funnelSlots.get(port)?.id ?? null })) };
}

// The loopback mirror set and the bridge forwarder set are derived from the
// store each mutation persists: every ready app but the always-on host
// conductor (code-hub never started it). Also run when a start's readiness
// settles (see start()), when a child exits (see runner.onExit below), so a
// crash drops its exposures without waiting for a persist, when a host client
// finds a mirrored port refusing, when a LAN share starts, when any share ends
// (see shareNow), and when the hub settings change. An ADOPTED app
// (no child of ours to exit) that dies is noticed by either that refusal or a
// listing (list() prunes its record, and the persist re-syncs).
async function persist() {
  syncExposures();
  await state.save(store);
}

// Exposed only once ready, never while starting: where the host's loopback is
// the app's own (a host-network container), a relay listener bound first would
// take the app's port before the app could — and a bridge forwarder bound first
// would take the bridge address from an app about to bind 0.0.0.0.
function appMirrorable(rec) {
  const rt = runner.runtime(rec.id);
  if (rt) return rt.status === 'ready';
  return state.pidAlive(rec.pid); // adopted after a restart: no runtime, already listening
}

// A LAN share holds the app's bridge address — committed, or in flight for
// this very record — so its forwarder stands aside: a fixed-port LAN share
// binds that address itself, gated. Tunnel and tailscale shares bind nothing
// there and leave the forwarder up.
function lanShared(rec) {
  const op = sharing.get(rec.id);
  return rec.tunnel?.kind === 'lan' || (!!op?.lan && op.rec === rec);
}

function syncExposures() {
  const exposed = Object.values(store.apps).filter((rec) => !isHostConductorId(rec.id) && appMirrorable(rec));
  loopbackMirror.sync(exposed.map((rec) => ({ id: rec.id, port: rec.port })), syncExposures);
  // The forwarders don't depend on the relay: with a mirror up, only the
  // Start URL moves to it (see appUrls).
  const host = hubSettings.get().bridgeFallback ? bridgeIPv4() : null;
  bridgeForward.sync(exposed.filter((rec) => !lanShared(rec)).map((rec) => ({ id: rec.id, port: rec.port })), host);
}

runner.onExit(() => syncExposures());

// The URLs of a running app's route: through the host loopback mirror first
// while there is one, else the bridge address while the app is reachable
// there (see appUrls).
function urlsFor(id, port, routePath = '/') {
  return appUrls({ port, routePath, lanIps: localIPv4s(), hostLoopbackPort: loopbackMirror.hostPort(id), bridgeHost: bridgeForward.urlHost(id) });
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
// share()/creds-edit/auth-toggle — NOT on every list() call. Lives in memory
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
  const settings = await appSettings.readAll();
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
      port = rec.port; urls = urlsFor(base.id, rec.port); startedSha = rec.startedSha;
      // username/password come from the live proxy (proxies map), never
      // from rec.tunnel — that's how the password persists across a page
      // reload (in-memory, for the share's lifetime) without ever touching
      // state.json. rec.tunnel itself holds only non-secret fields. authUrl and
      // qrSvg likewise recover from the live proxy: authUrl is rebuilt from the
      // proxy token, and qrSvg is served from cachedQrSvg (regenerated only on
      // share/creds-edit/auth-toggle, not per listing) — so a full UI refresh (which
      // wipes the client's in-memory state.share) still shows the QR and Open's
      // magic-link. Omitted for a no-auth share (no token path) or a gone proxy.
      // A tailscale funnel that died on its own (OOM kill, a stray kill) leaves
      // a record advertising a public URL that answers nothing — and keeps
      // refusing every other app's tailscale share on its Funnel port on behalf
      // of a holder that holds nothing. Reap it on the listing that notices,
      // before anything is built from it. (A LAN share has pid null by design
      // and a cloudflared tunnel is untouched here — only a Funnel port slot has
      // a machine-wide consequence worth a per-listing probe.)
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
          funnelPort: rec.tunnel.funnelPort ?? null,
          fixedPortFallback: rec.tunnel.fixedPortFallback === true,
          fixedPortHolder: rec.tunnel.fixedPortHolder ?? null,
          relay: rec.tunnel.relay ?? null,
          containerInternal: rec.tunnel.containerInternal === true,
          auth, tls: rec.tunnel.tls === true,
          // `password` is the real value (the UI's Copy needs it); this flag
          // only tells the UI to mask it on screen.
          username, password, passwordIsDefault: auth && defaultPasswordShares.has(base.id),
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
          // funnel would keep its Funnel port published in front of a proxy that
          // is about to close, and would block every other app's share on that
          // port forever.
          teardownShare(base.id, rec);
          autoRun.forget(base.id);
          delete store.apps[base.id]; mutated = true;
          status = 'stopped'; port = urls = startedSha = undefined; tunnelInfo = null;
        }
      }
    }

    const currentSha = sourceMissing ? null : await headSha(base.path);
    const branch = base.isWorktree ? (sourceMissing ? (rec?.branch ?? null) : await currentBranch(base.path)) : null;
    const commitAt = sourceMissing ? null : await lastCommitAt(base.path);

    // Named routes from the manifest, else a single implicit route at `/`.
    // URLs are derived live from the running port and the loopback mirror.
    const routeDefs = base.manifest?.routes ?? [{ name: base.manifest?.name ?? base.id, path: '/' }];
    const routes = routeDefs.map((r) => ({
      name: r.name, path: r.path,
      urls: port ? urlsFor(base.id, port, r.path) : [],
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
      settings: appSettings.describe(settings[base.id]),
      manifestPort: base.manifest?.port ?? null,
      ...autoRun.view(base.id),
      tunnel: tunnelInfo,
      error,
      manifestError,
      alwaysOn: isHostConductorId(base.id) && !!rec,
      source: base.source,
    };
  };

  // hasOwn: an app id is a directory name, so `__proto__`/`constructor` must not
  // read Object.prototype members as a running record.
  for (const app of discovered) entries.push(await build(app, Object.hasOwn(store.apps, app.id) ? store.apps[app.id] : undefined));
  for (const [id, rec] of Object.entries(store.apps)) {
    if (byId.has(id)) continue; // already built above
    entries.push(await build({ ...rec, manifest: null, manifestError: null }, rec));
  }
  // After the build loop (which reaps its own records' dead funnels) and before
  // the persist, so a reap here is saved too.
  const occupancy = funnelOccupancy();
  if (occupancy.toreDown) mutated = true;
  if (mutated) await persist();

  entries.sort((a, b) => a.id.localeCompare(b.id));
  return { cloudflaredAvailable: await tunnel.available(), tailscaleAvailable: await tailscale.available(), funnelPorts: occupancy.ports, hubSettings: hubSettings.get(), apps: entries };
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
  // drop the only reference to a live funnel — orphaning it on its Funnel port
  // and leaving that slot naming an app with no share, blocking every future
  // tailscale share there until a restart. Same single-authority rule as every
  // other site that drops a record: tear the share down first.
  if (existing?.tunnel) teardownShare(id, existing);
  const app = await findDiscovered(id);
  // A read error other than a missing file propagates and refuses the start:
  // without the store the app's fixed port is unknown, and starting anyway could
  // silently move it. A missing, corrupt or non-object file reads as empty
  // (readAll()).
  const settings = await appSettings.get(id);
  // The app's Settings port beats its manifest's; a worktree never has one (its
  // manifest port is stripped in discovery, and a hand-written settings port is ignored).
  const fixedPort = app.isWorktree ? null : (settings.port ?? app.manifest.port ?? null);
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
  // The run re-reads its config once ready, and reports a failed read on the card.
  const readConfig = autoShareConfigFor(id, app.isWorktree);
  const wantsAutoShare = !app.isWorktree && !!settings.autoShare;
  const rec = {
    id, project: app.project, path: app.path,
    isWorktree: app.isWorktree, branch: app.isWorktree ? await currentBranch(app.path) : null,
    pid: proc.pid, pgid: proc.pgid, port, fixedPort,
    startedSha: await headSha(app.path),
    startedAt: proc.startedAt,
    tunnel: null,
  };
  // Every start is tracked, auto-shared or not: a client's settle wait follows
  // readiness. Tracked in the same synchronous step that makes the record
  // visible, so no listing can show it `starting` with nothing to wait on.
  store.apps[id] = rec;
  trackTransition(id, rec, { settled: proc.settled, wantsAutoShare, readConfig });
  proc.settled.then(() => syncExposures());
  await persist();
  return { ...rec, urls: urlsFor(id, port) };
}

// The stored auto-share config of `id` as autoRun reads it: applies to a main
// checkout only, whatever the file says.
function autoShareConfigFor(id, isWorktree) {
  return async () => (!isWorktree && (await appSettings.get(id)).autoShare) || null;
}

// Begin and track `rec`'s transition: `settled` (the status readiness settled
// to), followed by its auto-share when one is wanted. Synchronous, so a caller
// can make it in the same step that makes `rec` visible. The auto-share is
// never awaited by the caller, so it can neither slow down nor fail it.
function trackTransition(id, rec, { settled, wantsAutoShare, readConfig }) {
  const gen = autoRun.begin(id, { autoShare: wantsAutoShare });
  autoRun.track(id, wantsAutoShare
    ? autoRun.run({
      id, gen, settled,
      isCurrent: () => store.apps[id] === rec && !rec.tunnel,
      readConfig,
      share: (cfg) => share(id, cfg),
    })
    : settled);
}

// Boot auto-share of the always-on host conductor, a rule of its own: a normal
// app is auto-shared only after a start code-hub made, so an adopted one never
// is; code-hub never starts the always-on app, and the one lifecycle event it
// owns for it is its own boot, when init() builds the record afresh with no
// share. So it is auto-shared then, when ticked. It is always running and a
// share needs only its port, so nothing waits on readiness. Returns whether an
// auto-share began. Called once code-hub is listening, after init().
export async function autoShareAlwaysOn() {
  const id = HOST_CONDUCTOR_ID;
  const rec = store.apps[id];
  if (!isHostConductorId(id) || !rec || rec.tunnel) return false;
  const readConfig = autoShareConfigFor(id, false);
  const wants = await readConfig().then(Boolean, () => true);
  if (!wants || store.apps[id] !== rec || rec.tunnel) return false;
  trackTransition(id, rec, { settled: Promise.resolve('ready'), wantsAutoShare: true, readConfig });
  return true;
}

export async function stop(id) {
  if (isHostConductorId(id)) {
    const e = new Error(`'${id}' is managed by the host code-conductor and cannot be stopped`); e.statusCode = 409; throw e;
  }
  const rec = store.apps[id];
  if (!rec) { const e = new Error(`'${id}' is not running`); e.statusCode = 404; throw e; }
  teardownShare(id, rec);
  runner.stop({ id, pgid: rec.pgid });
  autoRun.forget(id);
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
//   validateShareOptions) wraps the proxy in HTTPS with a per-share self-signed cert
//   so the LAN hop is encrypted; set it false for plain HTTP.
// - 'tailscale': a Tailscale Funnel points at the auth proxy, publishing the
//   node's MagicDNS name (https://<machine>.<tailnet>.ts.net) — public, and
//   unlike cloudflared's random hostname it is stable across restarts. Always
//   gated. Each runs on one public Funnel port (`funnelPort`, one of
//   FUNNEL_PORTS, default 443; any port but 443 appears in the URL), and a port
//   holds ONE tailscale share at a time (409 naming the holder and the port).
// For a gated share, a fresh token is generated per share; the username and
// password are the app's stored default share login where set (see
// appSettings.js — each field falls back independently to 'hub' / a random
// password), all kept in memory only for the share (see the `proxies` map).
// The QR/authUrl carries the token
// (opening it exchanges the token for an httpOnly session cookie server-side
// — no credentials ever appear in the URL); username/password remain
// available as a Basic-Auth fallback for curl/API clients, and persist
// (in-memory) for the lifetime of the share — see `list()`.
//
// ONE share operation per app at a time, whoever the callers are (the UI,
// another tab, an auto-share after a start — there is no MCP share tool), since two in flight would each
// start a proxy and a child and the loser would be held by nothing
// unshare/stop/the sweep can reach:
// - a second share of the same running record while one is in flight is
//   refused with 409, not queued;
// - a share for a NEW record (the app was restarted) waits for an in-flight
//   share of the stopped or replaced record to finish — that one can no longer
//   commit — so the new record's share, an auto-share included, isn't refused
//   on behalf of a share that is about to be abandoned.
// A share that is stopped, replaced, or unshared (see unshare) while in flight
// tears down what it started and 409s instead of committing.
//
// Any successful share, manual or automatic, clears the app's auto-share
// outcome (a stale "auto-share failed" once the app is shared after all).
export async function share(id, opts) {
  const result = await shareNow(id, opts);
  autoRun.clearShareOutcome(id);
  return result;
}

// id → the share in flight: { rec, lan, cancelled, done } (see share());
// `lan` keeps the app's bridge forwarder closed while it runs (see lanShared).
const sharing = new Map();

function abandoned(id, op) {
  const e = new Error(op.cancelled
    ? `the share of '${id}' was cancelled by an unshare while it was starting`
    : `'${id}' was stopped or replaced while its share was starting — share it again`);
  e.statusCode = 409;
  // A deliberate Unshare is not a failure: autoRun records nothing for it.
  if (op.cancelled) e.unshared = true;
  return e;
}

async function shareNow(id, { mode = 'tunnel', auth, tls, funnelPort } = {}) {
  ({ mode, auth, tls, funnelPort } = validateShareOptions({ mode, auth, tls, funnelPort }));
  for (;;) {
    const rec = store.apps[id];
    const alwaysOn = isHostConductorId(id);
    if (!rec || (!alwaysOn && !state.pidAlive(rec.pid))) { const e = new Error(`'${id}' is not running`); e.statusCode = 409; throw e; }
    const inFlight = sharing.get(id);
    if (inFlight?.rec === rec) {
      const e = new Error(`'${id}' already has a share starting — wait for it to finish before sharing again`); e.statusCode = 409; throw e;
    }
    if (inFlight) {
      await inFlight.done.catch(() => {}); // a stopped/replaced record's share, being abandoned
      continue;
    }
    const op = { rec, lan: mode === 'lan', cancelled: false, done: null };
    sharing.set(id, op); // before shareRecord's first await
    // A LAN share closes the app's bridge forwarder before it binds anything:
    // a fixed-port share binds that very address. server.close() releases the
    // listening socket synchronously, so it is free by the share's first bind.
    if (op.lan) syncExposures();
    op.done = shareRecord(id, op, { mode, auth, tls, funnelPort });
    try {
      return await op.done;
    } finally {
      if (sharing.get(id) === op) sharing.delete(id);
      // A share that didn't commit hands the address back to the forwarder —
      // in any mode, since a tunnel or tailscale re-share may have already torn
      // the previous LAN share down before failing.
      syncExposures();
    }
  }
}

// The body of a share of `op.rec`. Each commit (proxies.set, rec.tunnel)
// follows a `committable()` check with no await in between, and that check
// comes after the last await that can have created a listener or a child — so
// a share abandoned meanwhile closes what it started instead of committing.
// Teardown of a previous share is record-scoped (see teardownShare), so an
// abandoned share running it touches nothing of a newer record's.
async function shareRecord(id, op, { mode, auth, tls, funnelPort }) {
  const { rec } = op;
  const committable = () => store.apps[id] === rec && !op.cancelled;
  // Read BEFORE the mode branches: the tailscale branch's slot claim must have
  // no await between its check and the claim.
  const creds = await appSettings.get(id);
  // Called right after each branch's proxies.set.
  const markDefault = () => { if (creds.password) defaultPasswordShares.add(id); };

  if (mode === 'lan') {
    teardownShare(id, rec); // replace any existing share
    const useTls = tls; // validateShareOptions defaults it to on; the UI/API `tls` flag overrides
    const scheme = useTls ? 'https' : 'http';
    const lanIps = localIPv4s({ lanFallback: true }); // one list for the cert SAN and the bind hosts
    // In a container, the share is also exposed on the host's LAN address
    // through the host relay (see hostRelay.js), whenever a relay session is
    // up — now or later. A relay problem is reported on the share and never
    // fails it: the share goes on as an ordinary LAN share.
    const relayed = runningInContainer();
    const bridgeOnly = bridgeOnlyLan(lanIps, relayed);
    let handle = null;
    let onRelayChange = () => {}; // set once the share commits
    let proxy = null;
    let fixedPortFallback = false;
    let fixedPortHolder = null;
    try {
      // Self-signed cert covering the LAN IPs, the relay's advertised host IPs
      // and loopback, generated per share and held in memory only (via the
      // proxy) — nothing on disk; regenerated when the relay advertises an
      // address it lacks. Browsers show a one-time "not private" warning
      // (self-signed); documented as a limitation.
      let tlsOpt = null;
      const sanIps = new Set([...lanIps, ...hostRelay.addresses(), '127.0.0.1']);
      const makeCert = () => generateSelfSigned({ ipAddresses: [...sanIps], dnsNames: ['localhost'] });
      if (useTls) tlsOpt = makeCert();
      // Same-port LAN share: measured on Linux, a proxy CAN bind
      // <lanIp>:<fixedPort> while the app holds 127.0.0.1:<fixedPort>, but NOT
      // while the app holds the wildcard (SO_REUSEADDR doesn't permit
      // overlapping listen binds). code-hub injects only PORT and can't know
      // which host the child chose, so attempt the bind and let EADDRINUSE
      // answer — never guess.
      if (rec.fixedPort && lanIps.length) {
        try {
          proxy = await startAuthProxy(rec.port, { ...credOpts(creds), host: lanIps, port: rec.fixedPort, auth, tls: tlsOpt });
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
          // match (see frontend/src/lib/shareState.ts).
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
      if (!proxy) proxy = await startAuthProxy(rec.port, { ...credOpts(creds), host: '0.0.0.0', auth, tls: tlsOpt });
      if (relayed) {
        const target = { host: proxy.hosts[0] === '0.0.0.0' ? '127.0.0.1' : proxy.hosts[0], port: proxy.port };
        handle = hostRelay.expose(proxy.port, hostRelay.SCOPES.lan, target, () => onRelayChange());
        await handle.ready;
      }
      if (!committable()) throw abandoned(id, op);
      // Drop the loopback entry — it's not reachable from another device, and in
      // the fixed-port case that's load-bearing rather than cosmetic: the proxy
      // isn't bound on loopback at all there, so `<scheme>://localhost:<fixedPort>`
      // would reach the app DIRECTLY, ungated.
      const loopbackPrefix = `${scheme}://localhost:`;
      const containerUrls = enumerateUrls(proxy.port, { lanFallback: true, scheme }).filter((u) => !u.startsWith(loopbackPrefix));
      // Where the share is reachable right now: the host's addresses while the
      // relay has its port bound, else the container's own.
      const reach = () => {
        const relay = handle?.info() ?? null;
        const urls = relay?.state === 'up' ? hostRelay.addresses().map((ip) => `${scheme}://${ip}:${relay.port}`) : containerUrls;
        const url = urls[0] ?? `${scheme}://localhost:${proxy.port}`; // no LAN interface found
        return { url, urls, relay, containerInternal: relay?.state !== 'up' && bridgeOnly };
      };
      const tunnelRec = { kind: 'lan', ...reach(), pid: null, proxyPort: proxy.port, auth, tls: useTls, fixedPortFallback, fixedPortHolder };
      // The commit: plain assignments only, so nothing can throw past this point
      // and leave a committed share behind the catch below.
      proxies.set(id, proxy);
      proxyOwner.set(proxy, rec);
      if (handle) relayHandles.set(id, handle);
      markDefault();
      rec.tunnel = tunnelRec;
      // A relay change (session up or lost, port bound, addresses changed)
      // re-points the share's URLs — only while this record still holds this
      // share. The QR follows the URL through cachedQrSvg's key; a new
      // advertised address joins the certificate's SAN.
      onRelayChange = () => {
        if (store.apps[id] !== rec || rec.tunnel !== tunnelRec) return;
        const missing = hostRelay.addresses().filter((ip) => !sanIps.has(ip));
        if (useTls && missing.length) {
          for (const ip of missing) sanIps.add(ip);
          proxy.setTls(makeCert());
        }
        Object.assign(rec.tunnel, reach());
        persist().catch((e) => console.error(`[appManager] ${id}: persisting a relay change failed — ${e.message}`));
      };
    } catch (e) {
      // Any throw before the commit — the abandon path included — closes what
      // this share started: its proxy and its host-relay exposure.
      proxy?.close();
      handle?.close();
      throw e;
    }
    await persist();
    const { url, urls, relay, containerInternal } = rec.tunnel;
    const common = { kind: 'lan', url, urls, tls: useTls, proxyPort: proxy.port, fixedPortFallback, fixedPortHolder, relay, containerInternal };
    if (!auth) {
      // Nothing to authenticate — but a QR of the plain URL is still a
      // handy scan-to-open shortcut.
      return { ...common, auth: false, qrSvg: await cachedQrSvg(id, { url, authUrl: null }) };
    }
    const authUrl = withToken(url, proxy.token);
    return { ...common, auth: true, authUrl, username: proxy.username, password: proxy.password, passwordIsDefault: defaultPasswordShares.has(id), qrSvg: await cachedQrSvg(id, { url, authUrl }) };
  }

  if (mode === 'tailscale') {
    const blocker = funnelBlockedBy(id, funnelPort);
    if (blocker) {
      // No claim is made on this path, so this await races nothing — and
      // "tailscale isn't available" is the more actionable message when both
      // are true, so it is reported in preference to the 409.
      if (!(await tailscale.available())) throw tailscaleUnavailable();
      // Always another app's: shares of one app run one at a time (share()).
      const e = new Error(`'${blocker}' already has a tailscale share on Funnel port ${funnelPort} — unshare it, or share on another port`);
      e.statusCode = 409; throw e;
    }
    // Claim the port's slot SYNCHRONOUSLY — no await between the check above
    // and this line, so two concurrent requests for it cannot both get here.
    const prior = funnelSlots.get(funnelPort) ?? null; // null, or this app's own held slot (a re-share)
    funnelSlots.set(funnelPort, { id, pid: null, pending: true });
    let committed = false;
    try {
      if (!(await tailscale.available())) throw tailscaleUnavailable();
      // Replace any existing share. Its funnel, on this port or another, frees
      // its slot by pid as it is killed (see killShareChild).
      teardownShare(id, rec);

      // A funnel still shutting down holds its Funnel port until it is gone,
      // and tailscaled refuses a new funnel there meanwhile. Wait every such
      // funnel out rather than racing it.
      const expiring = [...expiringFunnelPids];
      await Promise.all(expiring.map((pid) => tailscale.waitForExit(pid)));
      for (const pid of expiring) expiringFunnelPids.delete(pid);

      // No `tls` option: tailscaled terminates TLS on-machine and forwards plain
      // HTTP here, exactly as cloudflared does (see authproxy.js).
      const proxy = await startAuthProxy(rec.port, credOpts(creds));
      let url, pid;
      try {
        ({ url, pid } = await tailscale.startFunnel(proxy.port, funnelPort));
      } catch (e) {
        proxy.close(); // don't leak the proxy if the funnel failed to come up
        throw e;
      }
      // This flight has been in the air for as long as the readiness backstop
      // allows, and `rec` is the record object captured before any of it. While
      // the slot was `pending` it carried NO pid, so killShareChild's pid match
      // could not protect it — meanwhile stop(), list()'s prune and start() are
      // all free to drop or replace store.apps[id]. Writing on regardless would
      // attach a LIVE public funnel to an object the store no longer holds:
      // referenced by nothing, so unshare/stop cannot reach it, never persisted
      // so a restart loses it entirely, and — being alive — never reaped by
      // funnelBlockedBy, which would 409 every future share on its port.
      if (!committable()) {
        tailscale.stopFunnel(pid);
        expiringFunnelPids.add(pid);
        proxy.close();
        throw abandoned(id, op);
      }
      proxies.set(id, proxy);
      proxyOwner.set(proxy, rec);
      markDefault();
      rec.tunnel = { kind: 'tailscale', url, pid, proxyPort: proxy.port, auth: true, funnelPort };
      funnelSlots.set(funnelPort, { id, pid, pending: false });
      // Past this point the funnel is up and recorded, so the slot names
      // reality: a later failure (persist, QR render) must NOT hand it back.
      committed = true;
      await persist();

      const authUrl = withToken(url, proxy.token);
      return { kind: 'tailscale', url, funnelPort, auth: true, authUrl, username: proxy.username, password: proxy.password, passwordIsDefault: defaultPasswordShares.has(id), qrSvg: await cachedQrSvg(id, { url, authUrl }) };
    } catch (e) {
      // Hand the slot back to whoever held it, if their funnel survived this
      // attempt: a refusal thrown BEFORE teardownShare (an unavailable daemon)
      // leaves the previous share fully intact, and freeing the slot there
      // would let another app start a competing funnel in front of it. If the
      // old funnel is gone — torn down above, or it was never there — free it.
      // Once `committed`, neither applies: THIS flight's funnel is live and
      // recorded, so the slot already names reality and must be left alone.
      // Only this port's slot is touched: a slot this app holds on another
      // port is released by its own funnel's teardown, or not at all.
      if (!committed) {
        if (prior && !prior.pending && state.pidAlive(prior.pid)) funnelSlots.set(funnelPort, prior);
        else funnelSlots.delete(funnelPort);
      }
      throw e;
    }
  }

  if (!(await tunnel.available())) {
    const e = new Error('cloudflared is not installed — install it to share via a public URL');
    e.statusCode = 501; throw e;
  }
  teardownShare(id, rec); // replace any existing share

  const proxy = await startAuthProxy(rec.port, credOpts(creds));
  let url, pid;
  try {
    ({ url, pid } = await tunnel.startTunnel(proxy.port));
  } catch (e) {
    proxy.close(); // don't leak the proxy if the tunnel failed to come up
    throw e;
  }
  if (!committable()) {
    tunnel.stopTunnel(pid);
    proxy.close();
    throw abandoned(id, op);
  }
  proxies.set(id, proxy);
  proxyOwner.set(proxy, rec);
  markDefault();
  rec.tunnel = { kind: 'tunnel', url, pid, proxyPort: proxy.port, auth: true };
  await persist();

  const authUrl = withToken(url, proxy.token);
  return { kind: 'tunnel', url, auth: true, authUrl, username: proxy.username, password: proxy.password, passwordIsDefault: defaultPasswordShares.has(id), qrSvg: await cachedQrSvg(id, { url, authUrl }) };
}

// Edit the active share's Basic-Auth credentials in place — mutates the live
// proxy (see authproxy.js's setCredentials), so the share URL/token/proxy
// port never change. Custom creds are per-share-instance only and never touch
// the app's stored default login (app-settings.json): share() always tears
// down and recreates the proxy, so the next share starts again from the app's
// default login if one is set, else 'hub' + an auto-generated password. A
// password edit ends `passwordIsDefault` for this share.
export async function updateShareCredentials(id, { username, password } = {}) {
  const proxy = proxies.get(id);
  if (!proxy) { const e = new Error(`'${id}' has no active share`); e.statusCode = 409; throw e; }
  if (!proxy.auth) {
    const e = new Error(`share for '${id}' has authentication disabled — nothing to edit`); e.statusCode = 400; throw e;
  }
  const hasUsername = username !== undefined;
  const hasPassword = password !== undefined;
  if (!hasUsername && !hasPassword) {
    const e = new Error('provide username and/or password to update'); e.statusCode = 400; throw e;
  }
  if (hasUsername && (typeof username !== 'string' || !username.trim())) {
    const e = new Error('username must be a non-empty string'); e.statusCode = 400; throw e;
  }
  if (hasPassword && (typeof password !== 'string' || !password.trim())) {
    const e = new Error('password must be a non-empty string'); e.statusCode = 400; throw e;
  }
  proxy.setCredentials({ username: hasUsername ? username.trim() : undefined, password: hasPassword ? password.trim() : undefined });
  if (hasPassword) defaultPasswordShares.delete(id);
  // The QR encodes the token URL, which is stable across a creds edit (the
  // token/proxy/URL are untouched), so this is a cache hit — but the field is
  // still returned so the caller can fold it back into its share state on the
  // same shape as the auth-toggle response. `auth` is guaranteed true here
  // (guarded above), so the token URL always exists.
  const url = store.apps[id].tunnel.url;
  const authUrl = withToken(url, proxy.token);
  return {
    id, username: proxy.username, password: proxy.password,
    passwordIsDefault: defaultPasswordShares.has(id),
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

// Also cancels a share of the current record still in flight: it would
// otherwise commit right after this answered, leaving the app shared.
export async function unshare(id) {
  const rec = store.apps[id];
  const inFlight = sharing.get(id);
  if (rec && inFlight?.rec === rec) inFlight.cancelled = true;
  if (rec?.tunnel || proxies.has(id)) { teardownShare(id, rec); await persist(); }
  return { id, tunnel: null };
}

// An app's stored settings (see appSettings.js). Get/set 404 an id code-hub
// doesn't know; clear never does, so an entry orphaned by a removed app can
// still be deleted. Whether an id is a worktree comes from discovery (else its
// running record, for a source-removed app) — never from the id's shape.
async function appKind(id) {
  if (isHostConductorId(id)) return { hostConductor: true, isWorktree: false };
  const app = (await discoverApps()).find((a) => a.id === id);
  if (app) return { hostConductor: false, isWorktree: app.isWorktree };
  if (Object.hasOwn(store.apps, id)) return { hostConductor: false, isWorktree: !!store.apps[id].isWorktree };
  const e = new Error(`unknown app '${id}'`); e.statusCode = 404; throw e;
}

export async function getAppSettings(id) {
  await appKind(id);
  return { id, ...appSettings.describe((await appSettings.readAll())[id]) };
}

// Auto-start, auto-share and a fixed port act on a project's main checkout
// only: enabling any of them for a worktree is refused, and so is enabling
// auto-start or a port for the host conductor (always on, code-hub never starts
// it; its auto-share applies, see autoShareAlwaysOn). A refused body writes
// nothing. Clearing them is always allowed, so a hand-edited entry can be
// cleaned up.
export async function setAppSettings(id, body) {
  const kind = await appKind(id);
  const isObject = !!body && typeof body === 'object';
  const enablesAutoStart = isObject && body.autoStart === true;
  const enablesAutoShare = isObject && body.autoShare !== undefined && body.autoShare !== null;
  const enablesPort = isObject && body.port !== undefined && body.port !== null;
  if (kind.isWorktree && (enablesAutoStart || enablesAutoShare || enablesPort)) {
    const e = new Error(`auto-start, auto-share and a fixed port apply only to a project's main checkout — '${id}' is a worktree`);
    e.statusCode = 400; throw e;
  }
  if (kind.hostConductor && (enablesAutoStart || enablesPort)) {
    const e = new Error(`auto-start and a fixed port don't apply to '${id}' — it is the host code-conductor, which is always on (auto-share does apply)`);
    e.statusCode = 400; throw e;
  }
  return { id, ...(await appSettings.update(id, body)) };
}

// The hub-wide settings (see hubSettings.js), applied to the forwarders at once.
export async function setHubSettings(body) {
  await hubSettings.update(body);
  syncExposures();
  return hubSettings.get();
}

export async function clearAppSettings(id) {
  await appSettings.clear(id);
  return { id, ...appSettings.describe(undefined) };
}

// Test seams: teardownShare itself, for its record-scoping, and the stored
// record it scopes to (start() answers with a view of it, not the record).
export { teardownShare as _teardownShare };
export function _record(id) { return store.apps[id]; }

// Long-poll for a client: resolves when `id`'s start transition (readiness,
// plus its auto-share) has finished, or at autoRun's cap.
export function awaitSettled(id) {
  return autoRun.awaitSettled(id);
}

// Boot auto-start: every discovered main checkout ticked for it that isn't
// already running (an adopted app is left alone). Called once code-hub is
// listening, after init(). An app whose manifest is broken stays a candidate,
// so its refusal is recorded and shows on its card.
export async function autoStartAll() {
  const settings = await appSettings.readAll();
  const ids = (await discoverApps())
    .filter((a) => !a.isWorktree && !isHostConductorId(a.id) && settings[a.id]?.autoStart === true)
    .filter((a) => !(Object.hasOwn(store.apps, a.id) && state.pidAlive(store.apps[a.id].pid)))
    .map((a) => a.id);
  return autoRun.bootAutoStart(ids, start);
}

async function hasManifestFile(dir) {
  try {
    await fs.access(path.join(dir, MANIFEST_FILENAME));
    return true;
  } catch {
    return false;
  }
}

// Register a project dir or worktree checkout that has no `.hub.json` of its
// own as a startable app, by writing an entry into registrations.json (see
// projects.js). A dir that already has a `.hub.json` — even a broken one —
// needs no registration and is rejected outright; it always wins over any
// registry entry.
export async function registerApp({ id, start, name, healthPath, readyWhen, port, routes } = {}) {
  if (typeof id !== 'string' || id.length === 0 || id.startsWith('.') || path.basename(id) !== id) {
    const e = new Error('id is required and must be a plain, non-dot-prefixed directory basename (no path separators)'); e.statusCode = 400; throw e;
  }
  const dir = await appDir(id);
  if (!dir) {
    // A qualified id can only ever name a worktree — `:` is reserved, so it
    // is never resolved against the projects root even when a directory of
    // that exact name sits there. Saying "not an existing directory" would be
    // false in that case, so name the rule instead; deciding it from the id's
    // shape alone also keeps a `:`-bearing id off every filesystem path.
    const e = new Error(isWorktreeId(id)
      ? `'${id}' matches no worktree under the projects root — '${WORKTREE_ID_QUALIFIER}' is reserved for worktree ids (<project>:<key>), so an id containing one never names a project directory`
      : `'${id}' is not an existing directory under the projects root`);
    e.statusCode = 400; throw e;
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
