import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';

// A local HTTP reverse proxy that fronts a shared app and forwards
// authenticated traffic (including WebSocket upgrades) to a target port on
// localhost. It sits between cloudflared/LAN clients and the app. In-process
// (not a child): a single fixed localhost upstream is a tiny surface, and the
// WS-upgrade → raw-socket pipe is a well-known pattern — this keeps deps at
// express+qrcode. The proxy does NOT survive a code-hub restart (by design;
// the caller tears down the orphaned tunnel and the user re-shares).
//
// Per-request auth resolves in order: a valid `?__hubauth=` token (query)
// sets an httpOnly session cookie and 302-redirects to the token-stripped
// URL; else a valid `hub_auth` cookie forwards the request; else valid HTTP
// Basic Auth forwards it (curl/API-client fallback); else 401. This keeps
// credentials out of the document URL entirely — a credentialed URL breaks
// any shared app's relative `fetch()` calls in Chromium. WS upgrades accept
// a valid cookie or Basic Auth only (no token handling — the browser already
// carries the cookie set during the document's load).

const REALM = 'code-hub share';
const COOKIE_NAME = 'hub_auth';

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

// Hand-rolled Cookie header parse (no dependency): `k1=v1; k2=v2`.
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    if (k) out[k] = part.slice(eq + 1).trim();
  }
  return out;
}

function isCookieAuthed(req, cookieSecret) {
  const val = parseCookies(req.headers['cookie'])[COOKIE_NAME];
  return !!val && credsMatch(val, cookieSecret);
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
// Returns { port, username, password, token, close() }. Secrets are generated
// with a CSPRNG per call and held in memory only (never logged/persisted;
// the cookie secret is never even returned — only its cookie form matters).
// `host` defaults to loopback-only (cloudflared share); a LAN share passes
// '0.0.0.0' so other devices on the network can reach the proxy directly.
export function startAuthProxy(targetPort, { username = 'hub', host = '127.0.0.1' } = {}) {
  const password = crypto.randomBytes(18).toString('base64url');
  const expected = `${username}:${password}`;
  const token = crypto.randomBytes(18).toString('base64url');
  const cookieSecret = crypto.randomBytes(18).toString('base64url');
  const sockets = new Set();

  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url, 'http://placeholder'); // req.url is relative; base is discarded
    const providedToken = reqUrl.searchParams.get('__hubauth');

    // Token beats an existing cookie on purpose: it's how the first,
    // unauthenticated load of the share link becomes authenticated, and a
    // stale/foreign cookie must never shadow a fresh, valid token.
    if (providedToken !== null && credsMatch(providedToken, token)) {
      reqUrl.searchParams.delete('__hubauth');
      // No `Secure` attribute: LAN shares are plain http, and tunnel-mode
      // shares are plain http on this hop too (cloudflared terminates TLS
      // upstream and forwards http to the proxy) — `Secure` would make the
      // browser silently drop the cookie in both cases.
      res.writeHead(302, {
        'Set-Cookie': `${COOKIE_NAME}=${cookieSecret}; Path=/; HttpOnly; SameSite=Lax`,
        Location: reqUrl.pathname + reqUrl.search,
      });
      res.end();
      return;
    }

    if (!isCookieAuthed(req, cookieSecret) && !isAuthed(req, expected)) {
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

  // WebSocket / other upgrades: gate (cookie or Basic — no token handling),
  // then pipe raw sockets to the upstream.
  server.on('upgrade', (req, socket, head) => {
    if (!isCookieAuthed(req, cookieSecret) && !isAuthed(req, expected)) {
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
        token,
        close() {
          for (const s of sockets) { try { s.destroy(); } catch { /* gone */ } }
          sockets.clear();
          server.close();
        },
      });
    });
  });
}
