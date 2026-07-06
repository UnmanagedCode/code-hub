# code-hub

A **mobile-first webapp** for launching, monitoring, stopping, and sharing the other webapps in your `~/cc-projects/` workspace — from your phone. Sibling to `code-conductor`; same stack (Node + Express, vanilla ES-module frontend, no build step).

## What it does

- **Discovers** every sibling project that declares a `.hub.json` manifest (plus their `code-conductor` worktrees).
- **Starts** an app: runs its `start` command as a child process with a free `PORT` injected, and shows every URL that serves it (localhost + LAN IPs) so you can open it from the phone. Apps can declare multiple named `routes` (e.g. a main page + an editor), each opened separately.
- **Sorts by recency**: a flat card list sorted by **Last edited** (each app's last git commit date, shown as an "edited X ago" label), Name, or Status.
- **Owns the lifecycle**: code-hub tracks the child's pid/process-group, so **Stop / Restart** work by killing that group — even if the project's source or worktree has since been deleted.
- **Out-of-date detection**: records the project's git HEAD at launch; flags a running app when HEAD has since moved and offers a one-tap **Restart**.
- **Worktree versions**: serves a project's `code-conductor` worktrees (`<project>_worktree_<hash>`) — nested under the parent project's card behind an **expandable "N worktrees ▾" toggle** (collapsed by default), each independently launchable.
- **Share via cloudflared, password-protected**: exposes a running app through a cloudflared quick tunnel **behind HTTP Basic Auth** — a local auth proxy (WebSocket-aware, so socket.io apps work) sits between cloudflared and the app, using username `hub` + a strong password freshly generated per share. Shows the URL, credentials, and a **QR code** encoding the credentialed URL for scan-to-auth. Degrades gracefully when `cloudflared` isn't installed.

## Quick start

```sh
npm install
npm start                 # serves the UI on http://127.0.0.1:7000
```

Open the UI, and it lists every sibling project with a `.hub.json`. Override the port with `PORT`, the workspace scanned with `PROJECTS_ROOT`.

## The `.hub.json` manifest

Place a `.hub.json` at a project's root to make it servable:

```jsonc
{
  "start": "npm start",     // REQUIRED — a single blocking foreground command
  "name": "My App",         // optional display name (default: directory name)
  "healthPath": "/",        // optional HTTP path polled for readiness
  "readyWhen": "listening", // optional regex matched against stdout/stderr
  "routes": [               // optional named URLs the app serves (default: one implicit "/")
    { "name": "Main",   "path": "/" },
    { "name": "Editor", "path": "/editor.html" }
  ]
}
```

- `start` must **bind `$PORT`** (injected by code-hub — a free port) and **stay up until killed**. code-hub launches it via `bash -lc` in its own process group; there is no separate stop command — code-hub stops the app by killing that group (SIGTERM, then SIGKILL after a 3s grace period).
- **Readiness**: `readyWhen` (stdout/stderr regex) → else `healthPath` (any HTTP response) → else a default TCP connect probe on `$PORT`. Bounded to 30s; on timeout the app stays running but is flagged readiness-unconfirmed.

## Key defaults

| Setting | Default | Override |
|---|---|---|
| UI port | `7000` | `PORT` |
| UI host | `127.0.0.1` | `HOST` |
| Projects root | parent dir of this repo | `PROJECTS_ROOT` |
| cloudflared binary | `cloudflared` (from `PATH`) | `CODEHUB_CLOUDFLARED_BIN` |
| Runtime state | `<projectsRoot>/.code-hub/state.json` | — |

## Trust model & limitations

- **Single-user, local, no auth, no DB.** code-hub runs the `start` command of any discovered `.hub.json` — treat the workspace as trusted code you own. Don't expose the code-hub UI itself to untrusted networks.
- code-hub only **reads** other projects and **runs their `start` command**; it never edits them.
- Sharing publishes a running app to a public cloudflared URL, but **gated by HTTP Basic Auth** (username `hub` + a per-share random password); the link alone is not enough. TLS is terminated by Cloudflare, so credentials are encrypted in transit. Credentials are in-memory only and a share does not survive a code-hub restart (re-share for a fresh URL).

## Testing

```sh
npm test                   # node:test suite (no network, uses fakes)
RUN_REAL_CLOUDFLARED=1 npm test   # also runs the real-cloudflared smoke test
```

## Docs

- `docs/features.md` — UI and user-facing features
- `docs/protocol.md` — `.hub.json` schema + HTTP API
- `docs/architecture.md` — modules, process/state lifecycle, test patterns
