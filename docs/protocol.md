# Protocol: `.hub.json` manifest + HTTP API

## `.hub.json` (project root)

| Field | Type | Required | Meaning |
|---|---|---|---|
| `start` | string | **yes** | Blocking foreground command. Must bind `$PORT` and stay up until killed. Run via `bash -lc` in its own process group with `env.PORT` set to an allocated free port. |
| `name` | string | no | Display name (default: directory basename). |
| `healthPath` | string | no | HTTP path polled for readiness; any HTTP response = ready. |
| `readyWhen` | string | no | Regex matched against the child's stdout/stderr to detect readiness. |
| `routes` | array | no | Named URLs the app serves. Non-empty array of `{ name, path }`; `name` a non-empty string, `path` a string starting with `/`. When absent, a single implicit route at `/` is used. |

Readiness precedence: `readyWhen` → `healthPath` → default TCP connect probe on `$PORT`. 30s timeout; on timeout the app stays running, flagged readiness-unconfirmed. Validation rejects missing/empty `start`, non-string optionals, a `routes` value that isn't a non-empty array, and any route entry missing `name` or with a `path` not starting with `/` — loudly, naming the offending file (e.g. `routes[1].path is required and must start with "/"`). A broken manifest surfaces as a non-startable app (with `error`), not a hidden one.

There is **no `stop` command**: code-hub owns the lifecycle and stops an app by killing the tracked process group (SIGTERM, then SIGKILL after a 3s grace period).

## HTTP API (`/api`, JSON)

| Method + path | Body | Response |
|---|---|---|
| `GET /api/apps` | — | `{ cloudflaredAvailable, apps: [App] }` |
| `POST /api/apps/:id/start` | — | running record |
| `POST /api/apps/:id/stop` | — | `{ id, status: "stopped" }` |
| `POST /api/apps/:id/restart` | — | running record |
| `POST /api/apps/:id/share` | — | `{ url, authUrl, username, password, qrSvg }` (or `501` if cloudflared absent) |
| `DELETE /api/apps/:id/share` | — | `{ id, tunnel: null }` |

`id` is the served directory basename (unique across the projects root; a worktree's id is its `<project>_worktree_<hash>` dir name).

**Shares are Basic-Auth protected.** `share` stands up a local reverse proxy (fresh free port, loopback-only) enforcing HTTP Basic Auth — username `hub` + a CSPRNG password generated per share — and points cloudflared at the proxy instead of the app. The proxy forwards authenticated HTTP **and WebSocket upgrades** to `http://localhost:<appPort>`. Response fields: `url` (clean public URL), `authUrl` = `https://<user>:<pass>@<host>` (**the QR encodes this** for scan-to-auth), `username`, `password` (returned once — **in-memory only, never persisted or logged**), `qrSvg`. Torn down on `unshare`/`stop`/`restart`. A share does **not** survive a code-hub restart: on startup any orphaned tunnel is torn down (its in-process proxy is gone) and the app needs re-sharing.

### `App` shape (from `GET /api/apps`)

```jsonc
{
  "id": "myapp",
  "project": "myapp",          // parent project (worktrees map to their parent)
  "name": "My App",
  "path": "/abs/path",
  "isWorktree": false,
  "branch": null,              // worktree branch, else null
  "status": "stopped",         // stopped | starting | ready | running | crashed
  "port": 41051,               // when running
  "urls": ["http://localhost:41051", "..."],
  "startedSha": "48c5d4d…",    // git HEAD captured at start
  "currentSha": "6d89eda…",    // current git HEAD of the source dir
  "lastCommitAt": "2026-07-05T18:38:00+01:00", // ISO-8601 date of the source dir's last commit; null if non-git / no commits
  "outOfDate": true,           // startedSha !== currentSha
  "sourceMissing": false,      // running but source dir deleted
  "routes": [                  // manifest routes, else one implicit `/`; urls filled only when running
    { "name": "Main game", "path": "/", "urls": ["http://localhost:41051", "..."] },
    { "name": "Terrain editor", "path": "/terrain-editor.html", "urls": ["http://localhost:41051/terrain-editor.html", "..."] }
  ],
  "tunnel": { "url": "https://x.trycloudflare.com", "username": "hub", "proxyPort": 51234 },  // or null; password never exposed here
  "error": null                // crash tail / manifest error, when present
}
```

`urls` (top level) stays the list of base URLs (loopback + LAN IPs, no path). Each `routes[].urls` is those bases with the route `path` appended (`/` keeps the clean base form); populated only while the app is running.

### Errors

Non-2xx responses are `{ error: string }`. Status codes: `400` (bad manifest), `404` (unknown/not-running app), `409` (already running / not running for share), `501` (cloudflared not installed), `500` (unexpected).
