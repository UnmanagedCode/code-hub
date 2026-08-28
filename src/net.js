import net from 'node:net';
import os from 'node:os';
import cp from 'node:child_process';

// Allocate a free TCP port by binding to 0 and reading the assigned port,
// then closing. There is a small TOCTOU window between close and the child
// binding it: another process (a concurrently launching app, a health
// probe, cloudflared, etc.) can grab the same ephemeral port first, in
// which case the child's listen() fails with EADDRINUSE and it exits hard.
// runner.js retries on a freshly allocated port when it detects that.
export function allocatePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// True when `port` can be bound right now on every interface. Binding 0.0.0.0
// is the strictest probe available: it fails if anything holds the port on any
// single address (measured on Linux — a listener on 127.0.0.1:P makes
// 0.0.0.0:P EADDRINUSE, since SO_REUSEADDR does not permit overlapping listen
// binds), which is exactly the question "is this fixed port free?". Same TOCTOU
// caveat as allocatePort — the child's own bind is the real backstop (see
// appManager.start, which re-checks after the spawn settles).
export function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.on('error', () => resolve(false));
    srv.listen(port, '0.0.0.0', () => srv.close(() => resolve(true)));
  });
}

// Answers "is `port` held by a bind covering EVERY address?" — i.e. is the
// holder a wildcard (0.0.0.0) listener rather than an address-specific one.
// This is what separates "the app itself binds all interfaces, so it really is
// reachable on the LAN" from "some unrelated process holds one LAN address".
//
// It binds a loopback alias (127.0.0.2): any 127.0.0.0/8 address is a distinct
// bind target from 127.0.0.1 while still being purely local, so probing it
// never touches the network or any real interface. A wildcard bind covers it,
// so the outcome answers the question directly:
//   'held'         EADDRINUSE → something holds the port on all addresses
//   'free'         bound ok   → nothing does; any holder is address-specific
//   'inconclusive' any other error → nothing established. Covers both a
//                  one-off failure and the permanent case above, where the
//                  host has no loopback aliases at all.
// Tri-state on purpose: the caller must be able to report "unknown" rather than
// assert a cause it hasn't proved. Never throws.
//
// IMPORTANT: only Linux configures the whole 127.0.0.0/8 on loopback. macOS and
// Windows have 127.0.0.1 alone, so the alias bind fails EADDRNOTAVAIL there
// before the kernel ever considers the port — for every port, held or free.
// This probe is therefore permanently 'inconclusive' on those hosts, which is
// exactly why callers must fail safe on that answer instead of reading it as
// "nothing is wrong" (see appManager.share and public/shareState.js).
// CODEHUB_WILDCARD_PROBE_ADDR overrides the alias so tests can exercise that
// host class on Linux; nothing else should set it. Read per call (like
// projectsRoot's PROJECTS_ROOT) so it doesn't depend on module-load ordering.
export function probeWildcardHold(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.on('error', (e) => resolve(e.code === 'EADDRINUSE' ? 'held' : 'inconclusive'));
    srv.listen(port, probeAlias(), () => srv.close(() => resolve('free')));
  });
}

const DEFAULT_PROBE_ALIAS = '127.0.0.2';

// The probe's 'free' answer means "no wildcard holder", and downstream that is
// the ONLY verdict allowed to stay quiet about a possible ungated LAN exposure.
// That inference holds only if an IPv4 wildcard (0.0.0.0) bind would necessarily
// cover the probed address — true of any IPv4 address (an unconfigured one just
// fails EADDRNOTAVAIL, which is the safe 'inconclusive'), and false across
// address families. Measured: with a process holding 0.0.0.0:<port>, binding
// `::1:<port>` SUCCEEDS, so an IPv6 alias would report 'free' for a genuinely
// wildcard-held port and silence the warning. `localhost` is the same trap — it
// resolves to ::1 here — so this validates the literal, not a hostname.
//
// A rejected value falls back to the default rather than disabling the probe:
// the default provably supports the inference, so production keeps giving
// correct verdicts (including the quiet one, when it is genuinely earned)
// whatever ends up in the environment. Logged, never silent.
function probeAlias() {
  const override = process.env.CODEHUB_WILDCARD_PROBE_ADDR;
  if (!override) return DEFAULT_PROBE_ALIAS;
  if (!net.isIPv4(override)) {
    console.warn(`[code-hub] CODEHUB_WILDCARD_PROBE_ADDR='${override}' is not an IPv4 literal — ignoring it and probing ${DEFAULT_PROBE_ALIAS}. Only an IPv4 alias can show the absence of a wildcard hold; a non-IPv4 one would bind alongside a 0.0.0.0 listener and hide a real LAN exposure.`);
    return DEFAULT_PROBE_ALIAS;
  }
  return override;
}

