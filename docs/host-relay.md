# Host relay (code-hub in Docker)

A small Python program you run on the **Docker host** when code-hub runs in a **bridge-networked container**. With no configuration, it:

- exposes every **LAN share** on the host's real LAN address, so other devices on your network can reach it — TLS and the share's login gate stay end to end inside code-hub;
- mirrors every **running app** onto the host's `127.0.0.1`, so a browser on the host opens it directly — and the app's Start URL points there.

Wire protocol and file formats: `docs/protocol.md` → "Host relay protocol". Internals: `docs/architecture.md`.

## When you need it

In a bridge-networked container:

- code-hub sees only the container's bridge address (e.g. `172.17.0.2`), so that is what a LAN share's URL and QR carry — no other device can reach it.
- Ports chosen at share or start time are published by no `docker run -p` mapping, so not even the host can open an app.

Without a relay, a LAN share from such a container is flagged container-internal: the share panel warns and hides the QR (see `docs/features.md`). cloudflared and Tailscale Funnel shares don't need the relay. A code-hub that is **not** in a container never dials a relay.

## Requirements

- Python **3.9 or newer**, standard library only — nothing to `pip install`. macOS's Command Line Tools `python3` (3.9) is enough.
- The `relay/` directory: `relay.py` plus `protocol.json`. **Keep the two files together**; the relay reads its protocol from `protocol.json` next to it. Run the copy from the code-hub checkout code-hub itself runs from, so the two speak the same protocol version.
- The relay must see code-hub's store, `<projectsRoot>/.code-hub/`, as a directory on the host — true when the projects root is a bind mount (the usual devcontainer setup).

## Running it

| Platform | Command |
|---|---|
| Linux / macOS | `python3 relay/relay.py` |
| Windows | `py -3 relay\relay.py` |

No flags and no environment variables. Start the relay and code-hub in either order; they find each other.

- Windows: if `python3` opens the Microsoft Store, that is the App Execution Alias stub — install Python from python.org and use `py`.
- macOS: the first `python3` may prompt to install the Command Line Tools; accept, they provide 3.9.
- On start it prints `code-hub-relay listening on <ip>:<port>` (stdout), then logs (stderr) the store it found, the advertised LAN address(es) and, if code-hub hasn't run yet, `waiting for code-hub to create <path>`. It never logs the secret.
- Stop it with Ctrl-C or `SIGTERM` (exit code 0): every host listener closes and it withdraws its relay file. If the process is killed hard, its listeners die with it.

### Discovery

The relay finds code-hub's store by walking **up from its own script's directory** (never the working directory) to the first ancestor holding a `.code-hub` directory. Running the copy inside the projects root — e.g. `<projectsRoot>/.plugins/code-hub/relay/relay.py` or `<projectsRoot>/code-hub/relay/relay.py` — finds `<projectsRoot>/.code-hub`.

- `--projects-root <dir>` overrides the walk: the store is `<dir>/.code-hub`, which must exist.
- Finding none exits non-zero: `code-hub-relay: no .code-hub found in any parent of <script dir> (searched: <dirs…>) — start code-hub once so it creates <projectsRoot>/.code-hub, or pass --projects-root <dir>`.

### Rendezvous files

Both live in `<projectsRoot>/.code-hub/relay/` (names from `rendezvous` in `protocol.json`; shapes in `docs/protocol.md`):

| File | Written by | Holds |
|---|---|---|
| `relay.json` | code-hub, on every boot when missing or invalid (dir `0700`, file `0600`) | The shared secret. Delete it to rotate: code-hub writes a new one on its next boot, and the relay reads it on every connection. |
| `host.json` | the relay, at startup (atomically, `0600`) | Where the relay listens, and its pid. Removed on a clean exit. |

code-hub watches `host.json` (filesystem events plus a content poll every `HOST_POLL_MS` in `src/relayStore.js`, since Docker Desktop bind mounts often drop host-side events) and connects whenever it appears or changes.

## Per-platform setup

| Setup | Relay listens on (default) | code-hub dials |
|---|---|---|
| Docker Desktop (macOS / Windows / Linux) | `127.0.0.1:7077` (no `docker0` on the host) | `host.docker.internal:7077` — Desktop forwards it to the host's loopback |
| Native Linux Docker | the `docker0` address, e.g. `172.17.0.1:7077` | that address as written, then the container's default gateway |

- No `--listen` and no `--add-host` needed in either case.
- **Native Linux firewalls** (ufw, firewalld) may drop `docker0` → host port 7077; allow it.
- **A host running both Docker Engine and Docker Desktop**: the default picks `docker0`; pass `--listen 127.0.0.1:7077` for containers under Desktop.

## What gets exposed

