# Host relay (code-hub in Docker)

A small Python program you run on the **Docker host** so a code-hub running in a **bridge-networked container** can hand out LAN share URLs that other devices on your network can actually reach. Wire protocol: `docs/protocol.md` → "Host relay protocol". Internals: `docs/architecture.md`.

## When you need it

In a bridge-networked container, a LAN share is unreachable from the LAN:

- code-hub sees only the container's bridge address (e.g. `172.17.0.2`), so that is what the share URL and QR carry.
- The share's auth proxy binds a port chosen at share time, which no `docker run -p` mapping publishes.

The relay listens on the host's own LAN address and splices each LAN connection back into the container, to the share's auth proxy. The share panel then shows the **host** URL. cloudflared and Tailscale Funnel shares don't need it.

Without a relay, code-hub flags such a share as container-internal: the share panel warns and hides the QR (see `docs/features.md`).

## Requirements

- Python **3.9 or newer**, standard library only — nothing to `pip install`. macOS's Command Line Tools `python3` (3.9) is enough.
- The `relay/` directory: `relay.py` plus `protocol.json`. **Keep the two files together**; the relay reads its wire protocol from `protocol.json` next to it.

## Running it

| Platform | Command |
|---|---|
| Linux / macOS | `python3 relay/relay.py` |
| Windows | `py -3 relay\relay.py` |

- Windows: if `python3` opens the Microsoft Store, that is the App Execution Alias stub — install Python from python.org and use `py`.
- macOS: the first `python3` may prompt to install the Command Line Tools; accept, they provide 3.9.
- On start it prints `code-hub-relay listening on <ip>:<port>` (stdout), then logs (stderr) the advertised address, the secret file's **path** (never the secret) and the env line to set in code-hub.
- Stop it with Ctrl-C or `SIGTERM` (exit code 0): every forward closes. If the process is killed hard, its listeners die with it.

## Per-platform setup

| Setup | Relay | code-hub container env |
|---|---|---|
| Docker Desktop (macOS / Windows) | `python3 relay/relay.py` (default `--listen 127.0.0.1:7077`) | `CODEHUB_RELAY_URL=http://host.docker.internal:7077` |
| Native Linux Docker | `python3 relay/relay.py --listen 172.17.0.1:7077` (the `docker0` address) | `CODEHUB_RELAY_URL=http://host.docker.internal:7077`, plus `--add-host=host.docker.internal:host-gateway` on `docker run` |

- **Native Linux firewalls** (ufw, firewalld) may drop `docker0` → host port 7077; allow it.
- Both setups also need `CODEHUB_RELAY_SECRET` (below).

## Advertised address and `--advertise`

With no `--advertise`, the relay advertises the host's **default-route IPv4**: it asks the kernel which source address a UDP socket "connected" to `192.0.2.1:9` (a documentation address) would use. No packet is sent. It re-checks on every new forward, so a DHCP change is picked up.

It refuses an address that can't be the LAN — unspecified (`0.0.0.0/8`), loopback, link-local, multicast/reserved, CGNAT `100.64.0.0/10` (typical of a VPN such as a Tailscale exit node), Docker's default bridge `172.17.0.0/16`, or the `--listen` address. At startup that exits with `no LAN address to advertise (<reason>) — pass --advertise <ip>`; at share time the forward fails with `no_lan_address`.

Pass `--advertise <ip>[,<ip>…]` when:

- a **VPN owns the default route** — the probe would pick the VPN address, or refuse it as CGNAT;
- the host is **multi-homed** (Ethernet plus Wi-Fi) — the probe advertises only the default-route interface;
- the host has **no default route** (offline, no DHCP) — the startup error above;
- your LAN genuinely uses CGNAT space.

`--advertise` values must be IPv4 literals and not a wildcard; they are otherwise taken as given.

## Secret provisioning

- First run creates `~/.code-hub-relay/secret` (dir `0700`, file `0600` on POSIX) holding a random token; later runs reuse it. A secret shorter than `minSecretLength` in `protocol.json` is refused.
- Give code-hub its contents as `CODEHUB_RELAY_SECRET`:
  - `docker run -e CODEHUB_RELAY_URL=http://host.docker.internal:7077 -e CODEHUB_RELAY_SECRET="$(cat ~/.code-hub-relay/secret)" …`
  - devcontainer: `"containerEnv": { "CODEHUB_RELAY_URL": "http://host.docker.internal:7077", "CODEHUB_RELAY_SECRET": "${localEnv:CODEHUB_RELAY_SECRET}" }`, with `CODEHUB_RELAY_SECRET` exported on the host.
- Embedded in code-conductor, code-hub inherits the conductor's environment, so setting the variables on the container (or the conductor) is enough.

## Configuration

