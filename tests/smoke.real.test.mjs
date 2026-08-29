import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import dns from 'node:dns/promises';
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
// live in front of a dead proxy and the node's 443 stays occupied.
//
// It deliberately makes NO network request. The end-to-end gate check lives in
// its own test below, because it additionally needs the node's MagicDNS name to
// resolve from THIS host — which it does not, for instance, in a container
// whose /etc/resolv.conf points at a Docker resolver while tailscaled runs in
// userspace-networking mode. Gating this assertion behind that precondition
// once meant the contract the whole design rests on went unverified whenever
// the network was the thing that was broken.
//
// The config check MUST read `funnel status --json`, not the text form: while
// a FOREGROUND funnel is live, `tailscale funnel status` prints "# Funnel on:"
// followed by "No serve config" — the handler lives under the JSON `Foreground`
// key and never enters the persistent serve config. Asserting on the text
// would therefore pass whether teardown worked or not. (Measured on 1.102.3.)
test('real tailscale funnel: SIGTERM removes the funnel config', { skip: !runTs }, async () => {
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

    // Sanity: the check below can actually SEE a live funnel, so the
    // post-teardown assertion means something.
    assert.notDeepEqual(await funnelStatusJson(), before, 'funnel status --json reflects the live funnel');

    tailscale.stopFunnel(pid);
    await waitFor(() => !pidAlive(pid), { timeout: 5000 });
    pid = null;

    assert.deepEqual(await funnelStatusJson(), before,
      'SIGTERM to the foreground funnel restored the node config exactly — no funnel left registered');
  } finally {
    // This is the one place in the suite that can leave PUBLIC state behind.
    tailscale.stopFunnel(pid);
    proxy.close();
    app.close();
  }
});

// Whether this host can resolve its own MagicDNS name. Needed only by the
// end-to-end test below: a container using a non-Tailscale resolver (Docker's
// embedded 127.0.0.11) cannot, even though the funnel itself registers fine.
// Guarded the same way `altLoopbackBindable()` guards the alias-bind tests —
// a precondition that genuinely cannot hold here, not a swallowed failure.
async function magicDnsResolvable() {
  const name = await tailscale.magicDnsName();
  if (!name) return false;
  try { await dns.lookup(name); return true; } catch { return false; }
}

// Secondary: the public URL is gated end-to-end — 401 anonymous, 200 with
// credentials — proving the funnel fronts the auth proxy and not the app.
test('real tailscale funnel through auth proxy: 401 without creds, 200 with', { skip: !runTs }, async (t) => {
  delete process.env.CODEHUB_TAILSCALE_BIN;
  if (!(await magicDnsResolvable())) {
    t.skip('this host cannot resolve its own MagicDNS name (non-Tailscale resolver)');
    return;
  }

  const app = http.createServer((req, res) => { res.writeHead(200); res.end('ok'); });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const proxy = await startAuthProxy(app.address().port);

  let pid = null;
  try {
    const started = await tailscale.startFunnel(proxy.port);
    pid = started.pid;
    await waitFor(async () => {
      try { const r = await fetch(started.url, { redirect: 'manual' }); return r.status === 401; }
      catch { return false; }
    }, { timeout: 30000, interval: 1000 });

    const anon = await fetch(started.url);
    assert.equal(anon.status, 401);

    const authed = await fetch(started.url, { headers: { authorization: 'Basic ' + Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64') } });
    assert.equal(authed.status, 200);
    assert.equal(await authed.text(), 'ok');
  } finally {
    tailscale.stopFunnel(pid);
    proxy.close();
    app.close();
  }
});
