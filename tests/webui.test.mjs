// Pins how the backend serves the UI: the CSP and nosniff on every response,
// the built files with their types, no SPA fallback, the plain-text 404/503 and
// error bodies, and the per-request "not built" check. Runs against a fixture
// dist, so it needs no build.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server.js';
import { CSP, securityHeaders, terminalHandlers } from '../src/webui.js';
import { fakeCloudflaredBin, fakeTailscaleBin, mkRoot, rmRoot } from './helpers.mjs';

process.env.CODEHUB_CLOUDFLARED_BIN = fakeCloudflaredBin;
process.env.CODEHUB_TAILSCALE_BIN = fakeTailscaleBin;

const INDEX = '<!doctype html><html><head><script type="module" src="./assets/index-x.js"></script></head><body></body></html>';
const FILES = {
  'index.html': INDEX,
  'assets/index-x.js': 'console.log(1);',
  'assets/index-x.css': 'body{}',
  'theme-init.js': '(function(){})();',
  'manifest.webmanifest': '{"name":"code-hub"}',
  'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
};

async function writeDist(dir) {
  for (const [rel, body] of Object.entries(FILES)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), body);
  }
  return dir;
}

async function tmpDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codehub-dist-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function listen(t, server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function serve(t, distDir) {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  return listen(t, createServer({ distDir }));
}

// A GET with the path sent byte-for-byte (fetch would normalise a malformed escape).
function rawGet(base, rawPath) {
  return new Promise((resolve, reject) => {
    http.get(`${base}${rawPath}`, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], headers: res.headers, body }));
    }).on('error', reject);
  });
}

function assertHeaders(r, label) {
  const get = (name) => (r.headers instanceof Headers ? r.headers.get(name) : r.headers[name]);
  assert.equal(get('content-security-policy'), CSP, `${label}: CSP`);
  assert.equal(get('x-content-type-options'), 'nosniff', `${label}: nosniff`);
}

// Invariant: the CSP is exactly the documented policy (docs/protocol.md), each directive there for a reason.
test('CSP is the documented policy', () => {
  assert.equal(CSP, "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; manifest-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
});

// Invariant: / serves the built index.html as HTML, revalidated on every load, with the security headers.
test('/ serves the built index.html with the CSP, nosniff and no-cache', async (t) => {
  const base = await serve(t, await writeDist(await tmpDir(t)));
  for (const p of ['/', '/index.html']) {
    const r = await fetch(base + p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get('content-type'), /^text\/html/, p);
    assert.equal(r.headers.get('cache-control'), 'no-cache', p);
    assertHeaders(r, p);
    assert.equal(await r.text(), INDEX, p);
  }
});

// Invariant: every built file is served with its own type (the PWA manifest and icon included).
test('built assets, theme-init.js, the manifest and the icon are served with their types', async (t) => {
  const base = await serve(t, await writeDist(await tmpDir(t)));
  const want = {
    '/assets/index-x.js': /^text\/javascript|^application\/javascript/,
    '/assets/index-x.css': /^text\/css/,
    '/theme-init.js': /^text\/javascript|^application\/javascript/,
    '/manifest.webmanifest': /^application\/manifest\+json/,
    '/icon.svg': /^image\/svg\+xml/,
  };
  for (const [p, type] of Object.entries(want)) {
    const r = await fetch(base + p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get('content-type'), type, p);
    assert.equal(r.headers.get('cache-control'), 'no-cache', p);
    assertHeaders(r, p);
    assert.equal(await r.text(), FILES[p.slice(1)], p);
  }
});

// Invariant: no SPA fallback — the host URLs and unknown paths are a plain-text 404 carrying the headers.
test('host URLs and unknown paths are a text/plain 404 with the headers', async (t) => {
  const base = await serve(t, await writeDist(await tmpDir(t)));
  for (const p of ['/pluginBridge.js', '/pluginTheme.css', '/nope', '/assets/missing.js', '/api/nope']) {
    const r = await fetch(base + p);
    assert.equal(r.status, 404, p);
    assert.match(r.headers.get('content-type'), /^text\/plain/, p);
    assert.equal(await r.text(), 'Not found', p);
    assertHeaders(r, p);
  }
});

// Invariant: the API keeps its JSON answers and gains the headers too.
test('API responses carry the headers: health 200 and the malformed-JSON 400', async (t) => {
  const base = await serve(t, await writeDist(await tmpDir(t)));
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });
  assertHeaders(health, '/api/health');

  const bad = await fetch(`${base}/api/apps/x/share`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: 'invalid request body' });
  assertHeaders(bad, 'malformed JSON');
});

