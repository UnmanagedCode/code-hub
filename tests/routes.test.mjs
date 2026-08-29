import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import { createServer } from '../server.js';
import * as appManager from '../src/appManager.js';
import { qrSvg } from '../src/qr.js';
import { storeRoot } from '../src/projects.js';
import net from 'node:net';
import { localIPv4s } from '../src/net.js';
import { mkRoot, rmRoot, mkProject, gitCommit, waitFor, fakeAppCmd, fakeCloudflaredBin, fakeTailscaleBin, pidAlive, ALT_LOOPBACK, altLoopbackBindable } from './helpers.mjs';

const basicAuth = (user, pass) => 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

// HTTPS GET against a self-signed LAN proxy (undici's fetch ignores TLS opts).
const httpsGet = (port, path, headers = {}) => new Promise((resolve, reject) => {
  const req = https.request({ host: '127.0.0.1', port, path, headers, rejectUnauthorized: false }, (res) => {
    let body = '';
    res.on('data', (d) => (body += d));
    res.on('end', () => resolve({ status: res.statusCode, body }));
  });
  req.on('error', reject);
  req.end();
});

async function boot(root) {
  process.env.CODEHUB_CLOUDFLARED_BIN = fakeCloudflaredBin;
  process.env.CODEHUB_TAILSCALE_BIN = fakeTailscaleBin;
  await appManager.init();
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base };
}

const j = async (base, method, path, body) => {
  const r = await fetch(base + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json() };
};

test('full lifecycle over HTTP: discover → start → share → out-of-date → stop', async (t) => {
  const root = await mkRoot();
  const dir = await mkProject(root, 'app', { start: fakeAppCmd() }, { git: true });
  const { server, base } = await boot(root);
  t.after(async () => { await appManager.stop('app').catch(() => {}); server.close(); await rmRoot(root); });

  // health
  let res = await j(base, 'GET', '/api/health');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });

  // discover
  res = await j(base, 'GET', '/api/apps');
  assert.equal(res.status, 200);
  assert.equal(res.body.cloudflaredAvailable, true);
  const app0 = res.body.apps.find((a) => a.id === 'app');
  assert.equal(app0.status, 'stopped');

  // start
  res = await j(base, 'POST', '/api/apps/app/start');
  assert.equal(res.status, 200);
  assert.ok(res.body.port);

  await waitFor(async () => {
    const { body } = await j(base, 'GET', '/api/apps');
    return ['ready', 'running'].includes(body.apps.find((a) => a.id === 'app').status);
  });
  res = await j(base, 'GET', '/api/apps');
  const running = res.body.apps.find((a) => a.id === 'app');
  assert.ok(running.urls.some((u) => u.startsWith('http://localhost:')));
  assert.equal(running.outOfDate, false);

  // share
  res = await j(base, 'POST', '/api/apps/app/share');
  assert.equal(res.status, 200);
  assert.match(res.body.url, /trycloudflare\.com$/);
  assert.match(res.body.qrSvg, /<svg/);

  // out-of-date after a new commit in the source dir
  gitCommit(dir);
  await waitFor(async () => {
    const { body } = await j(base, 'GET', '/api/apps');
    return body.apps.find((a) => a.id === 'app').outOfDate === true;
  });

  // stop (also tears down the tunnel)
  res = await j(base, 'POST', '/api/apps/app/stop');
  assert.equal(res.status, 200);
  await waitFor(async () => {
    const { body } = await j(base, 'GET', '/api/apps');
    return body.apps.find((a) => a.id === 'app').status === 'stopped';
  });
});

test('a crashed app keeps manifestError null and can be restarted from the UI', async (t) => {
  const root = await mkRoot();
  await mkProject(root, 'app', { start: fakeAppCmd('crash') }, { git: true });
  const { server, base } = await boot(root);
  t.after(async () => { await appManager.stop('app').catch(() => {}); server.close(); await rmRoot(root); });

  let res = await j(base, 'POST', '/api/apps/app/start');
  assert.equal(res.status, 200);

  await waitFor(async () => {
    const { body } = await j(base, 'GET', '/api/apps');
    return body.apps.find((a) => a.id === 'app').status === 'crashed';
  });
  res = await j(base, 'GET', '/api/apps');
  const crashed = res.body.apps.find((a) => a.id === 'app');
  assert.equal(crashed.manifestError, null);
  assert.match(crashed.error, /exited|boom/);

  // restart isn't blocked by the crash tail
  res = await j(base, 'POST', '/api/apps/app/start');
  assert.equal(res.status, 200);
});

test('unknown app id → 404, and share on a stopped app → 409', async (t) => {
  const root = await mkRoot();
  await mkProject(root, 'app', { start: fakeAppCmd() });
  const { server, base } = await boot(root);
  t.after(async () => { server.close(); await rmRoot(root); });

  assert.equal((await j(base, 'POST', '/api/apps/nope/start')).status, 404);
  assert.equal((await j(base, 'POST', '/api/apps/app/share')).status, 409);
});

test('App shape carries per-route URLs and lastCommitAt', async (t) => {
  const root = await mkRoot();
  await mkProject(root, 'multi', {
    start: fakeAppCmd(),
    routes: [{ name: 'Main', path: '/' }, { name: 'Editor', path: '/edit.html' }],
  }, { git: true });
  await mkProject(root, 'plain', { start: fakeAppCmd() }, { git: true }); // no routes → implicit single '/'
  const { server, base } = await boot(root);
  t.after(async () => { await appManager.stop('multi').catch(() => {}); server.close(); await rmRoot(root); });

  // A git-tracked app reports its last commit date, even while stopped.
  let { body } = await j(base, 'GET', '/api/apps');
  assert.match(body.apps.find((a) => a.id === 'multi').lastCommitAt, /^\d{4}-\d{2}-\d{2}T/);

  // A manifest without routes exposes a single implicit '/' route.
  const plain = body.apps.find((a) => a.id === 'plain');
  assert.equal(plain.routes.length, 1);
  assert.equal(plain.routes[0].path, '/');

  // Start the multi-route app and check per-route URL enumeration.
  await j(base, 'POST', '/api/apps/multi/start');
  await waitFor(async () => {
    const r = await j(base, 'GET', '/api/apps');
    return ['ready', 'running'].includes(r.body.apps.find((a) => a.id === 'multi').status);
  });
  ({ body } = await j(base, 'GET', '/api/apps'));
  const multi = body.apps.find((a) => a.id === 'multi');
  assert.deepEqual(multi.routes.map((r) => r.name), ['Main', 'Editor']);
  assert.ok(multi.routes[0].urls.includes(`http://localhost:${multi.port}`));
  assert.ok(multi.routes[1].urls.includes(`http://localhost:${multi.port}/edit.html`));
});

test('share stands up a Basic-Auth proxy; unshare tears it down', async (t) => {
  const root = await mkRoot();
  await mkProject(root, 'app', { start: fakeAppCmd() }, { git: true });
  const { server, base } = await boot(root);
  t.after(async () => { await appManager.stop('app').catch(() => {}); server.close(); await rmRoot(root); });

  await j(base, 'POST', '/api/apps/app/start');
  await waitFor(async () => ['ready', 'running'].includes((await j(base, 'GET', '/api/apps')).body.apps.find((a) => a.id === 'app').status));

  const res = await j(base, 'POST', '/api/apps/app/share');
  assert.equal(res.status, 200);
  assert.equal(res.body.username, 'hub');
  assert.ok(res.body.password.length >= 20);
  assert.match(res.body.authUrl, /^https:\/\/.+\.trycloudflare\.com\?__hubauth=[\w-]+$/);
  assert.match(res.body.qrSvg, /<svg/);

  // list() exposes username + proxyPort + the live password (persists across
  // a poll/reload; sourced from the in-memory proxy, never state.json).
  const app = (await j(base, 'GET', '/api/apps')).body.apps.find((a) => a.id === 'app');
  assert.equal(app.tunnel.username, 'hub');
  assert.ok(app.tunnel.proxyPort > 0);
  assert.equal(app.tunnel.auth, true);
  assert.equal(app.tunnel.password, res.body.password);

  // list() also rebuilds authUrl (magic-link, from the live proxy token) and
  // serves a cached qrSvg — so the QR and Open magic-link survive a full UI
  // refresh that wipes the client's in-memory share response. authUrl must
  // carry the same token the proxy holds (matching the share response's).
  assert.ok(app.tunnel.authUrl);
  assert.equal(app.tunnel.authUrl, res.body.authUrl);
  assert.match(app.tunnel.qrSvg, /<svg/);
  // Two list() calls with no intervening change return the SAME qrSvg (cache
  // hit — no per-poll QR re-render).
  const app2 = (await j(base, 'GET', '/api/apps')).body.apps.find((a) => a.id === 'app');
  assert.equal(app2.tunnel.qrSvg, app.tunnel.qrSvg);
  assert.equal(app2.tunnel.authUrl, app.tunnel.authUrl);

  // The proxy (which cloudflared points at) enforces auth and forwards to the app.
  const pp = app.tunnel.proxyPort;
  const noauth = await fetch(`http://127.0.0.1:${pp}/`);
  assert.equal(noauth.status, 401);
  assert.match(noauth.headers.get('www-authenticate') || '', /Basic/);
  const authed = await fetch(`http://127.0.0.1:${pp}/`, { headers: { authorization: basicAuth('hub', res.body.password) } });
  assert.equal(authed.status, 200);
  assert.equal(await authed.text(), 'ok');

  // unshare closes the proxy (port no longer accepts connections).
  await j(base, 'DELETE', '/api/apps/app/share');
  await assert.rejects(fetch(`http://127.0.0.1:${pp}/`));
});

