# code-hub

A **mobile-first webapp** for launching, monitoring, stopping, and sharing the other webapps in your `~/cc-projects/` workspace — from your phone. Sibling to `code-conductor`; same stack (Node + Express, vanilla ES-module frontend, no build step).

## What it does

- **Discovers** every sibling project that declares a `.hub.json` manifest (plus their `code-conductor` worktrees). One exclusion: `:` is reserved as the worktree-id qualifier, so a directory whose own name contains one is never served — see the limitations below. A sibling dir with no `.hub.json` can still be made startable via **machine-local registration** — see below. A worktree with no manifest/registration of its own inherits its parent project's, so worktrees of a registration-only project (e.g. the embedded host `code-conductor`) still show up.
- **Starts** an app: runs its `start` command as a child process with a `PORT` injected — a free ephemeral one by default, or the manifest's fixed `port` when it declares one — and shows every URL that serves it (localhost + LAN IPs) so you can open it from the phone. Apps can declare multiple named `routes` (e.g. a main page + an editor), each opened separately.
- **Sorts by recency**: a flat card list sorted by **Last edited** (each app's last git commit date, shown as an "edited X ago" label), Name, or Status.
- **Owns the lifecycle**: code-hub tracks the child's pid/process-group, so **Stop / Restart** work by killing that group — even if the project's source or worktree has since been deleted.
- **Out-of-date detection**: records the project's git HEAD at launch; flags a running app when HEAD has since moved and offers a one-tap **Restart**.
- **Worktree versions**: serves a project's `code-conductor` worktrees (`<projectsRoot>/.worktrees/<project>/<key>`, app id `<project>:<key>`) — nested under the parent project's card behind an **expandable "N worktrees ▾" toggle** (collapsed by default), each independently launchable. A project whose own checkout the root scan doesn't see still gets its worktrees listed: **embedded under code-conductor** the project itself is surfaced from the conductor's record — when that checkout has a `.hub.json` or a registration of its own — and they nest under its card (see "Running under code-conductor"). Otherwise they appear under a header-only "no main checkout" card.
- **Share via cloudflared tunnel, Tailscale Funnel, or LAN, token-protected**: exposes a running app behind a local auth proxy (WebSocket-aware, so socket.io apps work). The share link (and its QR code) carries a one-time token, not credentials — opening it exchanges the token for an httpOnly session cookie via a redirect, so the shared app's own relative `fetch()` calls keep working (a URL with embedded credentials breaks those in Chromium). Three modes: a **cloudflared quick tunnel** (public `*.trycloudflare.com` URL, TLS terminated by Cloudflare), a **Tailscale Funnel** (public `https://<machine>.<tailnet>.ts.net` URL, TLS terminated by `tailscaled` on this machine — unlike cloudflared's fresh random hostname on every launch, this URL is **stable across restarts**, so a link handed out yesterday still works today), or a **LAN share** (proxy bound to `0.0.0.0`, reachable from any device on the local network, plain HTTP — no `cloudflared` required). Also shows a username + password as a fallback for curl/API clients that can't hold cookies — `hub` + a random password per share, unless the app has a **default share login** (a per-app username and/or password set from the card's **Share login** button, stored in `share-defaults.json` and shown masked); both are editable live from the UI and persist (server-side, in memory) for as long as the share stays up, so a page refresh doesn't lose them. LAN mode is always available even when neither `cloudflared` nor Tailscale is, and can optionally **disable authentication entirely** (a per-share checkbox) — the proxy then forwards every request/upgrade with no gate at all, and the share URL carries no token or credentials.

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
  "port": 3000,             // optional FIXED port for this checkout (1024-65535);
                            //   omit for a free port. Worktrees always get a free
                            //   port. A busy fixed port refuses the start.
  "routes": [               // optional named URLs the app serves (default: one implicit "/")
    { "name": "Main",   "path": "/" },
    { "name": "Editor", "path": "/editor.html" }
  ]
}
```

- `start` must **bind `$PORT`** (injected by code-hub — a free port, or the manifest's `port` when set) and **stay up until killed**. code-hub launches it via `bash -lc` in its own process group; there is no separate stop command — code-hub stops the app by killing that group (SIGTERM, then SIGKILL after a 3s grace period).
- **Readiness**: `readyWhen` (stdout/stderr regex) → else `healthPath` (any HTTP response) → else a default TCP connect probe on `$PORT`. Bounded to 30s; on timeout the app stays running but is flagged readiness-unconfirmed.

## Machine-local registration (no `.hub.json` needed)

For a sibling dir you don't want to (or can't) add a `.hub.json` to, register it instead: `<projectsRoot>/.code-hub/registrations.json` is a hand-editable JSON object keyed by app id (a project's directory basename, or `<project>:<key>` for a worktree — the same `id` a real `.hub.json` would use), each value the same shape as a `.hub.json` body (`start` required; `name`/`healthPath`/`readyWhen`/`port`/`routes` optional). It's consulted only for a dir that has **no** `.hub.json` of its own — a real manifest, even a broken one, always wins over a registration. Two MCP tools manage it: `register_app` (`{ id, start, name?, healthPath?, readyWhen?, port? }` — `routes` isn't expressible in the tool's schema, add it by hand-editing the file directly) and `unregister_app` (`{ id }`). Apps sourced from the registry are otherwise identical to manifest-based ones (worktree classification, discovery, start/stop all behave the same). See `docs/protocol.md` for the full schema and precedence rules.

## Key defaults

| Setting | Default | Override |
|---|---|---|
| App port | a free ephemeral port | optional `port` in `.hub.json` / `registrations.json` (default checkout only; worktrees always get a free port, and a busy fixed port refuses the start rather than moving) |
| UI port | `7000` | `PORT` |
| UI host | `127.0.0.1` | `HOST` |
| Projects root | parent dir of this repo | `PROJECTS_ROOT` (the conductor injects this when embedded, so the hub scans the conductor's own root) |
| cloudflared binary | `cloudflared` (from `PATH`) | `CODEHUB_CLOUDFLARED_BIN` |
| tailscale binary | `tailscale` (from `PATH`) | `CODEHUB_TAILSCALE_BIN` |
| LAN share TLS | on (HTTPS, self-signed) | Toggle per share from the **Edit** form (`TLS (HTTPS)`); `POST /apps/:id/share` accepts `tls?: boolean` (default on) |
| Share login | `hub` + random password per share | per-app default via the card's **Share login** button / `PUT /api/apps/:id/share/defaults` |
| Runtime state | `<projectsRoot>/.code-hub/state.json` | — |
| Machine-local registrations | `<projectsRoot>/.code-hub/registrations.json` | — |
| Default share logins | `<projectsRoot>/.code-hub/share-defaults.json` (mode `0600`, plaintext) | — |

## Trust model & limitations

- **Single-user, local, no auth, no DB.** code-hub runs the `start` command of any discovered `.hub.json` — treat the workspace as trusted code you own. Don't expose the code-hub UI itself to untrusted networks.
- code-hub only **reads** other projects and **runs their `start` command**; it never edits them.
- Sharing is **gated by default** in all three modes: opening the share link exchanges a one-time token (in the URL) for an httpOnly `hub_auth` session cookie, so the shared document's own URL never carries credentials. HTTP Basic Auth (username `hub` + a per-share random password unless the app has a default share login, both editable live from the UI) remains available as a fallback for curl/API clients that can't hold cookies. **Tunnel mode**: TLS is terminated by Cloudflare, so the token exchange, cookie, and any Basic Auth are encrypted in transit; authentication cannot be disabled for a tunnel share. **Tailscale Funnel mode**: the app is published on the internet at the node's MagicDNS name; TLS is terminated by `tailscaled` **on this machine**, which then forwards plain HTTP to the local auth proxy, so the token exchange, cookie, and any Basic Auth are encrypted across the internet hop. Authentication cannot be disabled for a tailscale share, and only **one can be active at a time** — Funnel occupies port 443 of the node machine-wide (a second attempt is refused with `409` naming the app that holds it). **LAN mode**: **TLS is on by default** — the proxy serves HTTPS with a per-share self-signed certificate (kept in memory only), so the token/cookie/Basic-Auth are encrypted on the LAN hop, and the session cookie is marked `Secure`. Because the cert is self-signed, browsers show a one-time "connection is not private" warning to click through (no public CA can vouch for a LAN IP) — this is the expected first-visit UX. TLS can be turned off (falling back to **cleartext** plain HTTP) from the **Edit** form's **TLS (HTTPS)** toggle, or a per-share `tls: false`; only do that on a network you trust. Because http↔https can't switch on a live proxy, flipping the toggle **re-shares** the app — a fresh URL/QR and a reset password (back to the app's default login, if set) — unlike the authentication toggle, which flips the same share in place. A LAN share can also opt out of the gate entirely (a per-share checkbox) — no token, no cookie, no Basic Auth, every request/upgrade forwards straight through; only do this on a network you fully trust. Tokens/passwords live in server memory for the lifetime of the share (a page refresh re-reveals the password, the QR, and the Open magic-link; nothing about a live share is written to disk) and a share does not survive a code-hub restart in any mode (re-share for a fresh URL) — a tailscale share's *URL* is stable across restarts, but the share itself still ends with the process.
- **A default share password is stored in plaintext** in `<projectsRoot>/.code-hub/share-defaults.json`, protected only by its `0600` file mode (it is never sent back to the browser). See `docs/protocol.md`.
- **Tailscale Funnel shares** carry two limitations worth knowing before you hand the URL out:
  - **The URL is stable, not immutable.** It is the node's MagicDNS name, so it survives code-hub restarts and machine reboots — that stability is the entire reason this mode exists next to cloudflared. But it is the node's *identity*, and identity can churn: if the node ever re-registers under a name already taken in the tailnet (a container or VM rebuild is the usual cause), Tailscale appends a numeric suffix and the URL changes. This machine is already `code-conductor-1.tailb09348.ts.net` — the `-1` is exactly that having happened once. code-hub re-reads the current name from `tailscale status` on every share, so a rename yields a correct new URL rather than a stale one, but a link handed out before the rename is dead.
  - **One tailscale share at a time.** Funnel publishes on port 443 of the node, a machine-wide resource, so a second tailscale share is refused with `409` naming the app currently holding it. Unshare that one first. (LAN and cloudflared shares are unaffected and can run alongside it.)
- **Projects on a code-conductor *registered (remote) system* are not served.** Their tree is on another machine, and code-conductor roots their worktrees on that machine too — neither is reachable by code-hub's filesystem scan, so such projects are dropped from the conductor overlay rather than rendered as a card for a directory that isn't here.
- **A directory name containing `:` is not servable.** code-hub identifies a worktree as `<project>:<key>`, so `:` is reserved: a project directory, or a worktree's project/key directory, whose name contains one is skipped even with a perfectly valid `.hub.json`. Without the reservation a project literally named `a:b` and the worktree `a/b` would claim the same id, and `.worktrees/a/b:c` and `.worktrees/a:b/c` would claim the same id as each other — two checkouts behind one card, with every Start/Stop/Share reaching whichever the filesystem happened to list first. The skip is logged to the server console whenever it cost you a servable app, and silent when it didn't. The log names the **skipped checkout**, which is not always the directory to rename: for `.worktrees/a/b:c` the offending component is in the named path, but for `.worktrees/a:b/c` the `:` is in the *project* component, so the fix is renaming `.worktrees/a:b` (and any `<projectsRoot>/a:b` checkout of the same project, which is refused for the same reason and logged separately). `register_app` refuses such an id too, naming the reservation.
- **Fixed ports** (`port` in `.hub.json`) are per-checkout and deliberately strict:
  - The default checkout binds exactly the declared port. If that port is busy, **the start is refused** (`409`) — code-hub never falls back to a free one, since a fixed port that quietly moves is worse than no fixed port at all. A consequence worth knowing: a **rapid restart can hit `EADDRINUSE`** while the previous child's socket is still draining, and it refuses rather than moving. Retry a moment later.
  - **Worktrees never inherit a fixed port** — they always get a free one, so a worktree and its parent checkout can run side by side. This holds even though git carries the parent's `.hub.json` (fixed port included) into the worktree.
  - **LAN share on the fixed port depends on how the app binds**, which code-hub can't control (it injects only `$PORT`). An app that binds **loopback only** leaves the LAN addresses free, so the gated LAN share takes the app's own port. An app that binds **all interfaces** (`0.0.0.0` — what a plain `app.listen(PORT)` does) already holds that port on every address; its gated share **falls back to a free port**, with a warning in the share panel. That warning matters: such an app is already answering on the LAN at the fixed port with **no authentication** — a fixed port doesn't create that exposure, it just makes it predictable. Bind loopback-only if you want the gate to be the only way in. The same fallback can also be caused by an *unrelated* process holding that LAN port, which means something quite different (your app isn't LAN-reachable at all), so code-hub tries to establish which case it is. It errs toward warning: it stays quiet only when it positively shows the holder is *not* your app, and warns whenever it can't tell — including on macOS and Windows, where the check it relies on can't run at all. It never claims exact attribution; a squatter and your app look identical at the socket level.

## Running under code-conductor

code-hub is the first `code-conductor` plugin: `conductor.plugin.json` (repo root) declares its start command, `GET /api/health` liveness path, and an MCP endpoint (`POST /api/mcp`, tools `list_apps`/`start_app`/`stop_app`/`register_app`/`unregister_app`) that mirrors the HTTP API. Standalone use (`npm start`) is unaffected — the plugin manifest and MCP endpoint are inert unless a conductor calls them, and the `pluginBridge.js` script tag in `index.html` (served by the conductor when embedded) 404s harmlessly otherwise. See `docs/protocol.md` for the MCP contract.

When embedded, code-hub also asks the conductor where each project's tree actually is (`GET $CONDUCTOR_URL/api/projects`), and uses that answer as a strictly additive **overlay** on its own filesystem scan. The scan only sees directories directly under the projects root, so a project whose tree lives elsewhere — outside the root, or nested under a dot-dir the scan skips, like `.plugins/` — is invisible to standalone code-hub however servable it is. The overlay surfaces those projects as ordinary cards at their real path, with real git info and a working Start, on the same terms as any other project: a `.hub.json` or a `registrations.json` entry is required, and without one there is no card at all, exactly as for a manifest-less directory under the root. Their worktrees (which the conductor nests at `<projectsRoot>/.worktrees/<project>/<key>` whatever directory the tree itself lives in) then group under that card instead of under a header-only "no main checkout" one. **The filesystem scan always wins**: the overlay is consulted only for a name the root scan produced no directory for. Every failure is silent and keeps the last good answer: conductor down, restarting, slow (2s budget), or answering with a non-2xx, non-JSON or non-array body changes nothing — the listing keeps whatever the last successful answer supplied, and code-hub retries after a few seconds. A *successful* answer always replaces it, including one that lists nothing code-hub can use. Only with no successful answer yet (including standalone) is the listing purely filesystem-derived. At most one conductor call every 5 seconds, never on the request path.

When embedded, code-hub surfaces the host `code-conductor` checkout as an **always-on** app without needing a `.hub.json` of its own. It locates the checkout from the `CONDUCTOR_PROJECT_DIR` env var the conductor injects — so it shows up even when the conductor's own checkout lives **outside** the scanned `PROJECTS_ROOT` (a conductor with a custom root). Older conductors that don't inject `CONDUCTOR_PROJECT_DIR` fall back to discovering a `code-conductor/` dir under the root via an **internal, process-lifetime-only registration** (never persisted, not exposed via `register_app`). Running code-hub standalone (no `CONDUCTOR_*` env vars), `code-conductor` doesn't show up at all unless separately given a `.hub.json` or a machine-local registration.

## Testing

```sh
npm test                   # node:test suite (no network, uses fakes)
RUN_REAL_CLOUDFLARED=1 npm test   # also runs the real-cloudflared smoke test
RUN_REAL_TAILSCALE=1 npm test     # also runs the real-tailscale smoke tests — these
                                  #   open a REAL public Funnel on this node for a
                                  #   few seconds (they pin that killing the funnel
                                  #   process removes the funnel config). The
                                  #   end-to-end gate check additionally needs this
                                  #   host to resolve its own MagicDNS name, and
                                  #   skips with a reason when it can't.
```

## Docs

- `docs/features.md` — UI and user-facing features
- `docs/protocol.md` — `.hub.json` schema + HTTP API
- `docs/architecture.md` — modules, process/state lifecycle, test patterns

## License

This project is licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later). Copyright (c) 2026 UnmanagedCode. See [LICENSE](LICENSE) for details.
