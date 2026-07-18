import http from 'node:http';
import https from 'node:https';
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
//
// `auth: false` (LAN shares only) skips all of the above entirely — every
// request and upgrade forwards unconditionally, no creds/token exist.
//
// `tls: { key, cert }` (LAN shares only) makes the proxy serve HTTPS instead of
// plain HTTP, so the token/cookie/Basic-Auth are encrypted on the LAN hop; the
// session cookie then also gets the `Secure` attribute. Tunnel-mode shares
// never pass `tls` — cloudflared terminates TLS upstream and forwards plain
// HTTP to this proxy, so a `Secure` cookie would be silently dropped there.

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
// Returns { port, auth, username, password, token, setCredentials(), setAuth(), close() }.
// Secrets are generated with a CSPRNG per call and held in memory only
// (never logged/persisted; the cookie secret is never even returned — only
// its cookie form matters). `host` defaults to loopback-only (cloudflared
// share); a LAN share passes '0.0.0.0' so other devices on the network can
// reach the proxy directly.
//
// Secrets (password/token/cookie secret) are ALWAYS generated, even when
// starting with `auth: false` — this is what lets `setAuth(true)` gate the
// proxy later with no restart and no new token, so a URL/QR handed out while
// unauthed (or before an off→on toggle) stays valid for the proxy's whole
// lifetime. `auth: false` only skips the gate itself: every HTTP request and
// WS upgrade is forwarded unconditionally, and `username`/`password` read as
// `null` (they're hidden, not absent) until auth is turned on.
export function startAuthProxy(targetPort, { username = 'hub', host = '127.0.0.1', auth = true, tls = null } = {}) {
  let currentUsername = username;
  let currentPassword = crypto.randomBytes(18).toString('base64url');
  let currentAuth = auth;
  const token = crypto.randomBytes(18).toString('base64url');
  const cookieSecret = crypto.randomBytes(18).toString('base64url');
  const secureCookie = Boolean(tls); // add `Secure` only when this hop is HTTPS
  const sockets = new Set();

  // Recomputed per call (not cached) so an in-place credential edit
  // (setCredentials) takes effect on the very next request.
  const isGateAuthed = (req) => isCookieAuthed(req, cookieSecret) || isAuthed(req, `${currentUsername}:${currentPassword}`);

  const handler = (req, res) => {
    const forward = () => {
      const up = http.request(
        { host: '127.0.0.1', port: targetPort, method: req.method, path: req.url, headers: req.headers },
        (upRes) => { res.writeHead(upRes.statusCode || 502, upRes.headers); upRes.pipe(res); },
      );
      up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.pipe(up);
    };

    if (!currentAuth) { forward(); return; }

    const reqUrl = new URL(req.url, 'http://placeholder'); // req.url is relative; base is discarded
    const providedToken = reqUrl.searchParams.get('__hubauth');

    // Token beats an existing cookie on purpose: it's how the first,
    // unauthenticated load of the share link becomes authenticated, and a
    // stale/foreign cookie must never shadow a fresh, valid token.
    if (providedToken !== null && credsMatch(providedToken, token)) {
      reqUrl.searchParams.delete('__hubauth');
      // `Secure` is added only for an HTTPS proxy (LAN TLS): the browser talks
      // https directly, so the cookie rides an encrypted hop. Plain-LAN and
      // tunnel-mode shares serve http on this hop (cloudflared terminates TLS
      // upstream and forwards http here), where `Secure` would make the browser
      // silently drop the cookie.
      const cookie = `${COOKIE_NAME}=${cookieSecret}; Path=/; HttpOnly; SameSite=Lax${secureCookie ? '; Secure' : ''}`;
      res.writeHead(302, {
        'Set-Cookie': cookie,
        Location: reqUrl.pathname + reqUrl.search,
      });
      res.end();
      return;
    }

    if (!isGateAuthed(req)) {
      res.writeHead(401, {
        'WWW-Authenticate': `Basic realm="${REALM}"`,
        'Content-Type': 'text/plain',
      });
      res.end('Authentication required\n');
      return;
    }
    forward();
  };

  // HTTPS when a cert is supplied (LAN TLS), else plain HTTP. The upgrade
  // handler and raw-socket upstream pipe below are identical either way — an
  // https server transparently hands the `upgrade` handler a TLS-wrapped
  // inbound socket, and the upstream leg is always a plain net.connect to
  // localhost.
  const server = tls ? https.createServer(tls, handler) : http.createServer(handler);

  // WebSocket / other upgrades: gate (cookie or Basic — no token handling),
  // then pipe raw sockets to the upstream.
  server.on('upgrade', (req, socket, head) => {
    if (currentAuth && !isGateAuthed(req)) {
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
        get auth() { return currentAuth; },
        get username() { return currentAuth ? currentUsername : null; },
        get password() { return currentAuth ? currentPassword : null; },
        token,
        // Mutates the expected Basic-Auth creds in place — no restart, so
        // the share URL/token/proxy port never change. Only meaningful when
        // `auth` is true; the caller (appManager) guards against calling
        // this on a no-auth share.
        setCredentials({ username: u, password: p } = {}) {
          if (u) currentUsername = u;
          if (p) currentPassword = p;
        },
        // Flips the gate itself in place — no restart, no new token/creds,
        // so a share URL/QR issued before the flip (in either direction)
        // stays valid. The caller (appManager) persists the new state and
        // only allows this for LAN shares (tunnel is always gated).
        setAuth(enabled) { currentAuth = !!enabled; },
        close() {
          for (const s of sockets) { try { s.destroy(); } catch { /* gone */ } }
          sockets.clear();
          server.close();
        },
      });
    });
  });
}