test('share mode=lan stands up an HTTP proxy without cloudflared', async (t) => {
  const root = await mkRoot();
  await mkProject(root, 'app', { start: fakeAppCmd() }, { git: true });
  process.env.CODEHUB_CLOUDFLARED_BIN = '/nonexistent/cloudflared'; // prove no cloudflared dependency
  const { server, base } = await boot(root);
  t.after(async () => { await appManager.stop('app').catch(() => {}); server.close(); await rmRoot(root); process.env.CODEHUB_CLOUDFLARED_BIN = fakeCloudflaredBin; });

  await j(base, 'POST', '/api/apps/app/start');
  await waitFor(async () => ['ready', 'running'].includes((await j(base, 'GET', '/api/apps')).body.apps.find((a) => a.id === 'app').status));

  const res = await j(base, 'POST', '/api/apps/app/share', { mode: 'lan', tls: false });
  assert.equal(res.status, 200);
  assert.equal(res.body.kind, 'lan');
  assert.equal(res.body.tls, false);
  assert.match(res.body.authUrl, /^http:\/\/.+\?__hubauth=[\w-]+$/);
  assert.equal(res.body.username, 'hub');
  assert.ok(Array.isArray(res.body.urls));

  // list() exposes kind/urls + the live password (see the tunnel-mode test above).
  const app = (await j(base, 'GET', '/api/apps')).body.apps.find((a) => a.id === 'app');
  assert.equal(app.tunnel.kind, 'lan');
  assert.ok(Array.isArray(app.tunnel.urls));
  assert.equal(app.tunnel.auth, true);
  assert.equal(app.tunnel.password, res.body.password);

  // The proxy (bound 0.0.0.0) is reachable + auth-gated over loopback.
  const pp = app.tunnel.proxyPort;
  const noauth = await fetch(`http://127.0.0.1:${pp}/`);
  assert.equal(noauth.status, 401);
  const authed = await fetch(`http://127.0.0.1:${pp}/`, { headers: { authorization: basicAuth('hub', res.body.password) } });
  assert.equal(authed.status, 200);
  assert.equal(await authed.text(), 'ok');

  // unshare tears down a LAN share same as a tunnel share.
  await j(base, 'DELETE', '/api/apps/app/share');
  await assert.rejects(fetch(`http://127.0.0.1:${pp}/`));
});

test('share mode=lan defaults to HTTPS (self-signed): tls:true, https URLs, reachable + gated over TLS', async (t) => {
  const root = await mkRoot();
  await mkProject(root, 'app', { start: fakeAppCmd() }, { git: true });
  const { server, base } = await boot(root); // no tls flag → default on
  t.after(async () => { await appManager.stop('app').catch(() => {}); server.close(); await rmRoot(root); });

  await j(base, 'POST', '/api/apps/app/start');
  await waitFor(async () => ['ready', 'running'].includes((await j(base, 'GET', '/api/apps')).body.apps.find((a) => a.id === 'app').status));

  const res = await j(base, 'POST', '/api/apps/app/share', { mode: 'lan' }); // no tls flag → default
  assert.equal(res.status, 200);
  assert.equal(res.body.tls, true);
  assert.match(res.body.authUrl, /^https:\/\/.+\?__hubauth=[\w-]+$/);
  assert.ok(res.body.urls.every((u) => u.startsWith('https://')));

  const app = (await j(base, 'GET', '/api/apps')).body.apps.find((a) => a.id === 'app');
  assert.equal(app.tunnel.tls, true);
  const pp = app.tunnel.proxyPort;

  // The proxy serves HTTPS: plain-HTTP fetch fails the handshake; HTTPS is gated + forwards.
  await assert.rejects(fetch(`http://127.0.0.1:${pp}/`));
  const noauth = await httpsGet(pp, '/');
  assert.equal(noauth.status, 401);
  const authed = await httpsGet(pp, '/', { authorization: basicAuth('hub', res.body.password) });
  assert.equal(authed.status, 200);
  assert.equal(authed.body, 'ok');
});