// Invariant: an error Express raises (here: an undecodable route param) reaches the terminal handler, which
// answers plain text with the headers and never echoes the error's message.
test('an undecodable path param is a text/plain 400 with the headers and no detail', async (t) => {
  const base = await serve(t, await writeDist(await tmpDir(t)));
  const r = await rawGet(base, '/api/apps/%E0%A4%A/share/defaults');
  assert.equal(r.status, 400);
  assert.match(r.type, /^text\/plain/);
  assert.equal(r.body, 'Bad Request');
  assertHeaders(r, 'malformed URI');
});

// Invariant: the terminal error handler hides a 500's message (it can carry a path) and logs it; any other
// status answers its standard reason phrase; a status outside 4xx/5xx counts as 500.
test('terminal error handler: 500 is generic and logged, other statuses use the reason phrase', async (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  const app = express();
  app.use(securityHeaders);
  app.get('/boom', () => { throw new Error('ENOENT /home/someone/secret'); });
  app.get('/big', () => { throw Object.assign(new Error('too big at /home/someone'), { status: 413 }); });
  app.get('/odd', () => { throw Object.assign(new Error('odd'), { statusCode: 42 }); });
  terminalHandlers(app);
  const base = await listen(t, http.createServer(app));

  const boom = await fetch(`${base}/boom`);
  assert.equal(boom.status, 500);
  assert.match(boom.headers.get('content-type'), /^text\/plain/);
  assert.equal(await boom.text(), 'Internal error');
  assertHeaders(boom, '/boom');
  assert.equal(logged.mock.callCount(), 1);
  assert.match(String(logged.mock.calls[0].arguments[0]?.message), /secret/);

  const big = await fetch(`${base}/big`);
  assert.equal(big.status, 413);
  assert.equal(await big.text(), 'Payload Too Large');
  assertHeaders(big, '/big');

  const odd = await fetch(`${base}/odd`);
  assert.equal(odd.status, 500);
  assert.equal(await odd.text(), 'Internal error');
});

// Invariant: with the UI unbuilt the backend still starts, logs the missing entry file, answers every UI path
// with a plain-text 503 carrying the headers, and keeps the API up.
test('unbuilt: UI paths are a text/plain 503 with the headers, the API stays up, the log names the file', async (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  const dist = path.join(await tmpDir(t), 'dist');
  const base = await serve(t, dist);
  assert.ok(logged.mock.calls.some((c) => String(c.arguments[0]).includes(path.join(dist, 'index.html'))), 'logged the missing index.html');
  for (const p of ['/', '/index.html', '/assets/x.js', '/pluginBridge.js']) {
    const r = await fetch(base + p);
    assert.equal(r.status, 503, p);
    assert.match(r.headers.get('content-type'), /^text\/plain/, p);
    assert.equal(await r.text(), 'UI not built — run npm install', p);
    assertHeaders(r, p);
  }
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  assertHeaders(health, '/api/health');
});

// Invariant: the built check runs per request, so a build finished while the backend runs is served at once.
test('a build made after start is served without a restart', async (t) => {
  t.mock.method(console, 'error', () => {});
  const dist = path.join(await tmpDir(t), 'dist');
  const base = await serve(t, dist);
  assert.equal((await fetch(`${base}/`)).status, 503);
  await writeDist(dist);
  const r = await fetch(`${base}/`);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), INDEX);
});
