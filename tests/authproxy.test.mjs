import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { startAuthProxy } from '../src/authproxy.js';
import { generateSelfSigned } from '../src/selfsigned.js';

// A tiny raw upstream: serves "ok" for normal requests, and on a WS-style
// upgrade replies 101 then echoes bytes. Lets us prove the auth gate + the
// HTTP forward + the WS-upgrade raw pipe without pulling in a ws library.
function upstream() {
  const server = http.createServer((req, res) => { res.writeHead(200); res.end('ok'); });
  server.on('upgrade', (req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', (d) => socket.write(d)); // echo
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

const basic = (user, pass) => 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

// A self-signed cert for the loopback host — mirrors what appManager builds for
// a LAN HTTPS share. Global fetch (undici) ignores the http `agent` option, so
// TLS requests below go through https.request with rejectUnauthorized:false.
function lanCert() {
  return generateSelfSigned({ ipAddresses: ['127.0.0.1'], dnsNames: ['localhost'] });
}

// HTTPS GET against a self-signed proxy. Resolves { status, headers, body }.
function httpsGet(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port, path, headers, rejectUnauthorized: false }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

// Raw WS-upgrade handshake over a TLS socket (wss). Same shape as rawUpgrade.
function tlsUpgrade(port, authHeader, payload = 'PING', cookieHeader = null) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ port, host: '127.0.0.1', rejectUnauthorized: false }, () => {
      const lines = [
        'GET /ws HTTP/1.1', `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket', 'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13',
      ];
      if (authHeader) lines.push(`Authorization: ${authHeader}`);
      if (cookieHeader) lines.push(`Cookie: ${cookieHeader}`);
      sock.write(lines.join('\r\n') + '\r\n\r\n');
    });
    let buf = '', sent = false;
    sock.on('data', (d) => {
      buf += d.toString('binary');
      const statusLine = buf.split('\r\n')[0];
      if (!sent && buf.includes('\r\n\r\n')) {
        if (statusLine.startsWith('HTTP/1.1 101')) { sent = true; sock.write(payload); }
        else { sock.destroy(); resolve({ statusLine, echoed: false }); }
      } else if (sent) {
        const body = buf.split('\r\n\r\n').slice(1).join('\r\n\r\n');
        if (body.includes(payload)) { sock.destroy(); resolve({ statusLine, echoed: true }); }
      }
    });
    sock.on('error', reject);
    setTimeout(() => { sock.destroy(); resolve({ statusLine: buf.split('\r\n')[0] || '', echoed: false }); }, 2000).unref();
  });
}

// Raw WS-upgrade handshake over a bare TCP socket. Resolves with the status
// line and, on a 101, whether the payload we sent was echoed back.
function rawUpgrade(port, authHeader, payload = 'PING', cookieHeader = null) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      const lines = [
        'GET /ws HTTP/1.1', `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket', 'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13',
      ];
      if (authHeader) lines.push(`Authorization: ${authHeader}`);
      if (cookieHeader) lines.push(`Cookie: ${cookieHeader}`);
      sock.write(lines.join('\r\n') + '\r\n\r\n');
    });
    let buf = '', sent = false;
    sock.on('data', (d) => {
      buf += d.toString('binary');
      const statusLine = buf.split('\r\n')[0];
      if (!sent && buf.includes('\r\n\r\n')) {
        if (statusLine.startsWith('HTTP/1.1 101')) { sent = true; sock.write(payload); }
        else { sock.destroy(); resolve({ statusLine, echoed: false }); }
      } else if (sent) {
        const body = buf.split('\r\n\r\n').slice(1).join('\r\n\r\n');
        if (body.includes(payload)) { sock.destroy(); resolve({ statusLine, echoed: true }); }
      }
    });
    sock.on('error', reject);
    setTimeout(() => { sock.destroy(); resolve({ statusLine: buf.split('\r\n')[0] || '', echoed: false }); }, 2000).unref();
  });
}

