# Features (user-facing)

code-hub is a single-page, phone-first UI (dark theme, matches code-conductor). It lists every servable app grouped by project and lets you drive each one.

## App list

- The **header** shows a large title, the subtitle "launcher for everything under `~/cc-projects/`" (the path as a mono chip), and a **cloudflared availability pill** (`cloudflared ✓` / `no cloudflared`).
- A toolbar offers a **Sort** dropdown — **Last edited** (default; by each app's last commit date, newest first), **Name**, or **Status** — and a **refresh** (`↻`) button. The list also auto-refreshes every 2s.
- Apps render as a **flat, sorted list of cards** — top-level cards are the **main project checkouts** only.
- **Worktrees nest under their project.** A project with ≥1 worktree shows an **`N worktrees ▾` toggle** on its card, **collapsed by default**; expanding reveals the worktree variants as **recessed, indented subcards**. Each subcard is fully independent — its own branch badge, status (dot + word + `:port`), outdated pill, and Start/Stop/Restart/Open/Share controls — so a worktree can be launched and served on its own. Sorting applies to the top-level projects; worktrees always nest under their parent. (A worktree whose main checkout isn't servable appears under a header-only "no main checkout" parent, never hidden.)
- Every card has a **colored vertical accent bar** on its left edge, a stable distinct hue derived from the app id.
- **Top row**: a **status dot** + the app **name** (bold) on the left; the status word and, when running, the **port** (`:41051`) on the right. Dot colors: muted grey `stopped`, amber (pulsing) `starting`, green `ready`/`running`, red `crashed`.
- **Meta row** (monospace, muted): the directory id (when it differs from the name), short commit sha, an amber **outdated** pill (git HEAD moved since start), an **edited X ago** label (tap/hover for the absolute datetime), a red **source removed** badge (still running but source dir deleted — you can still Stop it), and a neutral **always on** badge (see below).
- A crashed start shows the captured error/output tail on the card.
- A small **footer** shows the `updated HH:MM:SS` time of the last successful refresh.

## Controls

- **Start** (green outline, shown when stopped) — launches the app.
- **Stop** (pink/red) — kills the app's process group.
- **Restart** (amber outline) — stops then starts fresh (picks up the latest commit; clears the outdated pill).
- **Open** — once running, each **route** the app serves gets its own row (route name + an accent **Open ▶** button opening the `localhost` URL in a new tab); any LAN-IP URLs appear as small secondary links so other devices on the network can reach it. A single-route app stays compact (one Open). Routes come from the manifest `routes` field, or a single implicit `/` when absent.
- **Share** — opens a cloudflared quick tunnel **protected by HTTP Basic Auth**. code-hub puts a local auth proxy in front of the app and points cloudflared at it, so the public `*.trycloudflare.com` URL requires credentials: username `hub` + a strong password freshly generated per share. The panel shows the clean URL, the **username** and **password** (each with a Copy button), a **QR code** that encodes the credentialed URL (`https://hub:<pass>@host`) so scanning auto-authenticates, plus **Open**/**Copy**/**Unshare**. Disabled with a tooltip when cloudflared isn't installed. Stopping/restarting an app tears down its tunnel + proxy. Credentials live in memory only and are shown once — after a full UI reload the password is gone (re-share to reveal); a code-hub restart ends the share entirely (re-share for a fresh URL).
- **Always on** — when code-hub runs embedded inside code-conductor as a plugin, the main `code-conductor` checkout (never its worktrees) shows an "always on" badge with only a **Share** control — Start/Stop/Restart are hidden since the host conductor is already running and code-hub doesn't own its lifecycle. Standalone (no conductor), this never appears — `code-conductor` behaves like any other app.

## Installable

Ships a web manifest + SVG icon, so it can be added to a phone home screen as a standalone PWA.
