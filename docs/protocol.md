# Protocol: `.hub.json` manifest + HTTP API

## `.hub.json` (project root)

| Field | Type | Required | Meaning |
|---|---|---|---|
| `start` | string | **yes** | Blocking foreground command. Must bind `$PORT` and stay up until killed. Run via `bash -lc` in its own process group with `env.PORT` set to an allocated free port. |
| `name` | string | no | Display name (default: directory basename). |
| `healthPath` | string | no | HTTP path polled for readiness; any HTTP response = ready. |
| `readyWhen` | string | no | Regex matched against the child's stdout/stderr to detect readiness. |
| `routes` | array | no | Named URLs the app serves. Non-empty array of `{ name, path }`; `name` a non-empty string, `path` a string starting with `/`. When absent, a single implicit route at `/` is used. |

Readiness precedence: `readyWhen` → `healthPath` → default TCP connect probe on `$PORT`. 30s timeout; on timeout the app stays running, flagged readiness-unconfirmed. Validation rejects missing/empty `start`, non-string optionals, a `routes` value that isn't a non-empty array, and any route entry missing `name` or with a `path` not starting with `/` — loudly, naming the offending file (e.g. `routes[1].path is required and must start with "/"`). A broken manifest surfaces as a non-startable app (with `manifestError`), not a hidden one.

There is **no `stop` command**: code-hub owns the lifecycle and stops an app by killing the tracked process group (SIGTERM, then SIGKILL after a 3s grace period).

## Machine-local registration: `registrations.json` (`<projectsRoot>/.code-hub/registrations.json`)

A JSON object keyed by directory basename (`id`), each value the same shape as a `.hub.json` body above (validated with the identical schema — `start` required, `name`/`healthPath`/`readyWhen`/`routes` optional). Fills in a manifest for a sibling dir that has **no** `.hub.json` of its own; a real `.hub.json`, even a broken one, always wins over a registration for the same id. Managed via the `register_app`/`unregister_app` MCP tools below, or by hand-editing the file directly (needed for `routes`, since it isn't expressible in `register_app`'s tool schema).

Robustness, mirroring `.hub.json`/`state.json` conventions: whole-file JSON that fails to parse, or isn't a JSON object, is logged (`console.warn`) and treated as an empty registry — it never hides real `.hub.json` apps. A per-entry validation failure (e.g. missing `start`) surfaces that one app as non-startable with `manifestError`, exactly like a broken `.hub.json` does. A registry entry naming a directory that doesn't exist under the projects root is logged and skipped — no phantom app.

## In-memory registration (process-lifetime only, never persisted)

Same schema/validation as `registrations.json`, but held in a module-level `Map` (`registerInMemory`/`unregisterInMemory` in `src/projects.js`) instead of on disk — it is never read from or written to `registrations.json`. Precedence for a dir with no `.hub.json`: in-memory wins over a disk registry entry for the same id; a real `.hub.json` still wins over either. Apps sourced this way carry `source: "memory"`. Not exposed via `register_app`/`unregister_app` — those tools remain disk-only. Currently used for exactly one purpose: `appManager.init()` registers the host `code-conductor` checkout this way when code-hub runs embedded (see `docs/architecture.md`), since the conductor carries no `.hub.json` of its own.

## Worktree manifest inheritance

