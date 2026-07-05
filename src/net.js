import net from 'node:net';
import os from 'node:os';

// Allocate a free TCP port by binding to 0 and reading the assigned port,
// then closing. There is a small TOCTOU window between close and the child
// binding it — the readiness probe confirms the bind, so a lost race just
// surfaces as "readiness unconfirmed" rather than silent breakage.
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

// Every URL that serves an app bound to `port`: loopback names plus each
// non-internal IPv4 the machine exposes (LAN access from a phone).
export function enumerateUrls(port) {
  const urls = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) urls.push(`http://${ni.address}:${port}`);
    }
  }
  return urls;
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