test('re-sharing a LAN app with a different tls swaps the scheme on a fresh proxy', async (t) => {
  // This is the path the UI's Edit-form TLS toggle drives on Save: TLS can't
  // flip in place, so Save re-shares. Asserts the fresh proxy (new port), the
  // scheme swap, teardown of the old proxy, and creds set after the re-share.
  const root = await mkRoot();
  await mkProject(root, 'app', { start: fakeAppCmd() }, { git: true });
  const { server, base } = await boot(root);
  t.after(async () => { await appManager.stop('app').catch(() => {}); server.close(); await rmRoot(root); });

  await j(base, 'POST', '/api/apps/app/start');
  await waitFor(async () => ['ready', 'running'].includes((await j(base, 'GET', '/api/apps')).body.apps.find((a) => a.id === 'app').status));

  // Default share is HTTPS (TLS on when the flag is absent).
  const https = await j(base, 'POST', '/api/apps/app/share', { mode: 'lan' });
  assert.equal(https.body.tls, true);
  const before = (await j(base, 'GET', '/api/apps')).body.apps.find((a) => a.id === 'app').tunnel.proxyPort;

  // Re-share with tls:false → plain HTTP on a brand-new proxy; the old one is gone.
  const plain = await j(base, 'POST', '/api/apps/app/share', { mode: 'lan', tls: false });
  assert.equal(plain.body.tls, false);
  assert.match(plain.body.authUrl, /^http:\/\//);
  const after = (await j(base, 'GET', '/api/apps')).body.apps.find((a) => a.id === 'app').tunnel.proxyPort;
  assert.notEqual(after, before);
  await assert.rejects(fetch(`http://127.0.0.1:${before}/`));

  // The fresh proxy is reachable, gated, and accepts creds applied after the re-share.
  await j(base, 'PATCH', '/api/apps/app/share/credentials', { username: 'alice', password: 'secret1' });
  const authed = await fetch(`http://127.0.0.1:${after}/`, { headers: { authorization: basicAuth('alice', 'secret1') } });
  assert.equal(authed.status, 200);
  assert.equal(await authed.text(), 'ok');
});

test('share with a non-boolean tls → 400', async (t) => {
  const root = await mkRoot();
  await mkProject(root, 'app', { start: fakeAppCmd() }, { git: true });
  const { server, base } = await boot(root);
  t.after(async () => { await appManager.stop('app').catch(() => {}); server.close(); await rmRoot(root); });

  await j(base, 'POST', '/api/apps/app/start');
  await waitFor(async () => ['ready', 'running'].includes((await j(base, 'GET', '/api/apps')).body.apps.find((a) => a.id === 'app').status));

  const res = await j(base, 'POST', '/api/apps/app/share', { mode: 'lan', tls: 'yes' });
  assert.equal(res.status, 400);
});

test('share mode=lan, auth=false stands up an ungated proxy (no creds, no token gate)', async (t) => {
  const root = await mkRoot();
  await mkProject(root, 'app', { start: fakeAppCmd() }, { git: true });
  const { server, base } = await boot(root);
  t.after(async () => { await appManager.stop('app').catch(() => {}); server.close(); await rmRoot(root); });

  await j(base, 'POST', '/api/apps/app/start');
  await waitFor(async () => ['ready', 'running'].includes((await j(base, 'GET', '/api/apps')).body.apps.find((a) => a.id === 'app').status));

  const res = await j(base, 'POST', '/api/apps/app/share', { mode: 'lan', auth: false, tls: false });
  assert.equal(res.status, 200);
  assert.equal(res.body.kind, 'lan');
  assert.equal(res.body.auth, false);
  assert.equal(res.body.username, undefined);
  assert.equal(res.body.password, undefined);
  assert.equal(res.body.authUrl, undefined);
  assert.match(res.body.qrSvg, /<svg/); // still handy to scan-to-open

  const app = (await j(base, 'GET', '/api/apps')).body.apps.find((a) => a.id === 'app');
  assert.equal(app.tunnel.auth, false);
  assert.equal(app.tunnel.username, null);
  assert.equal(app.tunnel.password, null);
  // A no-auth share has no magic-link, but list() still serves the plain-url QR
  // so the QR survives a UI refresh (the only thing worth scanning is the URL).
  assert.equal(app.tunnel.authUrl, undefined);
  assert.match(app.tunnel.qrSvg, /<svg/);

  // No gate at all: a bare, header-less request reaches the app directly.
  const pp = app.tunnel.proxyPort;
  const forwarded = await fetch(`http://127.0.0.1:${pp}/`);
  assert.equal(forwarded.status, 200);
  assert.equal(await forwarded.text(), 'ok');
});

test('share mode=tunnel, auth=false → 400 (tunnel shares are always gated)', async (t) => {
  const root = await mkRoot();
  await mkProject(root, 'app', { start: fakeAppCmd() }, { git: true });
  const { server, base } = await boot(root);
  t.after(async () => { await appManager.stop('app').catch(() => {}); server.close(); await rmRoot(root); });

  await j(base, 'POST', '/api/apps/app/start');
  await waitFor(async () => ['ready', 'running'].includes((await j(base, 'GET', '/api/apps')).body.apps.find((a) => a.id === 'app').status));

  const res = await j(base, 'POST', '/api/apps/app/share', { mode: 'tunnel', auth: false });
  assert.equal(res.status, 400);
});

test('PATCH share credentials edits the live proxy in place', async (t) => {
  const root = await mkRoot();
  await mkProject(root, 'app', { start: fakeAppCmd() }, { git: true });
  process.env.CODEHUB_CLOUDFLARED_BIN = '/nonexistent/cloudflared';
  const { server, base } = await boot(root);
  t.after(async () => { await appManager.stop('app').catch(() => {}); server.close(); await rmRoot(root); process.env.CODEHUB_CLOUDFLARED_BIN = fakeCloudflaredBin; });

  await j(base, 'POST', '/api/apps/app/start');
  await waitFor(async () => ['ready', 'running'].includes((await j(base, 'GET', '/api/apps')).body.apps.find((a) => a.id === 'app').status));

  // No active share yet → 409.
  assert.equal((await j(base, 'PATCH', '/api/apps/app/share/credentials', { username: 'x' })).status, 409);

  const shareRes = await j(base, 'POST', '/api/apps/app/share', { mode: 'lan', tls: false });
  const pp = (await j(base, 'GET', '/api/apps')).body.apps.find((a) => a.id === 'app').tunnel.proxyPort;

  const patch = await j(base, 'PATCH', '/api/apps/app/share/credentials', { username: 'alice', password: 'a-new-strong-password' });
  assert.equal(patch.status, 200);
  assert.equal(patch.body.id, 'app');
  assert.equal(patch.body.username, 'alice');
  assert.equal(patch.body.password, 'a-new-strong-password');

  // The QR encodes the token URL, which is stable across a creds edit (the
  // token/URL/proxy are untouched) — so the PATCH returns the SAME qrSvg as
  // share time (a cache hit), not a fresh one. The client still folds it back
  // in on the same response shape as the auth-toggle.
  assert.equal(patch.body.qrSvg, shareRes.body.qrSvg);

  // list() reflects the edit immediately — the unchanged qrSvg (served from the
  // cache the PATCH just confirmed) and the unchanged authUrl.
  const after = (await j(base, 'GET', '/api/apps')).body.apps.find((a) => a.id === 'app');
  assert.equal(after.tunnel.username, 'alice');
  assert.equal(after.tunnel.password, 'a-new-strong-password');
  assert.equal(after.tunnel.qrSvg, patch.body.qrSvg);
  assert.equal(after.tunnel.authUrl, shareRes.body.authUrl);

  // The old Basic pair is now rejected; the new one is accepted — no restart
  // (same proxyPort as right after share()).
  assert.equal(after.tunnel.proxyPort, pp);
  const rejectedOld = await fetch(`http://127.0.0.1:${pp}/`, { headers: { authorization: basicAuth('hub', shareRes.body.password) } });
  assert.equal(rejectedOld.status, 401);
  const authedNew = await fetch(`http://127.0.0.1:${pp}/`, { headers: { authorization: basicAuth('alice', 'a-new-strong-password') } });
  assert.equal(authedNew.status, 200);
  assert.equal(await authedNew.text(), 'ok');

  // Empty body → 400.
  assert.equal((await j(base, 'PATCH', '/api/apps/app/share/credentials', {})).status, 400);
});

test('PATCH share credentials on a no-auth share → 400', async (t) => {
  const root = await mkRoot();
  await mkProject(root, 'app', { start: fakeAppCmd() }, { git: true });
  const { server, base } = await boot(root);
  t.after(async () => { await appManager.stop('app').catch(() => {}); server.close(); await rmRoot(root); });

  await j(base, 'POST', '/api/apps/app/start');
  await waitFor(async () => ['ready', 'running'].includes((await j(base, 'GET', '/api/apps')).body.apps.find((a) => a.id === 'app').status));

  await j(base, 'POST', '/api/apps/app/share', { mode: 'lan', auth: false });
  const res = await j(base, 'PATCH', '/api/apps/app/share/credentials', { username: 'alice' });
  assert.equal(res.status, 400);
});

test('PATCH share/auth flips a live LAN share in place, no restart', async (t) => {
  const root = await mkRoot();
  await mkProject(root, 'app', { start: fakeAppCmd() }, { git: true });
  process.env.CODEHUB_CLOUDFLARED_BIN = '/nonexistent/cloudflared';
  const { server, base } = await boot(root);
  t.after(async () => { await appManager.stop('app').catch(() => {}); server.close(); await rmRoot(root); process.env.CODEHUB_CLOUDFLARED_BIN = fakeCloudflaredBin; });

  await j(base, 'POST', '/api/apps/app/start');
  await waitFor(async () => ['ready', 'running'].includes((await j(base, 'GET', '/api/apps')).body.apps.find((a) => a.id === 'app').status));

  // No active share yet → 409.
  assert.equal((await j(base, 'PATCH', '/api/apps/app/share/auth', { enabled: false })).status, 409);

  const shareRes = await j(base, 'POST', '/api/apps/app/share', { mode: 'lan', tls: false });
  const pp = (await j(base, 'GET', '/api/apps')).body.apps.find((a) => a.id === 'app').tunnel.proxyPort;

  // Missing/non-boolean `enabled` → 400.
  assert.equal((await j(base, 'PATCH', '/api/apps/app/share/auth', {})).status, 400);
  assert.equal((await j(base, 'PATCH', '/api/apps/app/share/auth', { enabled: 'nope' })).status, 400);

  // QR payloads track the gate. Gated: the token URL (authUrl — the token is
  // stable across a toggle, so it matches the original share QR). Ungated: the
  // plain URL, no token.
  const gatedQr = await qrSvg(shareRes.body.authUrl);
  const plainQr = await qrSvg(shareRes.body.url);
  assert.equal(shareRes.body.qrSvg, gatedQr); // share started gated → token-URL QR

  // Turn auth off: list() hides creds, proxy forwards with no gate, and the QR
  // reverts to the plain (token-less) URL.
  const off = await j(base, 'PATCH', '/api/apps/app/share/auth', { enabled: false });
  assert.equal(off.status, 200);
  assert.equal(off.body.id, 'app');
  assert.equal(off.body.auth, false);
  assert.equal(off.body.qrSvg, plainQr);
  assert.notEqual(off.body.qrSvg, gatedQr);
  let after = (await j(base, 'GET', '/api/apps')).body.apps.find((a) => a.id === 'app');
  assert.equal(after.tunnel.auth, false);
  assert.equal(after.tunnel.username, null);
  assert.equal(after.tunnel.password, null);
  // No-auth share has no magic-link (no token path) and serves the plain-url QR.
  assert.equal(after.tunnel.authUrl, undefined);
  assert.equal(after.tunnel.qrSvg, plainQr);
  const forwardedNoAuth = await fetch(`http://127.0.0.1:${pp}/`);
  assert.equal(forwardedNoAuth.status, 200);

  // Turn auth back on: same proxyPort, same password as the original share() — no
  // restart — and the QR flips back to the token URL (was stale: a scan of the
  // plain QR would 401 against the now-gated proxy).
  const on = await j(base, 'PATCH', '/api/apps/app/share/auth', { enabled: true });
  assert.equal(on.status, 200);
  assert.equal(on.body.id, 'app');
  assert.equal(on.body.auth, true);
  assert.equal(on.body.qrSvg, gatedQr);
  assert.notEqual(on.body.qrSvg, plainQr);
  after = (await j(base, 'GET', '/api/apps')).body.apps.find((a) => a.id === 'app');
  assert.equal(after.tunnel.auth, true);
  assert.equal(after.tunnel.proxyPort, pp);
  assert.equal(after.tunnel.password, shareRes.body.password);
  // Re-gating brings the magic-link back (rebuilt from the unchanged token)
  // and flips the cached QR back to the token URL.
  assert.equal(after.tunnel.authUrl, shareRes.body.authUrl);
  assert.equal(after.tunnel.qrSvg, gatedQr);
  const gatedNoAuth = await fetch(`http://127.0.0.1:${pp}/`);
  assert.equal(gatedNoAuth.status, 401);
  const gatedAuthed = await fetch(`http://127.0.0.1:${pp}/`, { headers: { authorization: basicAuth('hub', shareRes.body.password) } });
  assert.equal(gatedAuthed.status, 200);
  assert.equal(await gatedAuthed.text(), 'ok');
});

test('PATCH share/auth on a tunnel share → 400 (tunnel shares are always gated)', async (t) => {
  const root = await mkRoot();
  await mkProject(root, 'app', { start: fakeAppCmd() }, { git: true });
  const { server, base } = await boot(root);
  t.after(async () => { await appManager.stop('app').catch(() => {}); server.close(); await rmRoot(root); });

  await j(base, 'POST', '/api/apps/app/start');
  await waitFor(async () => ['ready', 'running'].includes((await j(base, 'GET', '/api/apps')).body.apps.find((a) => a.id === 'app').status));

  await j(base, 'POST', '/api/apps/app/share'); // default mode: tunnel
  const res = await j(base, 'PATCH', '/api/apps/app/share/auth', { enabled: false });
  assert.equal(res.status, 400);
});

test('share with an invalid mode → 400', async (t) => {
  const root = await mkRoot();
  await mkProject(root, 'app', { start: fakeAppCmd() }, { git: true });
  const { server, base } = await boot(root);
  t.after(async () => { await appManager.stop('app').catch(() => {}); server.close(); await rmRoot(root); });

  await j(base, 'POST', '/api/apps/app/start');
  await waitFor(async () => ['ready', 'running'].includes((await j(base, 'GET', '/api/apps')).body.apps.find((a) => a.id === 'app').status));

  const res = await j(base, 'POST', '/api/apps/app/share', { mode: 'bogus' });
  assert.equal(res.status, 400);
});

// --- Tailscale Funnel share (mode: 'tailscale') ---

// Bring an app up and wait for it to serve, so a share has something behind it.
const startApp = async (base, id = 'app') => {
  await j(base, 'POST', `/api/apps/${id}/start`);
  await waitFor(async () => ['ready', 'running'].includes((await j(base, 'GET', '/api/apps')).body.apps.find((a) => a.id === id).status));
};

test('share mode=tailscale publishes the MagicDNS URL through a gated proxy', async (t) => {
  const root = await mkRoot();
  await mkProject(root, 'app', { start: fakeAppCmd() }, { git: true });
  const { server, base } = await boot(root);
  t.after(async () => { await appManager.unshare('app').catch(() => {}); await appManager.stop('app').catch(() => {}); server.close(); await rmRoot(root); });

  await startApp(base);

  // The pill and the tailscale Share button are gated on this being true; a
  // hardcoded false would disable the whole feature on every host, silently.
  assert.equal((await j(base, 'GET', '/api/apps')).body.tailscaleAvailable, true);

  const argvLog = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'codehub-argv-')), 'argv.log');
  process.env.FAKE_TAILSCALE_ARGV_LOG = argvLog;
  t.after(async () => { delete process.env.FAKE_TAILSCALE_ARGV_LOG; await fs.rm(path.dirname(argvLog), { recursive: true, force: true }); });

  const res = await j(base, 'POST', '/api/apps/app/share', { mode: 'tailscale' });
  assert.equal(res.status, 200);
  assert.equal(res.body.kind, 'tailscale');
  // The node's MagicDNS name, trailing dot stripped and no path appended —
  // NOT a trycloudflare hostname.
  assert.match(res.body.url, /^https:\/\/[^/]+\.ts\.net$/);
  assert.equal(res.body.auth, true);
  assert.match(res.body.authUrl, /^https:\/\/[^/]+\.ts\.net\?__hubauth=[\w-]+$/);
  assert.match(res.body.qrSvg, /<svg/);

  const app = (await j(base, 'GET', '/api/apps')).body.apps.find((a) => a.id === 'app');
  assert.equal(app.tunnel.kind, 'tailscale');
  assert.equal(app.tunnel.url, res.body.url);
  assert.equal(app.tunnel.username, 'hub');
  assert.equal(app.tunnel.password, res.body.password);

  // The proxy tailscaled points at is gated AND plain HTTP: a tailscale share
  // never passes `tls` (tailscaled terminates TLS on-machine and forwards
  // http here, where a `Secure` cookie would be dropped).
  const pp = app.tunnel.proxyPort;
  const anon = await fetch(`http://127.0.0.1:${pp}/`);
  assert.equal(anon.status, 401);
  assert.match(anon.headers.get('www-authenticate') || '', /Basic/);
  const authed = await fetch(`http://127.0.0.1:${pp}/`, { headers: { authorization: basicAuth('hub', res.body.password) } });
  assert.equal(authed.status, 200);
  assert.equal(await authed.text(), 'ok');

  // The funnel must point at the GATED proxy, not at the app — funnelling the
  // app's own port would publish it with no gate at all. Read from the argv the
  // fake received, since every assertion above works off proxyPort directly and
  // would pass even if the funnel targeted something else entirely.
  const funnelArgv = (await fs.readFile(argvLog, 'utf8')).trim().split('\n')
    .map((l) => JSON.parse(l)).find((a) => a[0] === 'funnel');
  assert.ok(funnelArgv, 'the funnel subcommand was invoked');
  assert.equal(funnelArgv[funnelArgv.length - 1], `http://localhost:${pp}`);
  assert.notEqual(pp, app.port, 'the gated proxy is on its own port, not the app port');
});

