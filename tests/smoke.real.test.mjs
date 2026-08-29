import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import * as tunnel from '../src/tunnel.js';
import * as tailscale from '../src/tailscale.js';
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

// --- Real Tailscale Funnel (RUN_REAL_TAILSCALE=1) ---

const runTs = process.env.RUN_REAL_TAILSCALE === '1';

const funnelStatusJson = () => new Promise((resolve, reject) => {
  execFile('tailscale', ['funnel', 'status', '--json'], (err, stdout) => {
    if (err) return reject(err);
    try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
  });
});

// PURPOSE: pin that SIGTERM to the foreground `tailscale funnel` process
// actually REMOVES the funnel config. code-hub's whole teardown model rests on
// that one assumption about someone else's binary, and no fake can prove it —
// if it ever stops holding, `unshare` reports success while a public URL stays
// live in front of a dead proxy and the node's 443 stays occupied. Secondary:
// prove the public URL is gated end-to-end.
//
// The config check MUST read `funnel status --json`, not the text form: while
// a FOREGROUND funnel is live, `tailscale funnel status` prints "# Funnel on:"
// followed by "No serve config" — the handler lives under the JSON `Foreground`
// key and never enters the persistent serve config. Asserting on the text
// would therefore pass whether teardown worked or not. (Measured on 1.102.3.)
test('real tailscale funnel: gated end-to-end, and SIGTERM removes the funnel config', { skip: !runTs }, async () => {
  delete process.env.CODEHUB_TAILSCALE_BIN; // use the real binary in PATH
  assert.equal(await tailscale.available(), true);

  const before = await funnelStatusJson();

  const app = http.createServer((req, res) => { res.writeHead(200); res.end('ok'); });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const proxy = await startAuthProxy(app.address().port);

  let pid = null;
  try {
    const started = await tailscale.startFunnel(proxy.port);
    pid = started.pid;
    assert.match(started.url, /^https:\/\/[^/]+\.ts\.net$/);

    // Sanity: the check below can actually SEE a live funnel, so a passing
    // post-teardown assertion means something.
    const during = await funnelStatusJson();
    assert.notDeepEqual(during, before, 'funnel status --json reflects the live funnel');

    await waitFor(async () => {
      try { const r = await fetch(started.url, { redirect: 'manual' }); return r.status === 401; }
      catch { return false; }
    }, { timeout: 30000, interval: 1000 });

    const anon = await fetch(started.url);
    assert.equal(anon.status, 401);

    const authed = await fetch(started.url, { headers: { authorization: 'Basic ' + Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64') } });
    assert.equal(authed.status, 200);
    assert.equal(await authed.text(), 'ok');

    tailscale.stopFunnel(pid);
    await waitFor(() => !pidAlive(pid), { timeout: 5000 });
    pid = null;

    assert.deepEqual(await funnelStatusJson(), before,
      'SIGTERM to the foreground funnel restored the node config exactly — no funnel left registered');
  } finally {
    // This is the one test in the suite that can leave PUBLIC state behind.
    tailscale.stopFunnel(pid);
    proxy.close();
    app.close();
  }
});