| Scope | What | Bound on the host | Gate |
|---|---|---|---|
| `lan` | every LAN share's auth proxy | the advertised LAN address(es) only | the share's own (token / cookie / Basic Auth), TLS end to end |
| `loopback` | every running app's own port | `127.0.0.1` only | **none** — the same trust as an ordinary local dev server |

- **Same port where free.** Each is bound at its container port when that is free on the host, else at a free one; the share panel ("Port N was busy on the host, so it is on port M there") and the app's Start URL show the port actually used. A devcontainer port-forward (VS Code's, for one) often holds the same host port already, so a fallback for mirrors is common and expected.
- **Loopback mirrors** appear once the app is **ready** (its readiness check passed — `readyWhen`, `healthPath` or the default TCP probe — or, for an app adopted after a code-hub restart, its process is alive), never while it is still starting: where the host's loopback is the app's own (a host-network container), a relay listener bound first would take the app's port. The always-on host code-conductor is never mirrored. A stopped, crashed or exited app's mirror closes at once.
- While an app is mirrored, its **Start URL** (the first URL of the app and of each route) is `http://127.0.0.1:<host port>`; otherwise `http://localhost:<port>`.
- **No periodic refresh**: a relay connecting or dropping changes share URLs and Start URLs server-side, and `GET /api/apps` reflects it within seconds; the page shows it on **Refresh** or when you return to the tab.

## Advertised address and `--advertise`

With no `--advertise`, the relay advertises the host's **default-route IPv4**: it asks the kernel which source address a UDP socket "connected" to `192.0.2.1:9` (a documentation address) would use. No packet is sent. It re-checks on every `ports` frame, so a DHCP change rebinds the LAN listeners.

It refuses an address that can't be the LAN — unspecified (`0.0.0.0/8`), loopback, link-local, multicast/reserved, CGNAT `100.64.0.0/10` (typical of a VPN such as a Tailscale exit node), Docker's default bridge `172.17.0.0/16`, or the `--listen` address. At startup that is logged, not fatal (mirrors still work); LAN shares then fail with `no_lan_address` until there is one.

Pass `--advertise <ip>[,<ip>…]` when:

- a **VPN owns the default route** — the probe would pick the VPN address, or refuse it as CGNAT;
- the host is **multi-homed** (Ethernet plus Wi-Fi) — the probe advertises only the default-route interface;
- the host has **no default route** (offline, no DHCP);
- your LAN genuinely uses CGNAT space.

`--advertise` values must be IPv4 literals and not a wildcard (at most `maxAddresses` in `protocol.json`); they are otherwise taken as given.

## Configuration

| Name | Default | Meaning |
|---|---|---|
| `--listen <ip:port>` | the `docker0` address if the host has one, else `127.0.0.1`; port `7077` | Control listener code-hub dials (`:0` = any free port; `host.json` carries the real one). Refused when a wildcard, or a non-loopback address that is advertised or is the default-route address. |
| `--advertise <ip,…>` | the default-route probe | Host LAN address(es) the `lan` scope binds and share URLs carry. |
| `--projects-root <dir>` | the nearest parent of the script's directory holding `.code-hub` | Where code-hub's store is. |
| `--accept-wait-ms <n>` | `10000` | How long a host client waits for code-hub to claim it. |
| `CODEHUB_RELAY_PROBE_DEST` (env, tests only) | `192.0.2.1:9` | Route-probe destination (`<ipv4>:<port>`). |

Timings and caps (`pingIntervalMs`, `keepaliveTimeoutMs`, `handshakeTimeoutMs`, `maxPorts`, the pre-auth and incoming caps) are in `protocol.json`, read by both sides.

## Lifecycle

- **Any start order.** code-hub provisions `relay.json` on every boot; the relay publishes `host.json` once listening. A relay started first waits for the secret (it re-reads it on every connection); a code-hub started first connects as soon as `host.json` appears.
- **One session.** code-hub holds one authenticated control session and sends the full set of exposures over it on connect and on every change. A failed attempt retries with doubling backoff (`BACKOFF_BASE_MS` up to `BACKOFF_CAP_MS` in `src/hostRelay.js`); a `host.json` change retries at once. A `host.json` of another protocol version is reported (`update the relay/ copy on the host`) and not dialled until it changes.
- **Session-scoped exposure.** Every host listener belongs to the session: it closes when the session ends — code-hub exits or is killed (the socket closes), freezes (both sides ping every `pingIntervalMs`; silence past `keepaliveTimeoutMs` ends the session), or a newer code-hub session replaces it — and comes back when code-hub reconnects.
- **A relay restart** ends the session: shares fall back to their container URLs and Start URLs to `localhost`, then return once code-hub reconnects to the new relay — no action in code-hub.