// Funnel occupies port 443 of the node, machine-wide: a second one would
// replace the first rather than coexist. Re-sharing the SAME app must still
// replace normally, though — the guard excludes its own record.
test('a second tailscale share is refused with 409 naming the holder; re-sharing the same app is not', async (t) => {
  const root = await mkRoot();
  await mkProject(root, 'app', { start: fakeAppCmd() }, { git: true });
  await mkProject(root, 'other', { start: fakeAppCmd() }, { git: true });
  const { server, base } = await boot(root);
  t.after(async () => {
    for (const id of ['app', 'other']) { await appManager.unshare(id).catch(() => {}); await appManager.stop(id).catch(() => {}); }
    server.close(); await rmRoot(root);
  });

  await startApp(base, 'app');
  await startApp(base, 'other');

  assert.equal((await j(base, 'POST', '/api/apps/app/share', { mode: 'tailscale' })).status, 200);

  const clash = await j(base, 'POST', '/api/apps/other/share', { mode: 'tailscale' });
  assert.equal(clash.status, 409);
  assert.match(clash.body.error, /'app'/); // names the holder, so the user knows what to unshare

  // The refusal must not have torn the holder's share down.
  const held = (await j(base, 'GET', '/api/apps')).body.apps.find((a) => a.id === 'app');
  assert.equal(held.tunnel.kind, 'tailscale');

  const reshare = await j(base, 'POST', '/api/apps/app/share', { mode: 'tailscale' });
  assert.equal(reshare.status, 200, 're-sharing the holder replaces its own share instead of colliding with it');
});

