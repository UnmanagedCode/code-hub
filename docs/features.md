# Features (user-facing)

code-hub is a single-page, phone-first UI (dark theme, matches code-conductor). It lists every servable app grouped by project and lets you drive each one.

## App list

- Apps are **grouped by project** in collapsible sections (`▸`/`▾`). A project's main checkout appears first; its worktrees are nested and indented, each tagged with a blue **branch badge**.
- Each app card shows a **status dot**:
  - muted grey — `stopped`
  - amber (pulsing) — `starting`
  - green — `ready` / `running`
  - red — `crashed`
- Card metadata (monospace): short commit sha, port (when running), and badges:
  - **out of date** (amber) — the project's git HEAD moved since the app was started.
  - **source removed** (red) — the app is still running but its source dir was deleted; you can still Stop it.
- A crashed start shows the captured error/output tail on the card.
- The top bar shows a **cloudflared availability pill** (`cloudflared ✓` / `no cloudflared`) and a **refresh** button. The list also auto-refreshes every 2s.

## Controls

- **Start** — launches the app; once ready, the card lists every serving URL (`localhost`, `127.0.0.1`, and each LAN IP) as tappable links that open in a new tab.
- **Stop** — kills the app's process group.
- **Restart** — stops then starts fresh (picks up the latest commit; clears the out-of-date badge).
- **Share** — opens a cloudflared quick tunnel and shows the public `*.trycloudflare.com` URL, a **QR code** (tap to enlarge in a dialog), a **Copy** button, an **Open** link, and **Unshare**. Disabled with a tooltip when cloudflared isn't installed. Stopping an app also tears down its tunnel.

## Installable

Ships a web manifest + SVG icon, so it can be added to a phone home screen as a standalone PWA.
