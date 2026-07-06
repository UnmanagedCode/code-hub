import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as tunnel from '../src/tunnel.js';
import { startAuthProxy } from '../src/authproxy.js';
import { waitFor, pidAlive } from './helpers.mjs';

// Gated real-dependency smoke test: exercises the ACTUAL cloudflared binary.
// Opt in with RUN_REAL_CLOUDFLARED=1 (needs network + cloudflared installed).
const run = process.env.RUN_REAL_CLOUDFLARED === '1';

test('real cloudflared quick tunnel yields a trycloudflare URL', { skip: !run }, async () => {
  delete process.env.CODEHUB_CLOUDFLARED_BIN; // use the real binary in PATH
  assert.equal(await tunnel.available(), true);
  const { url, pid } = await tunnel.startTunnel(65535);
  assert.match(url, /trycloudflare\.com$/);
  tunnel.stopTunnel(pid);
  await waitFor(() => !pidAlive(pid), { timeout: 5000 });
});

// End-to-end: a real cloudflared tunnel in front of the Basic-Auth proxy must
// reject anonymous requests (401) and accept credentialed ones (200), proving
// the public URL is password-protected over the internet.
test('real tunnel through auth proxy: 401 without creds, 200 with', { skip: !run }, async () => {
  delete process.env.CODEHUB_CLOUDFLARED_BIN;
  // Minimal upstream app.
  const app = http.createServer((req, res) => { res.writeHead(200); res.end('ok'); });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const appPort = app.address().port;

  const proxy = await startAuthProxy(appPort);
  const { url, pid } = await tunnel.startTunnel(proxy.port);
  try {
    // Give the edge a moment to propagate the new hostname.
    await waitFor(async () => {
      try { const r = await fetch(url, { redirect: 'manual' }); return r.status === 401; }
      catch { return false; }
    }, { timeout: 30000, interval: 1000 });

    const anon = await fetch(url);
    assert.equal(anon.status, 401);

    const authed = await fetch(url, { headers: { authorization: 'Basic ' + Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64') } });
    assert.equal(authed.status, 200);
    assert.equal(await authed.text(), 'ok');
  } finally {
    tunnel.stopTunnel(pid);
    proxy.close();
    app.close();
  }
});
