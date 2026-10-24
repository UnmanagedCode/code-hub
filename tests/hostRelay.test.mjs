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

// A fake relay: `create(n)` answers the nth create with { status, text }, and
// every request is counted. Accept upgrades are held open and counted per id.
async function fakeRelay(t, { create, renew = () => 200, acceptAnswer = null }) {
  const seen = { creates: 0, renews: [], deletes: [], accepts: new Map(), openAccepts: 0 };
  const held = new Set();
  const srv = http.createServer((req, res) => {
    req.resume();
    if (req.method === 'POST' && req.url === PROTOCOL.paths.forwards) {
      seen.creates += 1;
      const { status, text } = create(seen.creates);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(text);
      return;
    }
    const id = decodeURIComponent(req.url.split('/')[3] ?? '');
    if (req.method === 'POST') { seen.renews.push(id); res.writeHead(renew(id, seen)); res.end(); return; }
    if (req.method === 'DELETE') { seen.deletes.push(id); res.writeHead(204); res.end(); return; }
    res.writeHead(404); res.end();
  });
  srv.on('upgrade', (req, socket) => {
    const id = decodeURIComponent(req.url.split('/')[3] ?? '');
    const list = seen.accepts.get(id) ?? [];
    list.push(socket);
    seen.accepts.set(id, list);
    held.add(socket);
    seen.openAccepts += 1;
    // The client closing shows as 'end' on this half-open upgraded socket.
    let open = true;
    const gone = () => { if (open) { open = false; seen.openAccepts -= 1; } };
    socket.on('end', gone);
    socket.on('close', gone);
    socket.on('error', () => {});
    if (acceptAnswer) socket.write(acceptAnswer);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => { for (const s of held) s.destroy(); srv.close(); });
  useRelay(t, `http://127.0.0.1:${srv.address().port}`);
  return seen;
}

const created = (over = {}) => JSON.stringify({ id: 'fwd-1', port: 40000, addresses: ['127.0.0.1'], leaseMs: 300, protocol: PROTOCOL.protocolVersion, ...over });

// Invariant: every malformed create answer — one per createdProblem branch, the size and count caps included — is refused as malformed at the boundary (never as a version mismatch), and a well-formed answer of another version is refused as a mismatch.
test('each malformed 201 is refused as malformed; a well-formed other version as a mismatch', async (t) => {
  const many = Array.from({ length: PROTOCOL.maxAddresses + 1 }, (_, i) => `10.0.0.${i + 1}`);
  const cases = [
    ['not JSON', 'nope', /malformed \(not a JSON object\)/],
    ['an array', '[]', /malformed \(not a JSON object\)/],
    ['no protocol', created({ protocol: undefined }), /malformed \(protocol undefined\)/],
    ['no id', created({ id: '' }), /malformed \(no forward id\)/],
    ['a privileged port', created({ port: 80 }), /malformed \(port 80\)/],
    ['no addresses', created({ addresses: undefined }), /malformed \(addresses is not a non-empty list of IPv4 addresses\)/],
    ['a non-IPv4 address', created({ addresses: ['host.example'] }), /malformed \(addresses is not a non-empty list of IPv4 addresses\)/],
    ['too many addresses', created({ addresses: many }), new RegExp(`malformed \\(${many.length} addresses, more than ${PROTOCOL.maxAddresses}\\)`)],
    ['a zero lease', created({ leaseMs: 0 }), /malformed \(leaseMs 0\)/],
    ['an overlong lease', created({ leaseMs: 1e10 }), /malformed \(leaseMs 10000000000\)/],
    ['an oversized answer', created({ pad: 'x'.repeat(70 * 1024) }), /malformed \(larger than 65536 bytes\)/],
    ['another version', created({ protocol: PROTOCOL.protocolVersion + 1 }), new RegExp(`relay speaks protocol ${PROTOCOL.protocolVersion + 1}, this code-hub speaks ${PROTOCOL.protocolVersion}`)],
  ];
  let current = null;
  const seen = await fakeRelay(t, { create: () => ({ status: 201, text: current }) });
  for (const [name, text, error] of cases) {
    current = text;
    await assert.rejects(hostRelay.openForward({}), error, name);
  }
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(seen.renews, [], 'no refused forward is ever renewed');
});

// Invariant: a drained accept slot can never re-park — after down→up the pool holds exactly ACCEPT_POOL parked accepts, the drained slots' late callbacks included.
test('a drained slot\'s late callback does not re-park after down→up', async (t) => {
  const seen = await fakeRelay(t, {
    create: (n) => ({ status: 201, text: created({ id: `fwd-${n}` }) }),
    renew: (id) => (id === 'fwd-1' ? 404 : 200), // the first forward is "lost" on its first renewal
  });
  const target = net.createServer((s) => s.destroy());
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  t.after(() => target.close());
  const handle = await hostRelay.openForward({});
  t.after(() => handle.close());
  handle.attach({ host: '127.0.0.1', port: target.address().port });
  const deadline = Date.now() + 3000;
  while (handle.id !== 'fwd-2' || handle.state !== 'up') {
    assert.ok(Date.now() < deadline, 'the forward was re-created');
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(seen.accepts.get('fwd-1')?.length, 4, 'the first pool parked');
  // Past the drained slots' error backoff (1000ms) and every re-park floor.
  await new Promise((r) => setTimeout(r, 1600));
  assert.equal(seen.accepts.get('fwd-2')?.length, 4, 'exactly one fresh pool, no re-park from a drained slot');
});

// Invariant: a non-upgrade answer to a park ends that connection at once — a relay that sends headers and never ends the body can't make code-hub accumulate open sockets.
test('an accept answered with headers and a never-ending body does not pile up sockets', async (t) => {
  const seen = await fakeRelay(t, {
    create: () => ({ status: 201, text: created({ leaseMs: 60000 }) }),
    acceptAnswer: 'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 100000\r\n\r\npartial',
  });
  const handle = await hostRelay.openForward({});
  t.after(() => handle.close());
  handle.attach({ host: '127.0.0.1', port: 9 });
  // Two and a half re-park backoffs: a leak would hold about 4 sockets per second.
  let peak = 0;
  const until = Date.now() + 2500;
  while (Date.now() < until) {
    peak = Math.max(peak, seen.openAccepts);
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(seen.accepts.get('fwd-1').length > 4, 'the slots did re-park');
  assert.ok(peak <= 4, `open accept sockets stayed within the pool (peak ${peak})`);
});

// Invariant: a create answer exactly at each cap — maxLeaseMs, maxAddresses addresses — is accepted.
test('a 201 exactly at maxLeaseMs and maxAddresses is accepted', async (t) => {
  const addresses = Array.from({ length: PROTOCOL.maxAddresses }, (_, i) => `10.0.0.${i + 1}`);
  await fakeRelay(t, { create: () => ({ status: 201, text: created({ leaseMs: PROTOCOL.maxLeaseMs, addresses }) }) });
  const handle = await hostRelay.openForward({});
  t.after(() => handle.close());
  assert.deepEqual(handle.addresses, addresses);
  assert.equal(handle.state, 'up');
});

