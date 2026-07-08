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
| `GET /api/health` | — | `{ ok: true }` — cheap liveness probe, independent of `appManager` |
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
  "error": null,                // crash tail / manifest error, when present
  "alwaysOn": false             // true only for the host code-conductor when code-hub runs embedded as its plugin
}
```

`urls` (top level) stays the list of base URLs (loopback + LAN IPs, no path). Each `routes[].urls` is those bases with the route `path` appended (`/` keeps the clean base form); populated only while the app is running.

**`alwaysOn`.** When code-hub runs embedded as a code-conductor plugin (`CONDUCTOR_PLUGIN_ID` + `CONDUCTOR_URL` env vars present — see `docs/architecture.md`), the main `code-conductor` checkout is reported `alwaysOn: true, status: "running"` with no real pid to track, and `POST /api/apps/code-conductor/start`, `.../stop`, and `.../restart` all reply `409`. `POST .../share` still works — it targets the port parsed from `CONDUCTOR_URL`. This never applies to `code-conductor_worktree_*` dirs (always ordinary apps) or when running standalone.

### Errors

Non-2xx responses are `{ error: string }`. Status codes: `400` (bad manifest), `404` (unknown/not-running app), `409` (already running / not running for share), `501` (cloudflared not installed), `500` (unexpected). **Exception: `POST /api/mcp`** replies `200` for every well-formed tool call, including tool-level failures — see below.

## MCP API (`POST /api/mcp`)

code-hub is a code-conductor plugin (see `conductor.plugin.json` at the repo root) and exposes its app-management operations as MCP tools over one endpoint, reusing the same `appManager` logic as the HTTP API above — no duplicated behavior.

**Request:** `{ tool: string, arguments: object, caller: { sessionId, project } }`. `caller` is accepted but currently unused server-side — `appManager` has no per-project scoping, so `start_app`/`stop_app` are not restricted to the caller's own project.

**Response — status-code contract:**

| Condition | Status | Body |
|---|---|---|
| Malformed JSON body | `400` | `{ error }` |
| Missing/non-string/empty `tool` field | `400` | `{ error }` |
| Well-formed call, tool succeeds | `200` | `{ result: <any> }` |
| Well-formed call, tool fails (unknown tool, bad `arguments`, already-running, not-found, ...) | `200` | `{ error: string }` |

The split is deliberate: only a malformed *request envelope* is a transport failure. An unknown tool name, invalid arguments, or a tool throwing (e.g. "already running") are normal MCP outcomes for the calling LLM, so they stay `200` — the conductor can treat any non-200 as a hard transport error without special-casing tool-level failures.

**Tools** (declared in `conductor.plugin.json`'s `mcp.tools`, shallow JSON-Schema `inputSchema`s — no `$ref`/`oneOf`/`anyOf`/nested objects):

| Tool | Arguments | Result |
|---|---|---|
| `list_apps` | none | same as `GET /api/apps` |
| `start_app` | `{ id: string }` | same as `POST /api/apps/:id/start` |
| `stop_app` | `{ id: string }` | same as `POST /api/apps/:id/stop` |