test('share mode=tailscale, auth=false → 400 (tailscale shares are always gated)', async (t) => {
  const root = await mkRoot();
  await mkProject(root, 'app', { start: fakeAppCmd() }, { git: true });
  const { server, base } = await boot(root);
  t.after(async () => { await appManager.unshare('app').catch(() => {}); await appManager.stop('app').catch(() => {}); server.close(); await rmRoot(root); });

  await startApp(base);
  const res = await j(base, 'POST', '/api/apps/app/share', { mode: 'tailscale', auth: false });
  assert.equal(res.status, 400);
  // No share was created by the refused call.
  assert.equal((await j(base, 'GET', '/api/apps')).body.apps.find((a) => a.id === 'app').tunnel, null);
});

test('PATCH share/auth on a tailscale share → 400 (always gated)', async (t) => {
  const root = await mkRoot();
  await mkProject(root, 'app', { start: fakeAppCmd() }, { git: true });
  const { server, base } = await boot(root);
  t.after(async () => { await appManager.unshare('app').catch(() => {}); await appManager.stop('app').catch(() => {}); server.close(); await rmRoot(root); });

  await startApp(base);
  await j(base, 'POST', '/api/apps/app/share', { mode: 'tailscale' });
  const res = await j(base, 'PATCH', '/api/apps/app/share/auth', { enabled: false });
  assert.equal(res.status, 400);
  // Still gated afterwards — the refusal didn't half-apply.
  assert.equal((await j(base, 'GET', '/api/apps')).body.apps.find((a) => a.id === 'app').tunnel.auth, true);
});

test('tailscale unavailable → share 501 and tailscaleAvailable:false', async (t) => {
  const root = await mkRoot();
  await mkProject(root, 'app', { start: fakeAppCmd() }, { git: true });
  const { server, base } = await boot(root);
  process.env.CODEHUB_TAILSCALE_BIN = '/nonexistent/tailscale';
  t.after(async () => {
    process.env.CODEHUB_TAILSCALE_BIN = fakeTailscaleBin;
    await appManager.stop('app').catch(() => {}); server.close(); await rmRoot(root);
  });

  await startApp(base);
  const res = await j(base, 'POST', '/api/apps/app/share', { mode: 'tailscale' });
  assert.equal(res.status, 501);
  assert.equal((await j(base, 'GET', '/api/apps')).body.tailscaleAvailable, false);
});

// The funnel child is the ONLY thing holding the node's funnel config, so a
// teardown that leaves it alive leaves a public URL live in front of a dead
// proxy. Both teardown routes must kill it.
test('unshare and stop each kill the tailscale funnel child', async (t) => {
  const root = await mkRoot();
  await mkProject(root, 'app', { start: fakeAppCmd() }, { git: true });
  const { server, base } = await boot(root);
  t.after(async () => { await appManager.unshare('app').catch(() => {}); await appManager.stop('app').catch(() => {}); server.close(); await rmRoot(root); });

  const funnelPid = async () => {
    const raw = await fs.readFile(path.join(storeRoot(), 'state.json'), 'utf8');
    return JSON.parse(raw).apps.app.tunnel.pid;
  };

  await startApp(base);
  await j(base, 'POST', '/api/apps/app/share', { mode: 'tailscale' });
  const pid1 = await funnelPid();
  assert.ok(pidAlive(pid1));
  await j(base, 'DELETE', '/api/apps/app/share');
  await waitFor(() => !pidAlive(pid1));
  assert.equal((await j(base, 'GET', '/api/apps')).body.apps.find((a) => a.id === 'app').tunnel, null);

  // Same again, torn down via stop() rather than unshare().
  await j(base, 'POST', '/api/apps/app/share', { mode: 'tailscale' });
  const pid2 = await funnelPid();
  assert.ok(pidAlive(pid2));
  await j(base, 'POST', '/api/apps/app/stop');
  await waitFor(() => !pidAlive(pid2));
});

// Twin of the cloudflared orphan test: a funnel child survives a code-hub
// restart (it is detached), so init() must kill it — otherwise the node keeps
// a public funnel pointed at a proxy that died with the old process.
test('init tears down a tailscale funnel orphaned by a code-hub restart', async (t) => {
  const root = await mkRoot();
  const appChild = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  const funnelChild = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  t.after(async () => {
    for (const c of [appChild, funnelChild]) { try { process.kill(-c.pid, 'SIGKILL'); } catch { /* gone */ } }
    await rmRoot(root);
  });

  const store = { apps: { demo: {
    id: 'demo', project: 'demo', path: path.join(root, 'demo'), isWorktree: false, branch: null,
    pid: appChild.pid, pgid: appChild.pid, port: 5000, urls: [], startedSha: null, startedAt: '',
    tunnel: { kind: 'tailscale', url: 'https://node.tailnet.ts.net', pid: funnelChild.pid, username: 'hub', proxyPort: 5001 },
  } } };
  await fs.mkdir(storeRoot(), { recursive: true });
  await fs.writeFile(path.join(storeRoot(), 'state.json'), JSON.stringify(store));

  await appManager.init(); // simulates a fresh code-hub after restart

  const { apps } = await appManager.list();
  const demo = apps.find((a) => a.id === 'demo');
  assert.ok(demo, 'app with a live pid is kept');
  assert.equal(demo.tunnel, null, 'orphaned funnel record is cleared → Share reappears');
  await waitFor(() => !pidAlive(funnelChild.pid)); // orphaned funnel killed
  assert.ok(pidAlive(appChild.pid), 'the app process itself is untouched');
});

test('init tears down a LAN share orphaned by a code-hub restart (pid: null)', async (t) => {
  const root = await mkRoot();
  // Stand-in for the app process only — a LAN share has no cloudflared child.
  const appChild = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  t.after(async () => {
    try { process.kill(-appChild.pid, 'SIGKILL'); } catch { /* gone */ }
    await rmRoot(root);
  });

  const store = { apps: { demo: {
    id: 'demo', project: 'demo', path: path.join(root, 'demo'), isWorktree: false, branch: null,
    pid: appChild.pid, pgid: appChild.pid, port: 5000, urls: [], startedSha: null, startedAt: '',
    tunnel: { kind: 'lan', url: 'http://192.0.2.1:5001', pid: null, username: 'hub', proxyPort: 5001, urls: ['http://192.0.2.1:5001'] },
  } } };
  await fs.mkdir(storeRoot(), { recursive: true });
  await fs.writeFile(path.join(storeRoot(), 'state.json'), JSON.stringify(store));

  await appManager.init(); // simulates a fresh code-hub after restart

  const { apps } = await appManager.list();
  const demo = apps.find((a) => a.id === 'demo');
  assert.ok(demo, 'app with a live pid is kept');
  assert.equal(demo.tunnel, null, 'LAN share is cleared → Share reappears');
  assert.ok(pidAlive(appChild.pid), 'the app process itself is untouched');
});

test('init tears down a share orphaned by a code-hub restart (needs-reshare)', async (t) => {
  const root = await mkRoot();
  // Two detached, own-group children: one stands in for the app process (stays
  // alive → app survives reconcile), one for the orphaned cloudflared tunnel.
  const appChild = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  const tunChild = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  t.after(async () => {
    for (const c of [appChild, tunChild]) { try { process.kill(-c.pid, 'SIGKILL'); } catch { /* gone */ } }
    await rmRoot(root);
  });

  const store = { apps: { demo: {
    id: 'demo', project: 'demo', path: path.join(root, 'demo'), isWorktree: false, branch: null,
    pid: appChild.pid, pgid: appChild.pid, port: 5000, urls: [], startedSha: null, startedAt: '',
    tunnel: { url: 'https://x.trycloudflare.com', pid: tunChild.pid, username: 'hub', proxyPort: 5001 },
  } } };
  await fs.mkdir(storeRoot(), { recursive: true });
  await fs.writeFile(path.join(storeRoot(), 'state.json'), JSON.stringify(store));

  await appManager.init(); // simulates a fresh code-hub after restart

  const { apps } = await appManager.list();
  const demo = apps.find((a) => a.id === 'demo');
  assert.ok(demo, 'app with a live pid is kept');
  assert.equal(demo.tunnel, null, 'orphaned tunnel is cleared → Share reappears');
  await waitFor(() => !pidAlive(tunChild.pid)); // orphaned cloudflared killed
  assert.ok(pidAlive(appChild.pid), 'the app process itself is untouched');
});