test('rejects HTTP without / with wrong credentials, forwards with correct', async (t) => {
  const up = await upstream();
  const proxy = await startAuthProxy(up.port);
  t.after(() => { proxy.close(); up.server.close(); });

  const bad = await fetch(`http://127.0.0.1:${proxy.port}/`);
  assert.equal(bad.status, 401);
  assert.match(bad.headers.get('www-authenticate') || '', /Basic/);

  const wrong = await fetch(`http://127.0.0.1:${proxy.port}/`, { headers: { authorization: basic('hub', 'nope') } });
  assert.equal(wrong.status, 401);

  const ok = await fetch(`http://127.0.0.1:${proxy.port}/`, { headers: { authorization: basic(proxy.username, proxy.password) } });
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), 'ok');
});

test('gates and forwards WebSocket upgrades', async (t) => {
  const up = await upstream();
  const proxy = await startAuthProxy(up.port);
  t.after(() => { proxy.close(); up.server.close(); });

  const noauth = await rawUpgrade(proxy.port, null);
  assert.match(noauth.statusLine, /401/);
  assert.equal(noauth.echoed, false);

  const wrong = await rawUpgrade(proxy.port, basic('hub', 'nope'));
  assert.match(wrong.statusLine, /401/);

  const good = await rawUpgrade(proxy.port, basic(proxy.username, proxy.password));
  assert.match(good.statusLine, /101/);
  assert.equal(good.echoed, true); // bytes round-tripped through the authed tunnel
});

test('token in the query sets a cookie and redirects, stripping only __hubauth', async (t) => {
  const up = await upstream();
  const proxy = await startAuthProxy(up.port);
  t.after(() => { proxy.close(); up.server.close(); });

  const res = await fetch(
    `http://127.0.0.1:${proxy.port}/some/path?__hubauth=${proxy.token}&keep=1`,
    { redirect: 'manual' },
  );
  assert.equal(res.status, 302);
  const setCookie = res.headers.get('set-cookie') || '';
  assert.match(setCookie, /^hub_auth=[^;]+; Path=\/; HttpOnly; SameSite=Lax$/);
  assert.equal(res.headers.get('location'), '/some/path?keep=1');
});

test('cookie obtained via token exchange authenticates subsequent HTTP requests', async (t) => {
  const up = await upstream();
  const proxy = await startAuthProxy(up.port);
  t.after(() => { proxy.close(); up.server.close(); });

  const exchange = await fetch(`http://127.0.0.1:${proxy.port}/?__hubauth=${proxy.token}`, { redirect: 'manual' });
  const cookie = (exchange.headers.get('set-cookie') || '').split(';')[0]; // "hub_auth=<secret>"
  assert.match(cookie, /^hub_auth=.+/);

  const ok = await fetch(`http://127.0.0.1:${proxy.port}/`, { headers: { cookie } }); // no Authorization
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), 'ok');
});

test('cookie obtained via token exchange authenticates a WS upgrade', async (t) => {
  const up = await upstream();
  const proxy = await startAuthProxy(up.port);
  t.after(() => { proxy.close(); up.server.close(); });

  const exchange = await fetch(`http://127.0.0.1:${proxy.port}/?__hubauth=${proxy.token}`, { redirect: 'manual' });
  const cookie = (exchange.headers.get('set-cookie') || '').split(';')[0];

  const good = await rawUpgrade(proxy.port, null, 'PING', cookie);
  assert.match(good.statusLine, /101/);
  assert.equal(good.echoed, true); // bytes round-tripped through the cookie-authed tunnel
});

test('close() stops the proxy listening', async (t) => {
  const up = await upstream();
  const proxy = await startAuthProxy(up.port);
  t.after(() => up.server.close());
  proxy.close();
  await assert.rejects(fetch(`http://127.0.0.1:${proxy.port}/`));
});

test('binds to a custom host (0.0.0.0) while still reachable via 127.0.0.1', async (t) => {
  const up = await upstream();
  const proxy = await startAuthProxy(up.port, { host: '0.0.0.0' });
  t.after(() => { proxy.close(); up.server.close(); });

  const bad = await fetch(`http://127.0.0.1:${proxy.port}/`);
  assert.equal(bad.status, 401);

  const ok = await fetch(`http://127.0.0.1:${proxy.port}/`, { headers: { authorization: basic(proxy.username, proxy.password) } });
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), 'ok');
});

