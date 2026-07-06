import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { startAuthProxy } from '../src/authproxy.js';

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

// Raw WS-upgrade handshake over a bare TCP socket. Resolves with the status
// line and, on a 101, whether the payload we sent was echoed back.
function rawUpgrade(port, authHeader, payload = 'PING') {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      const lines = [
        'GET /ws HTTP/1.1', `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket', 'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13',
      ];
      if (authHeader) lines.push(`Authorization: ${authHeader}`);
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

test('close() stops the proxy listening', async (t) => {
  const up = await upstream();
  const proxy = await startAuthProxy(up.port);
  t.after(() => up.server.close());
  proxy.close();
  await assert.rejects(fetch(`http://127.0.0.1:${proxy.port}/`));
});

test('generates a strong random password per share', async (t) => {
  const up = await upstream();
  const p1 = await startAuthProxy(up.port);
  const p2 = await startAuthProxy(up.port);
  t.after(() => { p1.close(); p2.close(); up.server.close(); });
  assert.equal(p1.username, 'hub');
  assert.ok(p1.password.length >= 20);
  assert.notEqual(p1.password, p2.password);
});