## Running it as a service (Linux)

A sample systemd **system** unit (a user unit can't order itself after `docker.service`); replace the placeholders. No `--listen` is needed: the default finds `docker0`.

```ini
[Unit]
Description=code-hub host relay
After=network-online.target docker.service
Wants=network-online.target

[Service]
User=<the user that owns <projectsRoot>/.code-hub>
ExecStart=/usr/bin/python3 <projectsRoot>/<path-to>/relay/relay.py
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`Restart=on-failure` covers `docker0` or the store not being there yet at boot.

## Security model

- **Mutual challenge-response, secret never on the wire.** Every connection — control and data — starts with the relay's random nonce; code-hub answers with its own nonce and an HMAC-SHA256 over both under the shared secret, and the relay answers with an HMAC under a different label. Each side checks the other's in constant time; the labels stop a reflected MAC, the fresh nonces stop a replay. code-hub uses nothing the relay sends — data bytes included — before the relay has proven the secret.
- **Pre-auth caps.** At most `maxPendingHandshakes` unauthenticated connections at once (one more is cut with no hello), `handshakeTimeoutMs` to authenticate, `maxFrameBytes` per line. code-hub never has more than `maxHubHandshakes` (below the cap) handshakes in flight and queues the rest, so a burst of clients can't make code-hub trip the cap itself.
- **Scope confinement.** Bind hosts are chosen in the relay from the scope alone (`hosts_for`), never from a frame: `loopback` only ever on `127.0.0.1`, `lan` only on the advertised addresses.
- **On-demand data path.** Each host client is claimed by exactly one fresh, authenticated data connection bound to the current session (`stale_session`, `unknown_conn` otherwise; a claim is consumed). Clients nobody claims are cut after `--accept-wait-ms`; pending clients are capped per port (`maxIncomingPerPort`) and per session (`maxIncomingTotal`).
- **No target in the protocol.** No frame carries a host or a target; the relay has no outbound TCP connect at all (its one `connect()` is the packet-less UDP route probe). It cannot be used as an open proxy.
- **TLS end to end** for LAN shares: the relay never imports `ssl`; LAN devices talk TLS straight to code-hub's per-share self-signed cert, whose SAN includes the advertised host address (re-issued in place when the relay advertises one the share didn't know).
- **Control listener off the LAN.** `--listen` is refused when it is a wildcard, or a non-loopback address equal to an advertised address or to the host's default-route address (probed even when `--advertise` is given). Every address is canonicalised once at startup, and that canonical form is both what is checked and what is bound; the check runs before any listening socket is bound. A loopback `--listen` is always allowed.
- **What the secret grants**: holding a session — listening on the advertised addresses and on `127.0.0.1` at ports from `port.min` to `port.max`, and carrying whatever the holder pipes into them — never reaching into the LAN.
- **Out of scope**: an attacker on the host able to hold every pre-auth slot can delay code-hub's handshakes by up to `handshakeTimeoutMs` per slot — a local denial of service.

## Limitations

- **The relay must see the same `.code-hub`.** A named volume or remote Docker needs `--projects-root` pointing at a directory holding a copy of it — and a copied `relay.json` goes stale when code-hub regenerates it.
- **Native Linux: run the relay as the user that owns `.code-hub/relay/`** (`0700`); otherwise it can't read the secret, and it says so on every connection.
- **The secret lives in the container's store**, readable by code-hub's user and anything running as it.
- **A `docker0` `--listen` is reachable from a LAN neighbour that adds a route** to it (the weak host model); there the challenge-response is the gate.
- **Loopback mirrors have no login**: any local process or user on the host can reach a mirrored app, like any local dev server.
- **The panel updates on Refresh**, not live.
- **Untested in CI**: Docker Desktop's `host.docker.internal` → host loopback path on macOS/Windows, the `docker0` default and gateway fallback on a real native-Linux Docker host, a second real LAN device, and Ctrl-C on Windows.
- **Python 3.9 compatibility is checked statically** (the tests parse the source for 3.7 syntax and scan for 3.10+ APIs); run the relay tests with `CODEHUB_PYTHON=python3.9` to check it for real.
- **Windows**: the `0600`/`0700` modes don't apply on NTFS — the user-profile ACL protects the files. The relay binds with `SO_EXCLUSIVEADDRUSE`, so it can't take a port another process holds non-exclusively.
- **Container detection is a heuristic** (`/.dockerenv` or `/run/.containerenv`); the container-internal flag also needs every LAN IPv4 in `172.16.0.0/12`, so it misses Docker's `192.168.0.0/16` pools and Podman pasta, and can misfire on a host-network container on an all-`172.16.0.0/12` LAN.
- **IPv4 only.**