test('generates a strong random password and token per share', async (t) => {
  const up = await upstream();
  const p1 = await startAuthProxy(up.port);
  const p2 = await startAuthProxy(up.port);
  t.after(() => { p1.close(); p2.close(); up.server.close(); });
  assert.equal(p1.username, 'hub');
  assert.ok(p1.password.length >= 20);
  assert.notEqual(p1.password, p2.password);
  assert.ok(p1.token.length >= 20);
  assert.notEqual(p1.token, p2.token);
});

test('auth:false forwards every HTTP request with no gate, but still pre-generates creds', async (t) => {
  const up = await upstream();
  const proxy = await startAuthProxy(up.port, { auth: false });
  t.after(() => { proxy.close(); up.server.close(); });

  assert.equal(proxy.auth, false);
  assert.equal(proxy.username, null); // hidden while ungated, not absent — see setAuth tests below
  assert.equal(proxy.password, null);
  assert.equal(typeof proxy.token, 'string'); // always generated, so a later setAuth(true) needs no new token
  assert.ok(proxy.token.length >= 20);

  const res = await fetch(`http://127.0.0.1:${proxy.port}/`); // no Authorization, no token
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'ok');
});

test('auth:false forwards WebSocket upgrades with no gate', async (t) => {
  const up = await upstream();
  const proxy = await startAuthProxy(up.port, { auth: false });
  t.after(() => { proxy.close(); up.server.close(); });

  const res = await rawUpgrade(proxy.port, null); // no Authorization
  assert.match(res.statusLine, /101/);
  assert.equal(res.echoed, true);
});

test('setCredentials updates the expected Basic-Auth pair in place, no restart', async (t) => {
  const up = await upstream();
  const proxy = await startAuthProxy(up.port);
  t.after(() => { proxy.close(); up.server.close(); });
  const originalPort = proxy.port;
  const originalToken = proxy.token;
  const originalPassword = proxy.password;

  const before = await fetch(`http://127.0.0.1:${proxy.port}/`, { headers: { authorization: basic(proxy.username, proxy.password) } });
  assert.equal(before.status, 200);

  proxy.setCredentials({ username: 'alice', password: 'a-new-strong-password' });
  assert.equal(proxy.username, 'alice');
  assert.equal(proxy.password, 'a-new-strong-password');
  assert.equal(proxy.port, originalPort); // same server, no teardown/recreate
  assert.equal(proxy.token, originalToken);

  const rejectedOld = await fetch(`http://127.0.0.1:${proxy.port}/`, { headers: { authorization: basic('hub', originalPassword) } });
  assert.equal(rejectedOld.status, 401);

  const authedNew = await fetch(`http://127.0.0.1:${proxy.port}/`, { headers: { authorization: basic('alice', 'a-new-strong-password') } });
  assert.equal(authedNew.status, 200);
  assert.equal(await authedNew.text(), 'ok');
});

test('setAuth flips the gate in place, no restart, over HTTP', async (t) => {
  const up = await upstream();
  const proxy = await startAuthProxy(up.port);
  t.after(() => { proxy.close(); up.server.close(); });
  const originalPort = proxy.port;
  const originalToken = proxy.token;
  const { username, password } = proxy;

  proxy.setAuth(false);
  assert.equal(proxy.auth, false);
  assert.equal(proxy.username, null);
  assert.equal(proxy.password, null);
  const openWhileOff = await fetch(`http://127.0.0.1:${proxy.port}/`); // no Authorization at all
  assert.equal(openWhileOff.status, 200);

  proxy.setAuth(true);
  assert.equal(proxy.auth, true);
  assert.equal(proxy.username, username); // same creds — never regenerated by setAuth
  assert.equal(proxy.password, password);
  assert.equal(proxy.port, originalPort);
  assert.equal(proxy.token, originalToken);

  const gatedNoAuth = await fetch(`http://127.0.0.1:${proxy.port}/`);
  assert.equal(gatedNoAuth.status, 401);
  const gatedAuthed = await fetch(`http://127.0.0.1:${proxy.port}/`, { headers: { authorization: basic(username, password) } });
  assert.equal(gatedAuthed.status, 200);
  assert.equal(await gatedAuthed.text(), 'ok');
});