| Where | Name | Default | Meaning |
|---|---|---|---|
| relay CLI | `--listen <ip:port>` | `127.0.0.1:7077` | Control listener code-hub dials (`:0` = any free port). Refused when a wildcard, or a non-loopback address that is advertised or is the default-route address. |
| relay CLI | `--advertise <ip,…>` | the default-route probe | Host LAN address(es) forwards bind and URLs carry; at most `maxAddresses` in `protocol.json`. |
| relay CLI | `--secret-file <path>` | `~/.code-hub-relay/secret` | Bearer secret; created on first run. |
| relay CLI | `--lease-ms <n>` | `30000` (`100` to `maxLeaseMs` in `protocol.json`, 24 h) | A forward's lifetime without renewal. |
| relay CLI | `--accept-wait-ms <n>` | `10000` | How long a LAN connection waits for code-hub to pick it up. |
| relay env (tests only) | `CODEHUB_RELAY_PROBE_DEST` | `192.0.2.1:9` | Route-probe destination (`<ipv4>:<port>`). |
| code-hub env | `CODEHUB_RELAY_URL` | unset = feature off | e.g. `http://host.docker.internal:7077`; must be `http:`. |
| code-hub env | `CODEHUB_RELAY_SECRET` | — | The relay's secret file contents. |

Read by code-hub on every share, so a change applies to the next share without a restart.

## Running it as a service (Linux)

A sample systemd **system** unit (a user unit can't order itself after `docker.service`); replace the placeholders:

```ini
[Unit]
Description=code-hub host relay
After=network-online.target docker.service
Wants=network-online.target

[Service]
User=<you>
ExecStart=/usr/bin/python3 <path-to>/relay/relay.py --listen 172.17.0.1:7077
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`Restart=on-failure` covers `docker0` or the network not being up yet at boot.

## Security model

- **Authenticated control API**: every request carries `Authorization: Bearer <secret>`, compared in constant time; anything else is `401`.
- **Control listener off the LAN**: `--listen` is refused when it is a wildcard, or a non-loopback address equal to an advertised address or to the host's default-route address (probed even when `--advertise` is given; a probe that finds no route adds nothing). Every address is canonicalised once at startup, and that canonical form is both what is checked and what is bound (older Pythons read a leading-zero octet differently from the C library's bind); the check runs before any listening socket is bound. A loopback `--listen` is always allowed — it is never reachable from the LAN. **What it can't know**: a `--listen` on another LAN-facing interface that is neither advertised nor the default route (a second NIC, say) is not refused; there the bearer secret is the remaining gate.
- **Apps never see the relay configuration**: the secret is a capability to listen on the host's LAN, so code-hub removes `CODEHUB_RELAY_URL` and `CODEHUB_RELAY_SECRET` (in any letter case) from the environment of every child it starts — apps, `git`, `ip`/`ifconfig`, cloudflared, tailscale — and an app's `bash -lc` start command unsets them again after the login shell has read the user's profiles, in case a profile exports them.
- **No target in the protocol**: a forward is created with an optional `port` only; the relay has no outbound TCP connect at all (its one `connect()` is the packet-less UDP route probe). It cannot be used as an open proxy.
- **TLS end to end**: the relay never imports `ssl`; LAN devices talk TLS straight to code-hub's per-share self-signed cert, which includes the advertised host address in its SAN.
- **Leases**: code-hub renews each forward every `leaseMs/3`; a crashed code-hub's forwards close within `leaseMs`. Forwards live in the relay process and die with it.
- **What the secret grants**: listening on the advertised address at a port from 1024 to 65535 and carrying whatever the secret holder pipes into it — never reaching into the LAN.

## Limitations

- **Untested in CI**: Docker Desktop's `host.docker.internal` → host loopback path on macOS/Windows, and Ctrl-C on Windows. If loopback isn't reachable, `--listen` on the host's Docker/WSL virtual-Ethernet address instead.
- **Python 3.9 compatibility is checked statically** (the tests parse the source for 3.7 syntax and scan for 3.10+ APIs); run the relay tests with `CODEHUB_PYTHON=python3.9` to check it for real.
- **One advertised address** from the probe; multi-homed or VPN hosts need `--advertise`.
- **The secret crosses the host-internal link in cleartext** (Docker bridge or the Docker Desktop VM link); a co-tenant container able to sniff the bridge could read it.
- **Windows**: the `0600`/`0700` modes don't apply on NTFS — the user-profile ACL protects the secret. The relay binds with `SO_EXCLUSIVEADDRUSE`, so it can't take a port another process holds non-exclusively.
- **Idle parked connections** may be reaped by Docker Desktop's proxy; code-hub re-parks them and both sides use TCP keepalive.
- **A relay restart while the share's host port is taken** moves the share to a free port; the panel shows the new URL on the next Refresh.
- **Container detection is a heuristic** (`/.dockerenv` or `/run/.containerenv`, and every LAN IPv4 in `172.16.0.0/12`): it misses Docker's `192.168.0.0/16` pools and Podman pasta, and can falsely flag a host-network container on an all-`172.16.0.0/12` LAN.
- **IPv4 only.**
