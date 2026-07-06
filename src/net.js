import net from 'node:net';
import os from 'node:os';

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

// Every URL that serves an app bound to `port`: the `localhost` loopback name
// plus each non-internal IPv4 the machine exposes (LAN access from a phone).
// Only one loopback URL is emitted (localhost) — the 127.0.0.1 form is an
// equivalent duplicate.
export function enumerateUrls(port) {
  const urls = [`http://localhost:${port}`];
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) urls.push(`http://${ni.address}:${port}`);
    }
  }
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
