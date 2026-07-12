import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';

// A local HTTP reverse proxy that enforces HTTP Basic Auth and forwards
// authenticated traffic (including WebSocket upgrades) to a target port on
// localhost. It sits between cloudflared and a shared app so the public
// *.trycloudflare.com URL requires credentials. In-process (not a child):
// a single fixed localhost upstream is a tiny surface, and the WS-upgrade →
// raw-socket pipe is a well-known pattern — this keeps deps at express+qrcode.
// The proxy does NOT survive a code-hub restart (by design; the caller tears
// down the orphaned tunnel and the user re-shares).

const REALM = 'code-hub share';

// Constant-time credential comparison. Hashing both sides to a fixed length
// first avoids timingSafeEqual's throw on unequal lengths and any length
// side-channel.
function credsMatch(provided, expected) {
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function isAuthed(req, expected) {
  const h = req.headers['authorization'] || '';
  const m = /^Basic\s+(.+)$/i.exec(h);
  if (!m) return false;
  let decoded;
  try { decoded = Buffer.from(m[1], 'base64').toString('utf8'); }
  catch { return false; }
  return credsMatch(decoded, expected);
}

// Reconstruct the raw header block from req.rawHeaders (name/value pairs),
// preserving order and casing (matters for Sec-WebSocket-* on upgrades).
function rawHeaderLines(rawHeaders) {
  let out = '';
  for (let i = 0; i < rawHeaders.length; i += 2) {
    out += `${rawHeaders[i]}: ${rawHeaders[i + 1]}\r\n`;
  }
  return out;
}

// Start an auth proxy in front of `targetPort`. Resolves once it is listening.
// Returns { port, username, password, close() }. Credentials are generated
// with a CSPRNG per call and held in memory only (never logged/persisted).
// `host` defaults to loopback-only (cloudflared share); a LAN share passes
// '0.0.0.0' so other devices on the network can reach the proxy directly.
export function startAuthProxy(targetPort, { username = 'hub', host = '127.0.0.1' } = {}) {
  const password = crypto.randomBytes(18).toString('base64url');
  const expected = `${username}:${password}`;
  const sockets = new Set();

  const server = http.createServer((req, res) => {
    if (!isAuthed(req, expected)) {
      res.writeHead(401, {
        'WWW-Authenticate': `Basic realm="${REALM}"`,
        'Content-Type': 'text/plain',
      });
      res.end('Authentication required\n');
      return;
    }
    const up = http.request(
      { host: '127.0.0.1', port: targetPort, method: req.method, path: req.url, headers: req.headers },
      (upRes) => { res.writeHead(upRes.statusCode || 502, upRes.headers); upRes.pipe(res); },
    );
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(up);
  });

  // WebSocket / other upgrades: gate, then pipe raw sockets to the upstream.
  server.on('upgrade', (req, socket, head) => {
    if (!isAuthed(req, expected)) {
      socket.write(`HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="${REALM}"\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }
    const up = net.connect(targetPort, '127.0.0.1', () => {
      up.write(`${req.method} ${req.url} HTTP/1.1\r\n${rawHeaderLines(req.rawHeaders)}\r\n`);
      if (head && head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    // Tear the pair down together so neither side lingers (and close() drops both).
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
    up.on('close', () => socket.destroy());
    socket.on('close', () => up.destroy());
  });

  // Track connections so close() can drop lingering (e.g. WS) sockets promptly.
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      server.removeListener('error', reject);
      resolve({
        port: server.address().port,
        username,
        password,
        close() {
          for (const s of sockets) { try { s.destroy(); } catch { /* gone */ } }
          sockets.clear();
          server.close();
        },
      });
    });
  });
}
