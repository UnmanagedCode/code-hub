# Architecture

Node + Express backend, vanilla ES-module frontend, no build step. `"type": "module"`, Node 22. Dependencies: `express`, `qrcode`.

## Modules (one responsibility each)

| File | Responsibility |
|---|---|
| `server.js` | Bootstrap: build Express app, mount `/api` + `express.static('public')`, `listenWithRetry` (EADDRINUSE poll), run startup reconciliation once. Port `PORT` (7000), host `HOST` (127.0.0.1). |
| `src/projects.js` | Discovery. `projectsRoot()` = `PROJECTS_ROOT` ?? parent-of-repo. Scans siblings for `.hub.json`; classifies `<project>_worktree_<hash>` dirs as worktrees. Reads + validates the manifest. |
| `src/state.js` | Persists running-apps to `<projectsRoot>/.code-hub/state.json` (atomic tmp→rename). `reconcile()` probes each pid (`kill -0`): adopts live, drops dead, clears dead tunnels. Corrupt state file is moved aside. |
| `src/net.js` | Free-port allocation, URL enumeration (`enumerateUrls` = loopback + non-internal IPv4 base URLs; `routeUrls` = those bases with a route path appended), TCP readiness probe. |
| `src/git.js` | `headSha` / `currentBranch` / `lastCommitAt` (`git log -1 --format=%cI`) via `execFile` (manual promisify — Termux Node lacks `promisify.custom` on `execFile`). |
| `src/runner.js` | Process lifecycle. Spawns `bash -lc <start>` **detached** (own group, pgid === pid) with `PORT`. Readiness orchestration, per-app 16KB output ring for crash tails, `stop` = SIGTERM→SIGKILL on the process group. If the child dies almost immediately with `EADDRINUSE` (the allocated port got claimed before bind), retries on a freshly allocated port, up to 3 times, before surfacing a crash. |
| `src/tunnel.js` | cloudflared detection (`--version`, bin from `CODEHUB_CLOUDFLARED_BIN`) + quick-tunnel spawn, capturing the `*.trycloudflare.com` URL (30s timeout). Now targets the **auth proxy** port, not the app port. |
| `src/authproxy.js` | In-process HTTP reverse proxy enforcing Basic Auth (`hub` + per-share CSPRNG password) on both requests **and WS upgrades** (`upgrade` → raw `net` socket pipe, `req.rawHeaders` replayed), forwarding to `localhost:<appPort>`. `startAuthProxy(targetPort)` → `{ port, username, password, close() }`. Loopback-only; hand-rolled (no proxy dep). |
| `src/qr.js` | `qrcode` → inline SVG string (async). |
| `src/appManager.js` | **Single source of truth.** Composes discovery ∪ running-state; exposes `init/list/start/stop/restart/share/unshare`; keeps `state.js` in sync. Holds the in-memory `proxies` map + `teardownShare`. |
| `src/routes.js` | Thin Express router over `appManager`. |
| `public/` | `index.html`, `styles.css`, `app.js` (`el()` helper, 2s poll, flat client-side sort, per-app hue accent bar, relative "edited" labels, **client-side worktree grouping** into expandable subcards), `manifest.webmanifest`, `icon.svg`. |

## Process & state lifecycle

- **App identity** = served directory basename. A running record holds `{ id, project, path, isWorktree, branch, pid, pgid, port, urls, startedSha, startedAt, tunnel }`.
- **Own process group**: children are spawned `detached`, so the child is its group leader and `pgid === pid`. Stop kills the whole group via `process.kill(-pgid, sig)` — this works even after the source dir is gone, because only the pgid is needed.
- **State outside project dirs**: state lives in code-hub's own `.code-hub/` at the projects root, so a running server survives (and remains stoppable) even if its source/worktree is deleted; such an app is flagged `sourceMissing`.
- **Startup reconciliation** (`appManager.init` → `state.reconcile`): live pids are **adopted** (shown `running`; we can't recapture their stdout, so no in-memory runtime — readiness is assumed), dead pids dropped, dead tunnels cleared. Detached children intentionally outlive a code-hub restart.
- **Readiness / status**: for apps started this process, `runner.runtime(id)` supplies `starting`/`ready`/`crashed`; adopted apps have no runtime and read as `running`. `list()` lazily prunes records whose pid has since died. A port race (`EADDRINUSE`) that persists past `runner.js`'s retry budget still ends up `crashed`, same as any other launch failure.
- **Out-of-date**: `outOfDate = startedSha && currentSha && startedSha !== currentSha`, computed live per `list()`.
- **Routes & last-edited**: `list()` also computes, per app, `lastCommitAt` (source dir's last commit date) and `routes` — the manifest's `routes` (or a single implicit `/` when absent), each with `urls` enumerated live from the running port via `routeUrls`. The top-level `urls` stays the base-URL list persisted at start.
- **Share auth lifecycle**: `share` starts an `authproxy` (in-memory handle in the `proxies` map, keyed by app id; password held only there), points cloudflared at the proxy port, and persists `tunnel = { url, pid, username, proxyPort }` (never the password). `teardownShare` closes the proxy + kills the tunnel on `unshare`/`stop`/`restart`. Because the proxy is in-process it **cannot** survive a code-hub restart, so `appManager.init` (after `state.reconcile`) tears down every persisted tunnel and clears it — the share simply needs recreating (a broken tunnel is never left running).
- **Worktree grouping is client-side**: the payload stays a flat `apps` array carrying `project`/`isWorktree`/`branch`; `public/app.js` `render()` nests worktrees under their parent's card (expand state in a `state.expanded` set, re-applied across polls).

## Testing

- Runner: `tests/run.mjs` drives `node:test` via its API (the device's node wrapper rejects `--test`); `*.test.mjs` files, process-isolated, concurrency = min(4, cores/2), 60s/file ceiling. `npm test`.
- Fakes injected via env, no network: `tests/fixtures/fake-app.mjs` (binds `$PORT`, prints a ready line, handles SIGTERM; `FAKE_APP_MODE=crash` exits immediately, `FAKE_APP_MODE=addrinuse` always fails as if `$PORT` were already bound) and `tests/fixtures/fake-cloudflared.mjs` (prints a canned trycloudflare URL; injected via `CODEHUB_CLOUDFLARED_BIN`).
- Isolation: each test `mkdtemp`s a fresh `PROJECTS_ROOT`; short poll intervals with caps (no long real sleeps); assertions on killed/ready outcomes (`kill -0`).
- `tests/authproxy.test.mjs` exercises the auth gate + HTTP forward + WS-upgrade pipe against an in-test raw upstream (no ws dependency): a raw `net` handshake proves 401 without/with-wrong creds and 101 + byte echo with correct creds.
- Real-dependency smoke tests (`tests/smoke.real.test.mjs`) are gated behind `RUN_REAL_CLOUDFLARED=1`: a raw quick-tunnel check, plus an end-to-end auth check (real tunnel → auth proxy returns 401 anonymous, 200 credentialed).

## Conventions & future changes

- State-file format changes get a one-shot idempotent migration at startup; application code assumes the current shape only (see the workspace migration guidelines).
- The `.hub.json` schema and the HTTP API have no external consumers — change the schema/API and its callers together rather than shimming old shapes.
