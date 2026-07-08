import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server.js';
import * as appManager from '../src/appManager.js';
import { mkRoot, rmRoot, mkProject, waitFor, fakeAppCmd } from './helpers.mjs';

async function boot() {
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
