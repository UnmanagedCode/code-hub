# Protocol: `.hub.json` manifest + HTTP API

## `.hub.json` (project root)

| Field | Type | Required | Meaning |
|---|---|---|---|
| `start` | string | **yes** | Blocking foreground command. Must bind `$PORT` and stay up until killed. Run via `bash -lc` in its own process group with `env.PORT` set to an allocated free port. |
| `name` | string | no | Display name (default: directory basename). |
| `healthPath` | string | no | HTTP path polled for readiness; any HTTP response = ready. |
| `readyWhen` | string | no | Regex matched against the child's stdout/stderr to detect readiness. |

Readiness precedence: `readyWhen` → `healthPath` → default TCP connect probe on `$PORT`. 30s timeout; on timeout the app stays running, flagged readiness-unconfirmed. Validation rejects missing/empty `start`, non-string optionals, and malformed JSON — loudly, naming the offending file. A broken manifest surfaces as a non-startable app (with `error`), not a hidden one.

There is **no `stop` command**: code-hub owns the lifecycle and stops an app by killing the tracked process group (SIGTERM, then SIGKILL after a 3s grace period).

## HTTP API (`/api`, JSON)

| Method + path | Body | Response |
|---|---|---|
| `GET /api/apps` | — | `{ cloudflaredAvailable, apps: [App] }` |
| `POST /api/apps/:id/start` | — | running record |
| `POST /api/apps/:id/stop` | — | `{ id, status: "stopped" }` |
| `POST /api/apps/:id/restart` | — | running record |
| `POST /api/apps/:id/share` | — | `{ url, qrSvg }` (or `501` if cloudflared absent) |
| `DELETE /api/apps/:id/share` | — | `{ id, tunnel: null }` |

`id` is the served directory basename (unique across the projects root; a worktree's id is its `<project>_worktree_<hash>` dir name).

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
  "outOfDate": true,           // startedSha !== currentSha
  "sourceMissing": false,      // running but source dir deleted
  "tunnel": { "url": "https://x.trycloudflare.com" },  // or null
  "error": null                // crash tail / manifest error, when present
}
```

### Errors

Non-2xx responses are `{ error: string }`. Status codes: `400` (bad manifest), `404` (unknown/not-running app), `409` (already running / not running for share), `501` (cloudflared not installed), `500` (unexpected).
