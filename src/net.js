import net from 'node:net';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

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
// is present; silently yields [] if neither works. Cached briefly so a busy
// poll loop (list() runs this per running app/route) doesn't spawn a
// subprocess on every tick — irrelevant on a normal host, where
// os.networkInterfaces() already finds real interfaces and this is never called.
let fallbackCache = null; // { ips, at }
const FALLBACK_CACHE_MS = 5000;

function fallbackLanIPv4s() {
  const now = Date.now();
  if (fallbackCache && now - fallbackCache.at < FALLBACK_CACHE_MS) return fallbackCache.ips;
  let ips = [];
  for (const [cmd, args] of [['ip', ['-4', 'addr']], ['ifconfig', ['-a']]]) {
    try {
      const out = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      ips = parseLanIPv4s(out);
      if (ips.length) break;
    } catch { /* binary missing / not permitted — try the next one */ }
  }
  fallbackCache = { ips, at: now };
  return ips;
}

// Every URL that serves an app bound to `port`: the `localhost` loopback name
// plus each non-internal IPv4 the machine exposes (LAN access from a phone).
// Only one loopback URL is emitted (localhost) — the 127.0.0.1 form is an
// equivalent duplicate.
export function enumerateUrls(port) {
  const urls = [`http://localhost:${port}`];
  const ips = new Set();
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) ips.add(ni.address);
    }
  }
  if (ips.size === 0) {
    for (const ip of fallbackLanIPv4s()) ips.add(ip);
  }
  for (const ip of ips) urls.push(`http://${ip}:${port}`);
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