// --- Tailscale funnel lifecycle: no path may strand a live funnel child ---

// Reading the funnel pid off disk rather than from any API response — the pid
// is deliberately not exposed in the App shape.
const funnelPidOf = async (id) => {
  const raw = await fs.readFile(path.join(storeRoot(), 'state.json'), 'utf8');
  return JSON.parse(raw).apps[id]?.tunnel?.pid ?? null;
};

// The record is the ONLY place a funnel child's pid is written down. list()
// dropping a dead app's record without tearing the share down first would
// strand the funnel with nothing left able to kill it — 443 published in front
// of a proxy that just closed, and every later tailscale share refused by a
// holder that no longer exists. Driven through an ADOPTED record (live pid, no
// runner runtime), which is what reaches that branch: an app started in this
// process reports 'crashed'/'exited' instead.
test('list() kills the funnel before dropping the record of an app that died unnoticed', async (t) => {
  const root = await mkRoot();
  const appChild = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  t.after(async () => {
    try { process.kill(-appChild.pid, 'SIGKILL'); } catch { /* gone */ }
    await rmRoot(root);
  });

  // A record code-hub adopts at startup: pid alive, no runtime, no share yet.
  await fs.mkdir(storeRoot(), { recursive: true });
  await fs.writeFile(path.join(storeRoot(), 'state.json'), JSON.stringify({ apps: { demo: {
    id: 'demo', project: 'demo', path: path.join(root, 'demo'), isWorktree: false, branch: null,
    pid: appChild.pid, pgid: appChild.pid, port: 5000, urls: [], startedSha: null, startedAt: '', tunnel: null,
  } } }));
  const { server, base } = await boot(root);
  t.after(() => server.close());

  assert.equal((await j(base, 'POST', '/api/apps/demo/share', { mode: 'tailscale' })).status, 200);
  const fpid = await funnelPidOf('demo');
  assert.ok(pidAlive(fpid));

  // The app dies on its own. The next poll notices and drops the record.
  process.kill(-appChild.pid, 'SIGKILL');
  await waitFor(() => !pidAlive(appChild.pid));
  const after = (await j(base, 'GET', '/api/apps')).body.apps.find((a) => a.id === 'demo');
  assert.ok(!after || after.status === 'stopped', 'the dead app is no longer reported running');
  await waitFor(() => !pidAlive(fpid)); // the funnel went with it

  // And the slot it held is free again, not wedged by a vanished holder.
  assert.equal((await funnelPidOf('demo')), null);
});

// reconcile drops a record whose APP pid is dead before init's sweep ever sees
// it — so a code-hub killed alongside its app would leave the funnel with no
// record anywhere holding its pid. Permanent public orphan.
test('init kills a funnel whose record reconcile is about to drop (app died too)', async (t) => {
  const root = await mkRoot();
  const funnelChild = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  t.after(async () => {
    try { process.kill(-funnelChild.pid, 'SIGKILL'); } catch { /* gone */ }
    await rmRoot(root);
  });

  // A dead app pid (99 999 999 is not a live process) with a LIVE funnel pid.
  await fs.mkdir(storeRoot(), { recursive: true });
  await fs.writeFile(path.join(storeRoot(), 'state.json'), JSON.stringify({ apps: { demo: {
    id: 'demo', project: 'demo', path: path.join(root, 'demo'), isWorktree: false, branch: null,
    pid: 99999999, pgid: 99999999, port: 5000, urls: [], startedSha: null, startedAt: '',
    tunnel: { kind: 'tailscale', url: 'https://node.tailnet.ts.net', pid: funnelChild.pid, proxyPort: 5001 },
  } } }));

  await appManager.init(); // simulates a fresh code-hub after both died

  const { apps } = await appManager.list();
  assert.equal(apps.find((a) => a.id === 'demo'), undefined, 'the dead app record is dropped');
  await waitFor(() => !pidAlive(funnelChild.pid)); // ...but not before its funnel was killed
});

// rec.tunnel isn't assigned until the funnel is up, so a guard that only
// scanned the persisted records would let two concurrent requests both pass it
// and both start a funnel — Funnel replaces rather than coexists, so one app's
// panel would advertise a dead public URL with live credentials.
test('two concurrent tailscale shares: exactly one wins, the other 409s', async (t) => {
  const root = await mkRoot();
  await mkProject(root, 'app', { start: fakeAppCmd() }, { git: true });
  await mkProject(root, 'other', { start: fakeAppCmd() }, { git: true });
  const { server, base } = await boot(root);
  t.after(async () => {
    for (const id of ['app', 'other']) { await appManager.unshare(id).catch(() => {}); await appManager.stop(id).catch(() => {}); }
    server.close(); await rmRoot(root);
  });

  await startApp(base, 'app');
  await startApp(base, 'other');

  const [a, b] = await Promise.all([
    j(base, 'POST', '/api/apps/app/share', { mode: 'tailscale' }),
    j(base, 'POST', '/api/apps/other/share', { mode: 'tailscale' }),
  ]);
  const codes = [a.status, b.status].sort();
  assert.deepEqual(codes, [200, 409], 'one share wins the Funnel slot, the other is refused');

  // Exactly one funnel record exists — the loser left nothing behind.
  const apps = (await j(base, 'GET', '/api/apps')).body.apps;
  const shared = apps.filter((x) => x.tunnel?.kind === 'tailscale');
  assert.equal(shared.length, 1);
});

// A funnel can die on its own (OOM kill, a stray kill). Left unnoticed, list()
// keeps serving credentials and a QR for a URL that answers nothing, and every
// other app is refused on behalf of a holder that holds nothing.
test('a funnel that dies on its own is reaped, and frees the slot for another app', async (t) => {
  const root = await mkRoot();
  await mkProject(root, 'app', { start: fakeAppCmd() }, { git: true });
  await mkProject(root, 'other', { start: fakeAppCmd() }, { git: true });
  const { server, base } = await boot(root);
  t.after(async () => {
    for (const id of ['app', 'other']) { await appManager.unshare(id).catch(() => {}); await appManager.stop(id).catch(() => {}); }
    server.close(); await rmRoot(root);
  });

  await startApp(base, 'app');
  await startApp(base, 'other');
  assert.equal((await j(base, 'POST', '/api/apps/app/share', { mode: 'tailscale' })).status, 200);

  const fpid = await funnelPidOf('app');
  process.kill(-fpid, 'SIGKILL'); // the funnel dies without code-hub doing it
  await waitFor(() => !pidAlive(fpid));

  // The stale share stops being advertised...
  const holder = (await j(base, 'GET', '/api/apps')).body.apps.find((x) => x.id === 'app');
  assert.equal(holder.tunnel, null, 'no URL/credentials/QR served for a funnel that is gone');

  // ...and no longer blocks anyone else.
  assert.equal((await j(base, 'POST', '/api/apps/other/share', { mode: 'tailscale' })).status, 200);
});

// --- Fixed port (`port` in the manifest) ---

// Reserve a port the fixed-port tests can claim: allocate then release, so the
// number is real and currently free rather than a hardcoded guess.
const freePort = () => new Promise((r) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); });
});

const appStatus = async (base, id = 'app') =>
  (await j(base, 'GET', '/api/apps')).body.apps.find((a) => a.id === id);

test('an app declaring a fixed port starts on exactly that port, and restart keeps it', async (t) => {
  const root = await mkRoot();
  const port = await freePort();
  await mkProject(root, 'app', { start: fakeAppCmd(), port }, { git: true });
  const { server, base } = await boot(root);
  t.after(async () => { await appManager.stop('app').catch(() => {}); server.close(); await rmRoot(root); });

  const started = await j(base, 'POST', '/api/apps/app/start');
  assert.equal(started.status, 200);
  assert.equal(started.body.port, port);
  assert.equal(started.body.fixedPort, port);
  await waitFor(async () => ['ready', 'running'].includes((await appStatus(base)).status));

  const app = await appStatus(base);
  assert.equal(app.port, port);
  assert.ok(app.urls.includes(`http://localhost:${port}`), 'urls must carry the fixed port');
  assert.ok(app.routes[0].urls.includes(`http://localhost:${port}`));

  // Restart is stop-then-start, so the port must come back identical — the
  // whole point of pinning it (a bookmarkable URL survives a restart).
  const restarted = await j(base, 'POST', '/api/apps/app/restart');
  assert.equal(restarted.status, 200);
  assert.equal(restarted.body.port, port);
});