test('setAuth flips the gate in place, no restart, over a WS upgrade', async (t) => {
  const up = await upstream();
  const proxy = await startAuthProxy(up.port);
  t.after(() => { proxy.close(); up.server.close(); });
  const { username, password } = proxy;

  proxy.setAuth(false);
  const openWhileOff = await rawUpgrade(proxy.port, null);
  assert.match(openWhileOff.statusLine, /101/);
  assert.equal(openWhileOff.echoed, true);

  proxy.setAuth(true);
  const gatedNoAuth = await rawUpgrade(proxy.port, null);
  assert.match(gatedNoAuth.statusLine, /401/);
  const gatedAuthed = await rawUpgrade(proxy.port, basic(username, password));
  assert.match(gatedAuthed.statusLine, /101/);
  assert.equal(gatedAuthed.echoed, true);
});

test('a proxy started auth:false can setAuth(true) using creds pre-generated at construction', async (t) => {
  const up = await upstream();
  const proxy = await startAuthProxy(up.port, { auth: false });
  t.after(() => { proxy.close(); up.server.close(); });
  const originalToken = proxy.token;

  proxy.setAuth(true);
  assert.equal(proxy.auth, true);
  assert.equal(proxy.token, originalToken); // no regeneration — a pre-toggle authUrl/QR stays valid
  const { username, password } = proxy;
  assert.equal(typeof username, 'string');
  assert.equal(typeof password, 'string');

  const httpNoAuth = await fetch(`http://127.0.0.1:${proxy.port}/`);
  assert.equal(httpNoAuth.status, 401);
  const httpAuthed = await fetch(`http://127.0.0.1:${proxy.port}/`, { headers: { authorization: basic(username, password) } });
  assert.equal(httpAuthed.status, 200);

  const wsNoAuth = await rawUpgrade(proxy.port, null);
  assert.match(wsNoAuth.statusLine, /401/);
  const wsAuthed = await rawUpgrade(proxy.port, basic(username, password));
  assert.match(wsAuthed.statusLine, /101/);
  assert.equal(wsAuthed.echoed, true);
});

test('tls: serves HTTPS, gates and forwards, and sets a Secure cookie on token exchange', async (t) => {
  const up = await upstream();
  const proxy = await startAuthProxy(up.port, { host: '0.0.0.0', tls: lanCert() });
  t.after(() => { proxy.close(); up.server.close(); });

  const bad = await httpsGet(proxy.port, '/');
  assert.equal(bad.status, 401);
  assert.match(bad.headers['www-authenticate'] || '', /Basic/);

  // Token exchange over HTTPS sets the session cookie WITH `Secure`.
  const redirect = await httpsGet(proxy.port, `/some/path?__hubauth=${proxy.token}&keep=1`);
  assert.equal(redirect.status, 302);
  const setCookie = (redirect.headers['set-cookie'] || [])[0] || '';
  assert.match(setCookie, /^hub_auth=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Secure$/);
  assert.equal(redirect.headers.location, '/some/path?keep=1');

  // Basic-Auth still forwards over HTTPS.
  const ok = await httpsGet(proxy.port, '/', { authorization: basic(proxy.username, proxy.password) });
  assert.equal(ok.status, 200);
  assert.equal(ok.body, 'ok');

  // Cookie obtained via the exchange authenticates a follow-up HTTPS request.
  const cookie = setCookie.split(';')[0];
  const viaCookie = await httpsGet(proxy.port, '/', { cookie });
  assert.equal(viaCookie.status, 200);
});

test('tls: forwards a WebSocket upgrade over wss', async (t) => {
  const up = await upstream();
  const proxy = await startAuthProxy(up.port, { host: '0.0.0.0', tls: lanCert() });
  t.after(() => { proxy.close(); up.server.close(); });

  const noauth = await tlsUpgrade(proxy.port, null);
  assert.match(noauth.statusLine, /401/);

  const good = await tlsUpgrade(proxy.port, basic(proxy.username, proxy.password));
  assert.match(good.statusLine, /101/);
  assert.equal(good.echoed, true); // bytes round-tripped through the TLS-fronted tunnel
});

