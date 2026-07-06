# Features (user-facing)

code-hub is a single-page, phone-first UI (dark theme, matches code-conductor). It lists every servable app grouped by project and lets you drive each one.

## App list

- The **header** shows a large title, the subtitle "launcher for everything under `~/cc-projects/`" (the path as a mono chip), and a **cloudflared availability pill** (`cloudflared ✓` / `no cloudflared`).
- A toolbar offers a **Sort** dropdown — **Last edited** (default; by each app's last commit date, newest first), **Name**, or **Status** — and a **refresh** (`↻`) button. The list also auto-refreshes every 2s.
- Apps render as a **flat, sorted list of cards** (no project grouping). Each worktree is its own card, tagged with a blue **branch badge** so it's distinguishable from the main checkout.
- Every card has a **colored vertical accent bar** on its left edge, a stable distinct hue derived from the app id.
- **Top row**: a **status dot** + the app **name** (bold) on the left; the status word and, when running, the **port** (`:41051`) on the right. Dot colors: muted grey `stopped`, amber (pulsing) `starting`, green `ready`/`running`, red `crashed`.
- **Meta row** (monospace, muted): the directory id (when it differs from the name), short commit sha, an amber **outdated** pill (git HEAD moved since start), an **edited X ago** label (tap/hover for the absolute datetime), and a red **source removed** badge (still running but source dir deleted — you can still Stop it).
- A crashed start shows the captured error/output tail on the card.
- A small **footer** shows the `updated HH:MM:SS` time of the last successful refresh.

## Controls

- **Start** (green outline, shown when stopped) — launches the app.
- **Stop** (pink/red) — kills the app's process group.
- **Restart** (amber outline) — stops then starts fresh (picks up the latest commit; clears the outdated pill).
- **Open** — once running, each **route** the app serves gets its own row (route name + an accent **Open ▶** button opening the `localhost` URL in a new tab); any LAN-IP URLs appear as small secondary links so other devices on the network can reach it. A single-route app stays compact (one Open). Routes come from the manifest `routes` field, or a single implicit `/` when absent.
- **Share** — opens a cloudflared quick tunnel and shows the public `*.trycloudflare.com` URL, a **QR code** (tap to enlarge in a dialog), a **Copy** button, an **Open** link, and **Unshare**. Disabled with a tooltip when cloudflared isn't installed. Stopping an app also tears down its tunnel.

## Installable

Ships a web manifest + SVG icon, so it can be added to a phone home screen as a standalone PWA.
