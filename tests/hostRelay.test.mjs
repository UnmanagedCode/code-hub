import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { createServer } from '../server.js';
import * as appManager from '../src/appManager.js';
import * as hostRelay from '../src/hostRelay.js';
import { REPO_ROOT, mkRoot, rmRoot, mkProject, fakeAppCmd, fakeCloudflaredBin, fakeTailscaleBin } from './helpers.mjs';

// src/hostRelay.js and the LAN share against FAKE relays (no Python): relays
// that misbehave in ways the real one never does.

const PROTOCOL = JSON.parse(readFileSync(path.join(REPO_ROOT, 'relay', 'protocol.json'), 'utf8'));
const SECRET = 'f'.repeat(43);

function useRelay(t, url) {
  const prev = { url: process.env.CODEHUB_RELAY_URL, secret: process.env.CODEHUB_RELAY_SECRET };
  process.env.CODEHUB_RELAY_URL = url;
  process.env.CODEHUB_RELAY_SECRET = SECRET;
  t.after(() => {
    for (const [k, v] of [['CODEHUB_RELAY_URL', prev.url], ['CODEHUB_RELAY_SECRET', prev.secret]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
}

// A code-hub serving one running fake app 'app' over HTTP: { base }.
async function boot(t) {
  process.env.CODEHUB_CLOUDFLARED_BIN = fakeCloudflaredBin;
  process.env.CODEHUB_TAILSCALE_BIN = fakeTailscaleBin;
  const root = await mkRoot();
  await mkProject(root, 'app', { start: fakeAppCmd() });
  await appManager.init();
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await appManager.stop('app').catch(() => {});
    server.close();
    await rmRoot(root);
  });
  await appManager.start('app');
  await appManager.awaitSettled('app');
  return { base: `http://127.0.0.1:${server.address().port}` };
}

const shareLan = async (base) => {
  const r = await fetch(`${base}/api/apps/app/share`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'lan', tls: false }) });
  return { status: r.status, body: await r.json() };
};

// Invariant: a relay's malformed create answer fails the relay at the boundary — the share still answers 200, and no renewing forward is left behind.
test('a malformed 201 from the relay fails the relay, not the share, and leaves nothing renewing', async (t) => {
  const counts = { create: 0, renew: 0, delete: 0 };
  const fake = http.createServer((req, res) => {
    req.resume();
    if (req.method === 'POST' && req.url === PROTOCOL.paths.forwards) {
      counts.create += 1;
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'fwd-1', port: 40000, leaseMs: 300, protocol: PROTOCOL.protocolVersion })); // no addresses
      return;
    }
    if (req.method === 'POST') counts.renew += 1;
    if (req.method === 'DELETE') counts.delete += 1;
    res.writeHead(404); res.end();
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  t.after(() => fake.close());
  useRelay(t, `http://127.0.0.1:${fake.address().port}`);
  const { base } = await boot(t);

  const res = await shareLan(base);
  assert.equal(res.status, 200);
  assert.equal(res.body.relay.state, 'failed');
  assert.match(res.body.relay.error, /create response is malformed \(addresses/);
  assert.equal(counts.create, 1);
  await new Promise((r) => setTimeout(r, 400)); // past a full 300ms lease of would-be renewals
  assert.equal(counts.renew, 0, 'nothing renews the rejected forward');
  assert.equal(counts.delete, 1, 'the half-formed forward is deleted');
});

// Invariant: a relay that accepts and never answers costs the share at most the request timeout — openForward rejects with the timeout, and the share commits with the relay failed.
test('a relay that never answers times out: openForward rejects, the share still commits', async (t) => {
  const held = new Set();
  const silent = net.createServer((s) => { held.add(s); s.on('error', () => {}); });
  await new Promise((r) => silent.listen(0, '127.0.0.1', r));
  t.after(() => { for (const s of held) s.destroy(); silent.close(); });
  hostRelay._setRequestTimeoutMs(200);
  t.after(() => hostRelay._setRequestTimeoutMs(3000));
  const url = `http://127.0.0.1:${silent.address().port}`;
  useRelay(t, url);
  await assert.rejects(hostRelay.openForward({}), new RegExp(`the relay at ${url} did not answer within 200ms`));

  const { base } = await boot(t);
  const started = Date.now();
  const res = await shareLan(base);
  assert.equal(res.status, 200);
  assert.equal(res.body.relay.state, 'failed');
  assert.match(res.body.relay.error, /did not answer within 200ms/);
  assert.ok(Date.now() - started < 2000, `bounded by the timeout (${Date.now() - started}ms)`);
});