A worktree dir (`<project>_worktree_<hash>`, with a sibling `<project>` dir) is resolved with the same precedence as any other dir — its own `.hub.json`, then its own in-memory registration, then its own disk registration — all keyed by the worktree's own full directory name. Only when none of those exist for the worktree itself does it fall back to its **parent** project's manifest, resolved with that same precedence (parent's `.hub.json` → parent's in-memory registration → parent's disk registration), inheriting the parent's `source`. This is what lets worktrees of an in-memory-registered project (e.g. the host `code-conductor` when code-hub runs embedded, see `docs/architecture.md`) surface at all, since such a project has no `.hub.json` for git to carry into the worktree checkout. If the parent itself has no manifest source, or its own manifest source is broken, the worktree is not inherited into and is skipped entirely — a broken parent manifest never surfaces as an error on the worktree, and never fails discovery.

## HTTP API (`/api`, JSON)

| Method + path | Body | Response |
|---|---|---|
| `GET /api/health` | — | `{ ok: true }` — cheap liveness probe, independent of `appManager` |
| `GET /api/apps` | — | `{ cloudflaredAvailable, apps: [App] }` |
| `POST /api/apps/:id/start` | — | running record |
| `POST /api/apps/:id/stop` | — | `{ id, status: "stopped" }` |
| `POST /api/apps/:id/restart` | — | running record |
| `POST /api/apps/:id/share` | `{ mode?: "tunnel"\|"lan", auth?: boolean, tls?: boolean }` (default `"tunnel"`, `auth` default `true`; `tls` LAN-only, default `true` = on) | `{ kind, url, urls?, auth, tls?, authUrl?, username?, password?, qrSvg }` (`400` bad mode/`auth`/`tls` type, or `auth:false` with `mode:"tunnel"`; `409` not running; `501` `tunnel` mode when cloudflared absent) |
| `PATCH /api/apps/:id/share/credentials` | `{ username?, password? }` (at least one) | `{ id, username, password, qrSvg }` (`qrSvg` regenerated — a cache hit, since the token-URL QR is stable across a creds edit; `400` bad/missing body, or the active share has `auth:false`; `409` no active share) |
| `PATCH /api/apps/:id/share/auth` | `{ enabled: boolean }` | `{ id, auth, qrSvg }` (`qrSvg` tracks the gate — token URL when enabling, plain URL when disabling; `400` non-boolean `enabled`, or the active share is `mode:"tunnel"` — tunnel shares are always gated; `409` no active share) |
| `DELETE /api/apps/:id/share` | — | `{ id, tunnel: null }` |

`id` is the served directory basename (unique across the projects root; a worktree's id is its `<project>_worktree_<hash>` dir name).

**Shares are token/cookie protected by default, in either mode, with a Basic-Auth fallback.** `share` stands up a local reverse proxy (fresh free port). Opening the share URL exchanges a one-time `?__hubauth=<token>` query param for an httpOnly `hub_auth` session cookie (302 redirect, token stripped from the redirected URL); subsequent requests forward on that cookie. HTTP Basic Auth (username `hub` + a CSPRNG password, also generated per share) remains available for curl/API clients that can't retain cookies. Either path forwards authenticated HTTP **and WebSocket upgrades** (cookie or Basic only — no token handling on upgrades) to `http://localhost:<appPort>`.
- `mode: "tunnel"` (default): the proxy binds loopback-only and cloudflared points at it, publishing `https://<sub>.trycloudflare.com`. `501` if `cloudflared` isn't installed. `auth` cannot be `false` for this mode (`400`).
- `mode: "lan"`: the proxy binds `0.0.0.0` instead — no cloudflared involved. `url` is the machine's first non-loopback LAN IPv4 URL (falls back to a `localhost` URL if the host has no LAN interface); `urls` lists every LAN IPv4 URL found (secondary devices can try an alternate if the primary is unreachable, e.g. a Docker bridge address). **TLS is on by default** (`tls` defaults to `true`, overridable per share): the proxy serves HTTPS with a per-share self-signed cert (SAN covers the LAN IPv4s + `127.0.0.1`/`localhost`; generated in memory only), URLs are `https://`, and the session cookie is marked `Secure`. Browsers show a one-time self-signed warning. `tls: false` serves plain HTTP (`http://`, no `Secure` cookie), and the token/cookie/Basic-Auth then cross the LAN in cleartext. Passing `auth: false` drops the gate entirely: no token/cookie/Basic-Auth is generated or checked, every request and WebSocket upgrade forwards unconditionally, and the response has no `authUrl`/`username`/`password` (`url` itself is the whole share link).

Response fields: `kind` (`"tunnel"` or `"lan"`), `url` (primary shareable URL), `urls` (LAN mode only — all candidate URLs), `auth` (whether the share is gated), `tls` (LAN mode — whether the proxy serves HTTPS; scheme of `url`/`urls` follows it), `authUrl` = the share URL plus `?__hubauth=<token>` (**the QR encodes this** for scan-to-auth when `auth` is true; opening it sets the session cookie and redirects to the credential-free URL — no credentials ever appear in the URL or QR) — omitted when `auth` is `false`, `username`/`password` (Basic-Auth fallback for curl/API clients) — also omitted when `auth` is `false`, `qrSvg` (of `authUrl` when gated, else of the plain `url`). Credentials live in the server process for the share's lifetime — **never written to `state.json` or logged** — so `GET /api/apps`'s `tunnel.password` re-reveals them across a UI reload; the same call also re-serves `tunnel.authUrl` (rebuilt from the live proxy token) and `tunnel.qrSvg` (a per-app cached render, regenerated only on share/creds-edit/auth-toggle — not on every poll), so the QR and the Open magic-link survive a full UI refresh that wipes the client's in-memory share response. `PATCH .../share/credentials` edits the creds in place on the live proxy (no new URL/token). Torn down on `unshare`/`stop`/`restart`. A share does **not** survive a code-hub restart, in either mode: on startup any orphaned share record is cleared (its in-process proxy is gone) and the app needs re-sharing — the next share always starts with a fresh auto-generated password, even if the previous one was edited.

`PATCH .../share/auth` flips the gate on a **LAN** share in place — same proxy, port, token, username/password; a tunnel share rejects this with `400` (always gated). The underlying proxy pre-generates its password/token/cookie-secret regardless of the share's initial `auth` value, and never regenerates them on a toggle, so the token-bearing `authUrl` stays valid across an off→on round-trip. The **QR does change with the gate**: the response returns a regenerated `qrSvg` — the token URL when enabling, the plain URL when disabling — so a QR shown for a no-auth share isn't left stale (and 401-ing) once the gate turns on. `GET /api/apps`'s `tunnel.auth`/`tunnel.username`/`tunnel.password`/`tunnel.authUrl`/`tunnel.qrSvg` reflect the live state immediately after a toggle (no re-share needed).

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
  "tunnel": { "kind": "tunnel", "url": "https://x.trycloudflare.com", "urls": null, "auth": true, "tls": false, "authUrl": "https://x.trycloudflare.com/?__hubauth=…", "qrSvg": "<svg…>", "username": "hub", "password": "…", "proxyPort": 51234 },  // or null. kind: "lan" → urls lists all LAN IPv4 URLs and tls indicates HTTPS (https:// URLs) vs plain HTTP; tunnel is always tls:false on this hop (cloudflared terminates TLS). auth:false → username/password are null (no gate exists) and authUrl is omitted (qrSvg still present, of the plain url). authUrl/qrSvg/username/password all come from the live in-process proxy (never state.json) — authUrl is rebuilt from the proxy token and qrSvg is a per-app cached render (regenerated only on share/creds-edit/auth-toggle) — so they survive a UI reload and disappear once the share is torn down/restarted
  "error": null,                // crash tail for a crashed app, or the manifest error text for a stopped bad-manifest app; display-only, not the Start-disable signal
  "manifestError": null,        // manifest parse/validation error (the Start-disable signal), or null
  "alwaysOn": false,            // true only for the host code-conductor when code-hub runs embedded as its plugin
  "source": "manifest"          // "manifest" (has a .hub.json), "registry" (registrations.json), or "memory" (in-memory registration) — for a worktree with none of its own, reflects where its PARENT's manifest came from (see "Worktree manifest inheritance" above)
}
```

`urls` (top level) stays the list of base URLs (loopback + LAN IPs, no path). Each `routes[].urls` is those bases with the route `path` appended (`/` keeps the clean base form); populated only while the app is running.

**`alwaysOn`.** When code-hub runs embedded as a code-conductor plugin (`CONDUCTOR_PLUGIN_ID` + `CONDUCTOR_URL` env vars present — see `docs/architecture.md`), the main `code-conductor` checkout is reported `alwaysOn: true, status: "running"` with no real pid to track, and `POST /api/apps/code-conductor/start`, `.../stop`, and `.../restart` all reply `409`. `POST .../share` still works — it targets the port parsed from `CONDUCTOR_URL`. The checkout's `path` (and its git info) comes from the `CONDUCTOR_PROJECT_DIR` env var the conductor injects, which **may live outside the scanned `PROJECTS_ROOT`** — so the app surfaces even with a custom conductor root; older conductors that don't inject it fall back to discovering a `code-conductor/` dir under the root. This never applies to `code-conductor_worktree_*` dirs (always ordinary apps) or when running standalone — though such a worktree may still surface via manifest inheritance from the parent when the conductor's checkout is under the root (see "Worktree manifest inheritance").

### Errors

Non-2xx responses are `{ error: string }`. Status codes: `400` (bad manifest; an invalid `share` `mode`/`auth`/`tls`; `auth:false` with `mode:"tunnel"`; a credentials-edit body that's empty/non-string, or targets a no-auth share; a non-boolean `enabled` on an auth-toggle, or one targeting a `mode:"tunnel"` share), `404` (unknown/not-running app), `409` (already running / not running for share / no active share for a credentials edit or auth toggle), `501` (`tunnel`-mode share when cloudflared is absent), `500` (unexpected). **Exception: `POST /api/mcp`** replies `200` for every well-formed tool call, including tool-level failures — see below.

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
| `register_app` | `{ id: string, start: string, name?, healthPath?, readyWhen? }` | the registered app, in the same shape as an entry in `list_apps`'s `apps` (`source: "registry"`). `400` if `id` isn't an existing dir under the projects root, `409` if that dir already has a `.hub.json`, `400` on a schema violation (e.g. empty `start`). `routes` isn't in this tool's declared schema (array-of-object properties aren't expressible in the shallow-JSON-Schema `pluginApi` v1 constraint) but is still accepted/validated if passed in `arguments` — the schema simply doesn't advertise it; hand-edit `registrations.json` for multi-route registrations. |
| `unregister_app` | `{ id: string }` | `{ id, registered: false }`. `404` if `id` has no registry entry. No effect on a project with its own `.hub.json` (it was never in the registry). |