// Pure text parser: extracts LAN-reachable IPv4 addresses from `ip -4 addr`
// or `ifconfig -a` output (either GNU/net-tools or busybox/toybox style).
// Excludes loopback (127.0.0.0/8) and point-to-point addresses (a /32
// prefix or a 255.255.255.255 netmask — how VPN/tunnel interfaces like
// `tun0` show up), since those aren't reachable from another LAN device.
// Exported so tests can feed it canned text without touching child_process.
export function parseLanIPv4s(text) {
  const found = [];
  const isLan = (ip, pointToPoint) => { if (!ip.startsWith('127.') && !pointToPoint) found.push(ip); };

  // `ip -4 addr`: "inet 192.168.2.8/24 brd ... scope global wlan0"
  for (const m of text.matchAll(/inet\s+(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})\b/g)) {
    isLan(m[1], Number(m[2]) === 32);
  }
  // `ifconfig` (busybox/toybox): "inet 192.168.2.8  netmask 255.255.255.0"
  // and legacy net-tools: "inet addr:192.168.2.8  Bcast:...  Mask:255.255.255.0"
  for (const m of text.matchAll(/inet\s+(?:addr:)?(\d{1,3}(?:\.\d{1,3}){3})[^\n]*?(?:netmask|Mask:)\s*(\d{1,3}(?:\.\d{1,3}){3})/gi)) {
    isLan(m[1], m[2] === '255.255.255.255');
  }
  return [...new Set(found)];
}

// Fallback for hosts where os.networkInterfaces() can't see any interface
// beyond loopback (observed on Termux/Android: the app sandbox blocks the
// netlink-based enumeration libuv uses, even though the LAN address is
// still visible to ioctl-based tools). Tries `ip` then `ifconfig`, whichever
// is present; silently yields [] if neither works. Cached briefly in case a
// share is created/refreshed in quick succession — irrelevant on a normal
// host, where os.networkInterfaces() already finds real interfaces and this
// is never called. Only invoked via enumerateUrls(port, { lanFallback: true }),
// i.e. only from the LAN share path — never for general URL enumeration.
let fallbackCache = null; // { ips, at }
const FALLBACK_CACHE_MS = 5000;

function fallbackLanIPv4s() {
  const now = Date.now();
  if (fallbackCache && now - fallbackCache.at < FALLBACK_CACHE_MS) return fallbackCache.ips;
  let ips = [];
  for (const [cmd, args] of [['ip', ['-4', 'addr']], ['ifconfig', ['-a']]]) {
    try {
      const out = cp.execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      ips = parseLanIPv4s(out);
      if (ips.length) break;
    } catch { /* binary missing / not permitted — try the next one */ }
  }
  fallbackCache = { ips, at: now };
  return ips;
}

// Non-internal IPv4 addresses the machine exposes (LAN access from a phone).
// The `ip`/`ifconfig` shell-out fallback only runs when `lanFallback` is true —
// it's for the LAN-share path (appManager.js), which needs a real LAN IP to
// hand to another device (and, for LAN HTTPS, to put in the cert SAN); plain
// app-card URLs should reflect only what Node's os.networkInterfaces() sees.
// Single source of truth for local IPs — used by both URL enumeration and the
// self-signed cert's subjectAltName.
export function localIPv4s({ lanFallback = false } = {}) {
  const ips = new Set();
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) ips.add(ni.address);
    }
  }
  if (ips.size === 0 && lanFallback) {
    for (const ip of fallbackLanIPv4s()) ips.add(ip);
  }
  return [...ips];
}

// Every URL that serves an app bound to `port`: the `localhost` loopback name
// plus each non-internal IPv4 (see localIPv4s). Only one loopback URL is
// emitted (localhost) — the 127.0.0.1 form is an equivalent duplicate. `scheme`
// is 'http' by default; the LAN-share path passes 'https' when TLS-wrapped.
export function enumerateUrls(port, { lanFallback = false, scheme = 'http' } = {}) {
  const urls = [`${scheme}://localhost:${port}`];
  for (const ip of localIPv4s({ lanFallback })) urls.push(`${scheme}://${ip}:${port}`);
  return urls;
}

// Every URL serving `routePath` on an app bound to `port`: one per base
// (loopback + LAN IPs). Root path keeps the clean `http://host:port` form;
// a non-root path (which always starts with `/`) is appended to each base.
export function routeUrls(port, routePath) {
  return enumerateUrls(port).map((b) => (routePath === '/' ? b : b + routePath));
}

// Resolve once a TCP connection to localhost:port succeeds, or reject after
// `timeoutMs`. Polls every `intervalMs`.
export function waitForPort(port, { timeoutMs = 30000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => { sock.destroy(); resolve(); });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() >= deadline) reject(new Error(`port ${port} not listening within ${timeoutMs}ms`));
        else setTimeout(attempt, intervalMs);
      });
    };
    attempt();
  });
}
