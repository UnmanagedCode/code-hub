# code-hub

A **mobile-first webapp** for launching, monitoring, stopping, and sharing the other webapps in your `~/cc-projects/` workspace — from your phone. Sibling to `code-conductor`; same stack (Node + Express, vanilla ES-module frontend, no build step).

## What it does

- **Discovers** every sibling project that declares a `.hub.json` manifest (plus their `code-conductor` worktrees). A sibling dir with no `.hub.json` can still be made startable via **machine-local registration** — see below. A worktree with no manifest/registration of its own inherits its parent project's, so worktrees of a registration-only project (e.g. the embedded host `code-conductor`) still show up.
- **Starts** an app: runs its `start` command as a child process with a free `PORT` injected, and shows every URL that serves it (localhost + LAN IPs) so you can open it from the phone. Apps can declare multiple named `routes` (e.g. a main page + an editor), each opened separately.
- **Sorts by recency**: a flat card list sorted by **Last edited** (each app's last git commit date, shown as an "edited X ago" label), Name, or Status.
- **Owns the lifecycle**: code-hub tracks the child's pid/process-group, so **Stop / Restart** work by killing that group — even if the project's source or worktree has since been deleted.
- **Out-of-date detection**: records the project's git HEAD at launch; flags a running app when HEAD has since moved and offers a one-tap **Restart**.
- **Worktree versions**: serves a project's `code-conductor` worktrees (`<project>_worktree_<hash>`) — nested under the parent project's card behind an **expandable "N worktrees ▾" toggle** (collapsed by default), each independently launchable.
- **Share via cloudflared tunnel or LAN, token-protected**: exposes a running app behind a local auth proxy (WebSocket-aware, so socket.io apps work). The share link (and its QR code) carries a one-time token, not credentials — opening it exchanges the token for an httpOnly session cookie via a redirect, so the shared app's own relative `fetch()` calls keep working (a URL with embedded credentials breaks those in Chromium). Two modes: a **cloudflared quick tunnel** (public `*.trycloudflare.com` URL, TLS terminated by Cloudflare) or a **LAN share** (proxy bound to `0.0.0.0`, reachable from any device on the local network, plain HTTP — no `cloudflared` required). Also shows a username + password as a fallback for curl/API clients that can't hold cookies; both are editable live from the UI and persist (server-side, in memory) for as long as the share stays up, so a page refresh doesn't lose them. LAN mode is always available even when `cloudflared` isn't installed, and can optionally **disable authentication entirely** (a per-share checkbox) — the proxy then forwards every request/upgrade with no gate at all, and the share URL carries no token or credentials.

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

## Machine-local registration (no `.hub.json` needed)

For a sibling dir you don't want to (or can't) add a `.hub.json` to, register it instead: `<projectsRoot>/.code-hub/registrations.json` is a hand-editable JSON object keyed by directory basename (the same `id` a real `.hub.json` would use), each value the same shape as a `.hub.json` body (`start` required; `name`/`healthPath`/`readyWhen`/`routes` optional). It's consulted only for a dir that has **no** `.hub.json` of its own — a real manifest, even a broken one, always wins over a registration. Two MCP tools manage it: `register_app` (`{ id, start, name?, healthPath?, readyWhen? }` — `routes` isn't expressible in the tool's schema, add it by hand-editing the file directly) and `unregister_app` (`{ id }`). Apps sourced from the registry are otherwise identical to manifest-based ones (worktree classification, discovery, start/stop all behave the same). See `docs/protocol.md` for the full schema and precedence rules.

## Key defaults