test('starting a fixed-port app whose port is busy → 409, never a silent fallback', async (t) => {
  const root = await mkRoot();
  const port = await freePort();
  await mkProject(root, 'app', { start: fakeAppCmd(), port }, { git: true });
  const { server, base } = await boot(root);
  t.after(async () => { await appManager.stop('app').catch(() => {}); server.close(); await rmRoot(root); });

  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(port, '127.0.0.1', r));
  t.after(() => new Promise((r) => blocker.close(r)));

  const res = await j(base, 'POST', '/api/apps/app/start');
  assert.equal(res.status, 409);
  assert.match(res.body.error, /already in use/);
  assert.match(res.body.error, /will not fall back to a free one/);

  // Crucially: nothing is left running on some OTHER port.
  assert.equal((await appStatus(base)).status, 'stopped');
});

test('a dynamic-port app is unaffected: no fixedPort, still gets a free port', async (t) => {
  const root = await mkRoot();
  await mkProject(root, 'app', { start: fakeAppCmd() }, { git: true });
  const { server, base } = await boot(root);
  t.after(async () => { await appManager.stop('app').catch(() => {}); server.close(); await rmRoot(root); });

  const started = await j(base, 'POST', '/api/apps/app/start');
  assert.equal(started.status, 200);
  assert.equal(started.body.fixedPort, null);
  assert.ok(started.body.port > 0);
});

test('a worktree of a fixed-port project starts on a FREE port, not the pinned one', async (t) => {
  const root = await mkRoot();
  const port = await freePort();
  await mkProject(root, 'app', { start: fakeAppCmd(), port }, { git: true });
  // Git carries the parent's .hub.json into the worktree checkout — same file,
  // fixed port and all. Discovery must strip it so both can run at once.
  await mkProject(root, 'app_worktree_ab12cd', { start: fakeAppCmd(), port }, { git: true });
  const { server, base } = await boot(root);
  t.after(async () => {
    await appManager.stop('app').catch(() => {});
    await appManager.stop('app_worktree_ab12cd').catch(() => {});
    server.close(); await rmRoot(root);
  });

  const parent = await j(base, 'POST', '/api/apps/app/start');
  assert.equal(parent.body.port, port);

  const wt = await j(base, 'POST', '/api/apps/app_worktree_ab12cd/start');
  assert.equal(wt.status, 200, JSON.stringify(wt.body));
  assert.equal(wt.body.fixedPort, null);
  assert.notEqual(wt.body.port, port); // it did not try to take the parent's port
});

// --- Fixed-port LAN share: the two bind outcomes ---
//
// Measured on Linux: a proxy CAN bind <lanIp>:<P> while the app holds
// 127.0.0.1:<P>, but NOT while the app holds 0.0.0.0:<P> (SO_REUSEADDR does
// not permit overlapping listen binds). Both branches are asserted below.
// Skipped where the host has no LAN interface at all, since there is then no
// specific address for the proxy to bind.
const HAS_LAN = localIPv4s({ lanFallback: true }).length > 0;

test('fixed-port LAN share: a loopback-binding app gets the gated share ON its fixed port', async (t) => {
  if (!HAS_LAN) return t.skip('no LAN interface on this host');
  const root = await mkRoot();
  const port = await freePort();
  // The default fake-app binds 127.0.0.1 only, leaving the LAN addresses free.
  await mkProject(root, 'app', { start: fakeAppCmd(), port }, { git: true });
  const { server, base } = await boot(root);
  t.after(async () => { await appManager.stop('app').catch(() => {}); server.close(); await rmRoot(root); });

  await j(base, 'POST', '/api/apps/app/start');
  await waitFor(async () => ['ready', 'running'].includes((await appStatus(base)).status));

  const res = await j(base, 'POST', '/api/apps/app/share', { mode: 'lan', tls: false });
  assert.equal(res.status, 200);
  assert.equal(res.body.proxyPort, port, 'the gated share must land on the fixed port');
  assert.equal(res.body.fixedPortFallback, false);
  assert.ok(res.body.urls.every((u) => u.endsWith(`:${port}`)));

  const app = await appStatus(base);
  assert.equal(app.tunnel.proxyPort, port);
  assert.equal(app.tunnel.fixedPortFallback, false);
  assert.equal(app.tunnel.fixedPortHolder, null); // nothing fell back, so no cause to report

  // The proxy really is on the LAN address at that port, and really is gated.
  const lanIp = localIPv4s({ lanFallback: true })[0];
  const noauth = await fetch(`http://${lanIp}:${port}/`);
  assert.equal(noauth.status, 401);
  const authed = await fetch(`http://${lanIp}:${port}/`, { headers: { authorization: basicAuth('hub', res.body.password) } });
  assert.equal(authed.status, 200);
  assert.equal(await authed.text(), 'ok');
});

test('fixed-port LAN share: a wildcard-binding app falls back to a free port, and says so', async (t) => {
  if (!HAS_LAN) return t.skip('no LAN interface on this host');
  // Asserting the exact 'app' attribution requires the holder probe to be able
  // to run at all; the probe-unavailable host class is covered separately below.
  if (!(await altLoopbackBindable())) return t.skip(`${ALT_LOOPBACK} is not bindable on this host`);
  const root = await mkRoot();
  const port = await freePort();
  // This app binds 0.0.0.0, so it already occupies the fixed port on every LAN
  // address — the gated proxy cannot take it.
  await mkProject(root, 'app', { start: fakeAppCmd('wildcard'), port }, { git: true });
  const { server, base } = await boot(root);
  t.after(async () => { await appManager.stop('app').catch(() => {}); server.close(); await rmRoot(root); });

  await j(base, 'POST', '/api/apps/app/start');
  await waitFor(async () => ['ready', 'running'].includes((await appStatus(base)).status));

  const res = await j(base, 'POST', '/api/apps/app/share', { mode: 'lan', tls: false });
  assert.equal(res.status, 200);
  assert.equal(res.body.fixedPortFallback, true, 'the fallback must be surfaced, not silent');
  assert.notEqual(res.body.proxyPort, port);
  // The app really does hold every interface here, so the exposure claim is
  // established and the loud warning must fire. This is the under-report guard:
  // it fails if the cause probe ever stops recognising a genuine wildcard hold.
  assert.equal(res.body.fixedPortHolder, 'app');

  const app = await appStatus(base);
  assert.equal(app.tunnel.fixedPortFallback, true);
  assert.equal(app.tunnel.fixedPortHolder, 'app');
  assert.equal(app.tunnel.proxyPort, res.body.proxyPort);

  // The fallback share is still a real, gated share.
  const noauth = await fetch(`http://127.0.0.1:${res.body.proxyPort}/`);
  assert.equal(noauth.status, 401);
  const authed = await fetch(`http://127.0.0.1:${res.body.proxyPort}/`, { headers: { authorization: basicAuth('hub', res.body.password) } });
  assert.equal(authed.status, 200);
});

test('a dynamic-port LAN share reports fixedPortFallback:false (no false alarm)', async (t) => {
  const root = await mkRoot();
  await mkProject(root, 'app', { start: fakeAppCmd() }, { git: true });
  const { server, base } = await boot(root);
  t.after(async () => { await appManager.stop('app').catch(() => {}); server.close(); await rmRoot(root); });

  await j(base, 'POST', '/api/apps/app/start');
  await waitFor(async () => ['ready', 'running'].includes((await appStatus(base)).status));

  const res = await j(base, 'POST', '/api/apps/app/share', { mode: 'lan', tls: false });
  assert.equal(res.body.fixedPortFallback, false);
  assert.equal(res.body.fixedPortHolder, null);
  assert.equal((await appStatus(base)).tunnel.fixedPortFallback, false);
  assert.equal((await appStatus(base)).tunnel.fixedPortHolder, null);
});