test('no tls (tunnel/plain-LAN hop): token cookie omits Secure', async (t) => {
  // Regression guard: the shared code path must NOT set `Secure` on the plain
  // HTTP hop — cloudflared forwards http to the proxy, where a Secure cookie
  // would be silently dropped by the browser.
  const up = await upstream();
  const proxy = await startAuthProxy(up.port); // default: no tls, loopback (tunnel-style)
  t.after(() => { proxy.close(); up.server.close(); });

  const res = await fetch(`http://127.0.0.1:${proxy.port}/?__hubauth=${proxy.token}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  const setCookie = res.headers.get('set-cookie') || '';
  assert.doesNotMatch(setCookie, /Secure/);
});

// --- Pinned port + multi-address bind (backs the fixed-port LAN share) ---

// Two loopback aliases keep these host-independent: 127.0.0.2 behaves like a
// distinct address on Linux without needing a real LAN interface.
const ALT_LOOPBACK = '127.0.0.2';
async function altLoopbackBindable() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.on('error', () => resolve(false));
    s.listen(0, ALT_LOOPBACK, () => s.close(() => resolve(true)));
  });
}

test('startAuthProxy listens on exactly the requested port', async (t) => {
  const up = await upstream();
  const free = await new Promise((r) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); });
  });
  const proxy = await startAuthProxy(up.port, { port: free });
  t.after(() => { proxy.close(); up.server.close(); });

  assert.equal(proxy.port, free);
  const res = await fetch(`http://127.0.0.1:${free}/?__hubauth=${proxy.token}`, { redirect: 'manual' });
  assert.equal(res.status, 302); // it really is our proxy on that port
});

test('an array of hosts serves ONE shared port on every address, and close() stops them all', async (t) => {
  if (!(await altLoopbackBindable())) return t.skip(`${ALT_LOOPBACK} is not bindable on this host`);
  const up = await upstream();
  const proxy = await startAuthProxy(up.port, { host: ['127.0.0.1', ALT_LOOPBACK] });
  t.after(() => up.server.close());

  assert.deepEqual(proxy.hosts, ['127.0.0.1', ALT_LOOPBACK]);
  // The kernel-assigned port from the FIRST bind must be reused for the rest —
  // a per-address port would make the share URL wrong on all but one address.
  const creds = { authorization: basic(proxy.username, proxy.password) };
  for (const h of ['127.0.0.1', ALT_LOOPBACK]) {
    const res = await fetch(`http://${h}:${proxy.port}/`, { headers: creds });
    assert.equal(res.status, 200, `${h} must serve on the shared port`);
    assert.equal(await res.text(), 'ok');
  }

  proxy.close();
  await assert.rejects(fetch(`http://127.0.0.1:${proxy.port}/`, { headers: creds }));
  await assert.rejects(fetch(`http://${ALT_LOOPBACK}:${proxy.port}/`, { headers: creds }));
});

test('a pinned port already held rejects with EADDRINUSE and leaves nothing listening', async (t) => {
  if (!(await altLoopbackBindable())) return t.skip(`${ALT_LOOPBACK} is not bindable on this host`);
  const up = await upstream();
  t.after(() => up.server.close());

  // Hold the port on the SECOND address only, so the first bind succeeds and
  // the second fails — the partial-bind case. Without the cleanup pass, the
  // first server would be left listening and orphaned.
  const blocker = net.createServer();
  const port = await new Promise((r) => blocker.listen(0, ALT_LOOPBACK, () => r(blocker.address().port)));
  t.after(() => new Promise((r) => blocker.close(r)));

  await assert.rejects(
    () => startAuthProxy(up.port, { host: ['127.0.0.1', ALT_LOOPBACK], port }),
    (e) => e.code === 'EADDRINUSE',
  );
  // 127.0.0.1:port must be free again — nothing was leaked.
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', resolve);
  });
  await new Promise((r) => probe.close(r));
});
