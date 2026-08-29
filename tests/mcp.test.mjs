import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server.js';
import * as appManager from '../src/appManager.js';
import { mkRoot, rmRoot, mkProject, waitFor, fakeAppCmd, fakeTailscaleBin } from './helpers.mjs';

async function boot() {
  process.env.CODEHUB_TAILSCALE_BIN = fakeTailscaleBin;
  await appManager.init();
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base };
}

const mcp = async (base, tool, args) => {
  const r = await fetch(base + '/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool, arguments: args, caller: { sessionId: 's1', project: 'p1' } }),
  });
  return { status: r.status, body: await r.json() };
};

test('list_apps: happy path matches GET /api/apps shape', async (t) => {
  const root = await mkRoot();
  await mkProject(root, 'app', { start: fakeAppCmd() });
  const { server, base } = await boot();
  t.after(async () => { server.close(); await rmRoot(root); });

  const res = await mcp(base, 'list_apps', {});
  assert.equal(res.status, 200);
  assert.equal(res.body.error, undefined);
  const app0 = res.body.result.apps.find((a) => a.id === 'app');
  assert.equal(app0.status, 'stopped');
  assert.equal(typeof res.body.result.cloudflaredAvailable, 'boolean');
  // Asserted TRUE, not merely boolean: boot() injects the fake tailscale, so
  // this is deterministic here — and a hardcoded false would disable the share
  // mode everywhere while still typechecking. (cloudflared stays a typeof
  // check: no fake is injected in this file, so it is host-dependent.)
  assert.equal(res.body.result.tailscaleAvailable, true);
});

test('start_app then stop_app: happy path', async (t) => {
  const root = await mkRoot();
  await mkProject(root, 'app', { start: fakeAppCmd() });
  const { server, base } = await boot();
  t.after(async () => { await appManager.stop('app').catch(() => {}); server.close(); await rmRoot(root); });

  let res = await mcp(base, 'start_app', { id: 'app' });
  assert.equal(res.status, 200);
  assert.ok(res.body.result.port);
  assert.ok(res.body.result.urls.some((u) => u.startsWith('http://localhost:')));

  await waitFor(async () => {
    const { body } = await mcp(base, 'list_apps', {});
    return ['ready', 'running'].includes(body.result.apps.find((a) => a.id === 'app').status);
  });

  res = await mcp(base, 'stop_app', { id: 'app' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.result, { id: 'app', status: 'stopped' });
});

test('unknown tool → 200 {error}', async (t) => {
  const root = await mkRoot();
  const { server, base } = await boot();
  t.after(async () => { server.close(); await rmRoot(root); });

  const res = await mcp(base, 'bogus_tool', {});
  assert.equal(res.status, 200);
  assert.equal(res.body.error, 'unknown tool: bogus_tool');
});

test('bad args (missing id) → 200 {error}, not a transport failure', async (t) => {
  const root = await mkRoot();
  const { server, base } = await boot();
  t.after(async () => { server.close(); await rmRoot(root); });

  const res = await mcp(base, 'start_app', {});
  assert.equal(res.status, 200);
  assert.match(res.body.error, /id is required/);
});

test('tool-level failure (starting an unknown app id) → 200 {error}', async (t) => {
  const root = await mkRoot();
  const { server, base } = await boot();
  t.after(async () => { server.close(); await rmRoot(root); });

  const res = await mcp(base, 'start_app', { id: 'does-not-exist' });
  assert.equal(res.status, 200);
  assert.ok(res.body.error);
});

test('register_app then unregister_app: happy path', async (t) => {
  const root = await mkRoot();
  await mkProject(root, 'tool', null);
  const { server, base } = await boot();
  t.after(async () => { server.close(); await rmRoot(root); });

  let res = await mcp(base, 'register_app', { id: 'tool', start: 'npm start', name: 'Tool' });
  assert.equal(res.status, 200);
  assert.equal(res.body.result.source, 'registry');
  assert.equal(res.body.result.manifest.start, 'npm start');

  res = await mcp(base, 'list_apps', {});
  assert.ok(res.body.result.apps.some((a) => a.id === 'tool'));

  res = await mcp(base, 'unregister_app', { id: 'tool' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.result, { id: 'tool', registered: false });

  res = await mcp(base, 'list_apps', {});
  assert.ok(!res.body.result.apps.some((a) => a.id === 'tool'));
});

test('register_app: rejecting a dir that already has a .hub.json → 200 {error}', async (t) => {
  const root = await mkRoot();
  await mkProject(root, 'has-manifest', { start: 'x' });
  const { server, base } = await boot();
  t.after(async () => { server.close(); await rmRoot(root); });

  const res = await mcp(base, 'register_app', { id: 'has-manifest', start: 'npm start' });
  assert.equal(res.status, 200);
  assert.match(res.body.error, /already has a \.hub\.json/);
});

test('missing tool field → 400 (malformed envelope)', async (t) => {
  const root = await mkRoot();
  const { server, base } = await boot();
  t.after(async () => { server.close(); await rmRoot(root); });

  const r = await fetch(base + '/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ arguments: {} }),
  });
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.match(body.error, /tool is required/);
});

test('malformed JSON body → 400', async (t) => {
  const root = await mkRoot();
  const { server, base } = await boot();
  t.after(async () => { server.close(); await rmRoot(root); });

  const r = await fetch(base + '/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not valid json',
  });
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.ok(body.error);
});

test('register_app: an optional fixed port round-trips through the MCP envelope', async (t) => {
  const root = await mkRoot();
  await mkProject(root, 'tool', null);
  const { server, base } = await boot();
  t.after(async () => { server.close(); await rmRoot(root); });

  const res = await mcp(base, 'register_app', { id: 'tool', start: 'npm start', port: 3100 });
  assert.equal(res.status, 200);
  assert.equal(res.body.result.manifest.port, 3100);

  const listed = await mcp(base, 'list_apps', {});
  assert.ok(listed.body.result.apps.some((a) => a.id === 'tool'));
});

test('register_app: an out-of-range port is a tool-level error (200 with {error})', async (t) => {
  const root = await mkRoot();
  await mkProject(root, 'tool', null);
  const { server, base } = await boot();
  t.after(async () => { server.close(); await rmRoot(root); });

  const res = await mcp(base, 'register_app', { id: 'tool', start: 'npm start', port: 80 });
  assert.equal(res.status, 200); // a bad argument is a normal MCP outcome, not a transport failure
  assert.match(res.body.error, /"port" must be an integer between 1024 and 65535/);
});