// The pre-check and the post-spawn check are independent defenses that cover
// different failures. The three tests below each defeat one of them so the
// other has to carry the case alone — otherwise a regression in either would
// stay hidden behind the one that still works.

test('a fixed-port child that hits EADDRINUSE after a clean pre-check still 409s, and never moves', async (t) => {
  const root = await mkRoot();
  const port = await freePort();
  // The port really is free, so the pre-check passes — only the post-spawn
  // check can catch this. `flaky` fails once with EADDRINUSE and would succeed
  // on a retry, so a runner that still reallocates would silently start this
  // app on a DIFFERENT port instead: exactly the outcome a fixed port forbids.
  const marker = path.join(root, 'flaky-marker');
  await mkProject(root, 'app', { start: fakeAppCmd('flaky', marker), port }, { git: true });
  const { server, base } = await boot(root);
  t.after(async () => { await appManager.stop('app').catch(() => {}); server.close(); await rmRoot(root); });

  const res = await j(base, 'POST', '/api/apps/app/start');
  assert.equal(res.status, 409, `expected a refusal, got ${JSON.stringify(res.body)}`);
  assert.match(res.body.error, /already in use/);

  const app = await appStatus(base);
  assert.equal(app.status, 'stopped');
  assert.equal(app.port, undefined, 'no record may survive a refused fixed-port start');
});

test('a fixed port held only on a LAN address is refused, though the app could still bind loopback', async (t) => {
  if (!HAS_LAN) return t.skip('no LAN interface on this host');
  const root = await mkRoot();
  const port = await freePort();
  await mkProject(root, 'app', { start: fakeAppCmd(), port }, { git: true });
  const { server, base } = await boot(root);
  t.after(async () => { await appManager.stop('app').catch(() => {}); server.close(); await rmRoot(root); });

  // Held on a LAN address only. The app binds 127.0.0.1, so it would start
  // happily and the child would never report EADDRINUSE — the post-spawn check
  // is blind here. Only the 0.0.0.0 pre-check sees this, and it must refuse:
  // the fixed port is not actually available on this machine.
  const lanIp = localIPv4s({ lanFallback: true })[0];
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(port, lanIp, r));
  t.after(() => new Promise((r) => blocker.close(r)));

  const res = await j(base, 'POST', '/api/apps/app/start');
  assert.equal(res.status, 409, `expected a refusal, got ${JSON.stringify(res.body)}`);
  assert.match(res.body.error, /already in use/);
  assert.equal((await appStatus(base)).status, 'stopped');
});

test('a fixed port already held by another code-hub app is refused, naming the holder', async (t) => {
  const root = await mkRoot();
  const port = await freePort();
  await mkProject(root, 'first', { start: fakeAppCmd(), port }, { git: true });
  await mkProject(root, 'second', { start: fakeAppCmd(), port }, { git: true });
  const { server, base } = await boot(root);
  t.after(async () => {
    await appManager.stop('first').catch(() => {});
    await appManager.stop('second').catch(() => {});
    server.close(); await rmRoot(root);
  });

  assert.equal((await j(base, 'POST', '/api/apps/first/start')).status, 200);
  const res = await j(base, 'POST', '/api/apps/second/start');
  assert.equal(res.status, 409);
  // Naming the holder is the difference between a useful message and a shrug —
  // the generic probe failure can't say who has the port.
  assert.match(res.body.error, /held by 'first'/);
});

test('fixed-port LAN share: a THIRD-PARTY listener on the LAN port must not be blamed on the app', async (t) => {
  if (!HAS_LAN) return t.skip('no LAN interface on this host');
  const root = await mkRoot();
  const port = await freePort();
  // The default fake-app binds 127.0.0.1 only, so it is NOT reachable on the
  // LAN at all — the exposure claim would be flatly false for it.
  await mkProject(root, 'app', { start: fakeAppCmd(), port }, { git: true });
  const { server, base } = await boot(root);
  t.after(async () => { await appManager.stop('app').catch(() => {}); server.close(); await rmRoot(root); });

  await j(base, 'POST', '/api/apps/app/start');
  await waitFor(async () => ['ready', 'running'].includes((await appStatus(base)).status));

  // An unrelated process grabs the fixed port on a LAN address AFTER the app
  // started (start()'s 0.0.0.0 probe proved it free machine-wide before that,
  // so this is the only order in which it can happen). The proxy's LAN bind now
  // fails with the exact same EADDRINUSE the wildcard-binding app produces.
  const lanIp = localIPv4s({ lanFallback: true })[0];
  // A real HTTP server, so the reachability check below gets an answer rather
  // than hanging on an accepted-but-silent socket — and so its reply is
  // distinguishable from the app's.
  const squatter = http.createServer((req, res) => { res.writeHead(200); res.end('squatter'); });
  await new Promise((r) => squatter.listen(port, lanIp, r));
  t.after(() => new Promise((r) => { squatter.closeAllConnections?.(); squatter.close(r); }));

  const res = await j(base, 'POST', '/api/apps/app/share', { mode: 'lan', tls: false });
  assert.equal(res.status, 200);
  assert.equal(res.body.fixedPortFallback, true);
  // The whole point: code-hub must NOT claim the app is LAN-reachable ungated,
  // because it isn't. Blaming the app here would tell the user their app is
  // already exposed and invite them to treat the gate as pointless.
  assert.equal(res.body.fixedPortHolder, 'other');
  assert.notEqual(res.body.fixedPortHolder, 'app');

  const app = await appStatus(base);
  assert.equal(app.tunnel.fixedPortHolder, 'other');

  // And the app genuinely is not reachable on the LAN at the fixed port —
  // what answers there is the squatter, not the app (which serves 'ok').
  const viaLan = await fetch(`http://${lanIp}:${port}/`).then((r) => r.text()).catch(() => null);
  assert.equal(viaLan, 'squatter');

  // The fallback share itself is still a real, gated share.
  const noauth = await fetch(`http://127.0.0.1:${res.body.proxyPort}/`);
  assert.equal(noauth.status, 401);
});

test('fixed-port LAN share: where the holder probe cannot run, an exposure warning still fires', async (t) => {
  if (!HAS_LAN) return t.skip('no LAN interface on this host');
  const root = await mkRoot();
  const port = await freePort();
  // A genuinely wildcard-binding app: it really IS answering on the LAN at the
  // fixed port with no gate, so a silent share here would hide a real exposure.
  await mkProject(root, 'app', { start: fakeAppCmd('wildcard'), port }, { git: true });

  // Simulate a host with no loopback aliases (macOS/Windows), where binding the
  // probe address fails with EADDRNOTAVAIL before the kernel considers the port
  // — for every port, held or free. Measured: 192.0.2.1 (RFC 5737 TEST-NET-1)
  // reproduces exactly that on Linux, so this exercises the real code path
  // rather than skipping it on the one platform where it can't occur.
  const prevProbe = process.env.CODEHUB_WILDCARD_PROBE_ADDR;
  process.env.CODEHUB_WILDCARD_PROBE_ADDR = '192.0.2.1';
  const { server, base } = await boot(root);
  t.after(async () => {
    if (prevProbe === undefined) delete process.env.CODEHUB_WILDCARD_PROBE_ADDR;
    else process.env.CODEHUB_WILDCARD_PROBE_ADDR = prevProbe;
    await appManager.stop('app').catch(() => {}); server.close(); await rmRoot(root);
  });

  await j(base, 'POST', '/api/apps/app/start');
  await waitFor(async () => ['ready', 'running'].includes((await appStatus(base)).status));

  const res = await j(base, 'POST', '/api/apps/app/share', { mode: 'lan', tls: false });
  assert.equal(res.status, 200);
  assert.equal(res.body.fixedPortFallback, true);
  // The probe couldn't establish anything, so the holder is unreported — but
  // it must NOT be reported as 'other', which is the one value that licenses
  // staying quiet. That is the whole failure mode: an all-clear we never earned.
  assert.equal(res.body.fixedPortHolder, 'unknown');
  assert.notEqual(res.body.fixedPortHolder, 'other');
  assert.equal((await appStatus(base)).tunnel.fixedPortHolder, 'unknown');

  // And the exposure is real: the app answers on the LAN at the fixed port
  // with no credentials at all.
  const lanIp = localIPv4s({ lanFallback: true })[0];
  const ungated = await fetch(`http://${lanIp}:${port}/`);
  assert.equal(ungated.status, 200);
  assert.equal(await ungated.text(), 'ok');
});
