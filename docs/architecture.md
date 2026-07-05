# Architecture

Node + Express backend, vanilla ES-module frontend, no build step. `"type": "module"`, Node 22. Dependencies: `express`, `qrcode`.

## Modules (one responsibility each)

| File | Responsibility |
|---|---|
| `server.js` | Bootstrap: build Express app, mount `/api` + `express.static('public')`, `listenWithRetry` (EADDRINUSE poll), run startup reconciliation once. Port `PORT` (7000), host `HOST` (127.0.0.1). |
| `src/projects.js` | Discovery. `projectsRoot()` = `PROJECTS_ROOT` ?? parent-of-repo. Scans siblings for `.hub.json`; classifies `<project>_worktree_<hash>` dirs as worktrees. Reads + validates the manifest. |
| `src/state.js` | Persists running-apps to `<projectsRoot>/.code-hub/state.json` (atomic tmp→rename). `reconcile()` probes each pid (`kill -0`): adopts live, drops dead, clears dead tunnels. Corrupt state file is moved aside. |
| `src/net.js` | Free-port allocation, URL enumeration (loopback + non-internal IPv4), TCP readiness probe. |
| `src/git.js` | `headSha` / `currentBranch` via `execFile` (manual promisify — Termux Node lacks `promisify.custom` on `execFile`). |
| `src/runner.js` | Process lifecycle. Spawns `bash -lc <start>` **detached** (own group, pgid === pid) with `PORT`. Readiness orchestration, per-app 16KB output ring for crash tails, `stop` = SIGTERM→SIGKILL on the process group. |
| `src/tunnel.js` | cloudflared detection (`--version`, bin from `CODEHUB_CLOUDFLARED_BIN`) + quick-tunnel spawn, capturing the `*.trycloudflare.com` URL (30s timeout). |
| `src/qr.js` | `qrcode` → inline SVG string (async). |
| `src/appManager.js` | **Single source of truth.** Composes discovery ∪ running-state; exposes `init/list/start/stop/restart/share/unshare`; keeps `state.js` in sync. |
| `src/routes.js` | Thin Express router over `appManager`. |
| `public/` | `index.html`, `styles.css`, `app.js` (`el()` helper + 2s poll), `manifest.webmanifest`, `icon.svg`. |

## Process & state lifecycle

- **App identity** = served directory basename. A running record holds `{ id, project, path, isWorktree, branch, pid, pgid, port, urls, startedSha, startedAt, tunnel }`.
- **Own process group**: children are spawned `detached`, so the child is its group leader and `pgid === pid`. Stop kills the whole group via `process.kill(-pgid, sig)` — this works even after the source dir is gone, because only the pgid is needed.
- **State outside project dirs**: state lives in code-hub's own `.code-hub/` at the projects root, so a running server survives (and remains stoppable) even if its source/worktree is deleted; such an app is flagged `sourceMissing`.
- **Startup reconciliation** (`appManager.init` → `state.reconcile`): live pids are **adopted** (shown `running`; we can't recapture their stdout, so no in-memory runtime — readiness is assumed), dead pids dropped, dead tunnels cleared. Detached children intentionally outlive a code-hub restart.
- **Readiness / status**: for apps started this process, `runner.runtime(id)` supplies `starting`/`ready`/`crashed`; adopted apps have no runtime and read as `running`. `list()` lazily prunes records whose pid has since died.
- **Out-of-date**: `outOfDate = startedSha && currentSha && startedSha !== currentSha`, computed live per `list()`.

## Testing

- Runner: `tests/run.mjs` drives `node:test` via its API (the device's node wrapper rejects `--test`); `*.test.mjs` files, process-isolated, concurrency = min(4, cores/2), 60s/file ceiling. `npm test`.
- Fakes injected via env, no network: `tests/fixtures/fake-app.mjs` (binds `$PORT`, prints a ready line, handles SIGTERM; `FAKE_APP_MODE=crash` exits immediately) and `tests/fixtures/fake-cloudflared.mjs` (prints a canned trycloudflare URL; injected via `CODEHUB_CLOUDFLARED_BIN`).
- Isolation: each test `mkdtemp`s a fresh `PROJECTS_ROOT`; short poll intervals with caps (no long real sleeps); assertions on killed/ready outcomes (`kill -0`).
- One real-dependency smoke test (`tests/smoke.real.test.mjs`) is gated behind `RUN_REAL_CLOUDFLARED=1`.

## Conventions & future changes

- State-file format changes get a one-shot idempotent migration at startup; application code assumes the current shape only (see the workspace migration guidelines).
- The `.hub.json` schema and the HTTP API have no external consumers — change the schema/API and its callers together rather than shimming old shapes.