| Setting | Default | Override |
|---|---|---|
| UI port | `7000` | `PORT` |
| UI host | `127.0.0.1` | `HOST` |
| Projects root | parent dir of this repo | `PROJECTS_ROOT` (the conductor injects this when embedded, so the hub scans the conductor's own root) |
| cloudflared binary | `cloudflared` (from `PATH`) | `CODEHUB_CLOUDFLARED_BIN` |
| LAN share TLS | on (HTTPS, self-signed) | Toggle per share from the **Edit** form (`TLS (HTTPS)`); `POST /apps/:id/share` accepts `tls?: boolean` (default on) |
| Runtime state | `<projectsRoot>/.code-hub/state.json` | — |
| Machine-local registrations | `<projectsRoot>/.code-hub/registrations.json` | — |

## Trust model & limitations

- **Single-user, local, no auth, no DB.** code-hub runs the `start` command of any discovered `.hub.json` — treat the workspace as trusted code you own. Don't expose the code-hub UI itself to untrusted networks.
- code-hub only **reads** other projects and **runs their `start` command**; it never edits them.
- Sharing is **gated by default** in both modes: opening the share link exchanges a one-time token (in the URL) for an httpOnly `hub_auth` session cookie, so the shared document's own URL never carries credentials. HTTP Basic Auth (username `hub` + a per-share random password, both editable live from the UI) remains available as a fallback for curl/API clients that can't hold cookies. **Tunnel mode**: TLS is terminated by Cloudflare, so the token exchange, cookie, and any Basic Auth are encrypted in transit; authentication cannot be disabled for a tunnel share. **LAN mode**: **TLS is on by default** — the proxy serves HTTPS with a per-share self-signed certificate (kept in memory only), so the token/cookie/Basic-Auth are encrypted on the LAN hop, and the session cookie is marked `Secure`. Because the cert is self-signed, browsers show a one-time "connection is not private" warning to click through (no public CA can vouch for a LAN IP) — this is the expected first-visit UX. TLS can be turned off (falling back to **cleartext** plain HTTP) from the **Edit** form's **TLS (HTTPS)** toggle, or a per-share `tls: false`; only do that on a network you trust. Because http↔https can't switch on a live proxy, flipping the toggle **re-shares** the app — a fresh URL/QR and a reset password — unlike the authentication toggle, which flips the same share in place. A LAN share can also opt out of the gate entirely (a per-share checkbox) — no token, no cookie, no Basic Auth, every request/upgrade forwards straight through; only do this on a network you fully trust. Tokens/passwords live in server memory for the lifetime of the share (a page refresh re-reveals the password; nothing is written to disk) and a share does not survive a code-hub restart (re-share for a fresh URL).

## Running under code-conductor

code-hub is the first `code-conductor` plugin: `conductor.plugin.json` (repo root) declares its start command, `GET /api/health` liveness path, and an MCP endpoint (`POST /api/mcp`, tools `list_apps`/`start_app`/`stop_app`/`register_app`/`unregister_app`) that mirrors the HTTP API. Standalone use (`npm start`) is unaffected — the plugin manifest and MCP endpoint are inert unless a conductor calls them, and the `pluginBridge.js` script tag in `index.html` (served by the conductor when embedded) 404s harmlessly otherwise. See `docs/protocol.md` for the MCP contract.

When embedded, code-hub surfaces the host `code-conductor` checkout as an **always-on** app without needing a `.hub.json` of its own. It locates the checkout from the `CONDUCTOR_PROJECT_DIR` env var the conductor injects — so it shows up even when the conductor's own checkout lives **outside** the scanned `PROJECTS_ROOT` (a conductor with a custom root). Older conductors that don't inject `CONDUCTOR_PROJECT_DIR` fall back to discovering a `code-conductor/` dir under the root via an **internal, process-lifetime-only registration** (never persisted, not exposed via `register_app`). Running code-hub standalone (no `CONDUCTOR_*` env vars), `code-conductor` doesn't show up at all unless separately given a `.hub.json` or a machine-local registration.

## Testing

```sh
npm test                   # node:test suite (no network, uses fakes)
RUN_REAL_CLOUDFLARED=1 npm test   # also runs the real-cloudflared smoke test
```

## Docs

- `docs/features.md` — UI and user-facing features
- `docs/protocol.md` — `.hub.json` schema + HTTP API
- `docs/architecture.md` — modules, process/state lifecycle, test patterns
