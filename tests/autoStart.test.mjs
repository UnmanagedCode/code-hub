import test from 'node:test';
import assert from 'node:assert/strict';
import { start as startServer } from '../server.js';
import * as appManager from '../src/appManager.js';
import * as appSettings from '../src/appSettings.js';
import { mkRoot, rmRoot, mkProject, mkWorktree, waitFor, fakeAppCmd, fakeCloudflaredBin, fakeTailscaleBin } from './helpers.mjs';

// Boot auto-start: appManager.init() then appManager.autoStartAll(), the order
// server.js's start() runs them in.

async function setup(t, projects) {
  process.env.CODEHUB_CLOUDFLARED_BIN = fakeCloudflaredBin;
  process.env.CODEHUB_TAILSCALE_BIN = fakeTailscaleBin;
  const root = await mkRoot();
  const ids = new Set();
  for (const [name, manifest = { start: fakeAppCmd() }] of projects) {
    await mkProject(root, name, manifest, { git: true });
    ids.add(name);
  }
  t.after(async () => {
    for (const id of ids) await appManager.stop(id).catch(() => {});
    await rmRoot(root);
  });
  return { root, ids };
}

const getApp = async (id) => (await appManager.list()).apps.find((a) => a.id === id);
const isUp = (a) => ['starting', 'ready', 'running'].includes(a.status);
const quiet = (t) => {
  const real = console.error;
  console.error = () => {};
  t.after(() => { console.error = real; });
};

// Invariant: boot auto-start starts exactly the ticked apps.
test('a ticked main app is started at boot; an unticked one is left stopped', async (t) => {
  await setup(t, [['on'], ['off']]);
  await appSettings.update('on', { autoStart: true });
  await appManager.init();
  assert.deepEqual(await appManager.autoStartAll(), { started: ['on'], failed: [] });
  assert.ok(isUp(await getApp('on')));
  assert.equal((await getApp('off')).status, 'stopped');
});

// Invariant: boot auto-start never acts on a worktree, even one hand-ticked
// in the file.
test('a hand-ticked worktree is not started', async (t) => {
  const { root, ids } = await setup(t, [['app']]);
  await mkWorktree(root, 'app', 'feat', { start: fakeAppCmd() }, { git: true });
  ids.add('app:feat');
  await appSettings.update('app:feat', { autoStart: true });
  await appManager.init();
  assert.deepEqual(await appManager.autoStartAll(), { started: [], failed: [] });
  assert.equal((await getApp('app:feat')).status, 'stopped');
});

// Invariant: an app still running from before the restart (adopted) is left
// alone — same process, no error.
test('a ticked app that is already running is not restarted', async (t) => {
  await setup(t, [['app']]);
  await appSettings.update('app', { autoStart: true });
  await appManager.init();
  const { pid } = await appManager.start('app');
  await appManager.init(); // a code-hub restart: the live pid is adopted
  assert.deepEqual(await appManager.autoStartAll(), { started: [], failed: [] });
  const app = await getApp('app');
  assert.ok(isUp(app));
  assert.equal(app.autoStartError, null);
  assert.equal((await appManager.list()).apps.length, 1);
  assert.equal((await import('../src/state.js')).pidAlive(pid), true);
});

// Invariant: one app's failure to start neither blocks the others nor goes
// unseen — it shows in the listing.
test('a ticked app with a broken manifest records autoStartError; the next ticked app still starts', async (t) => {
  quiet(t);
  await setup(t, [['broken', { name: 'no start command' }], ['good']]);
  await appSettings.update('broken', { autoStart: true });
  await appSettings.update('good', { autoStart: true });
  await appManager.init();
  const res = await appManager.autoStartAll();
  assert.deepEqual(res, { started: ['good'], failed: ['broken'] });
  const broken = await getApp('broken');
  assert.equal(broken.status, 'stopped');
  assert.ok(broken.manifestError);
  assert.equal(broken.autoStartError, broken.manifestError);
  assert.ok(isUp(await getApp('good')));
});

// Invariant: a boot start is a real start, so an app ticked for both opens its
// share at boot.
test('an app ticked for auto-start and auto-share is shared after boot', async (t) => {
  await setup(t, [['app']]);
  await appSettings.update('app', { autoStart: true, autoShare: { mode: 'lan', tls: false } });
  await appManager.init();
  await appManager.autoStartAll();
  assert.deepEqual(await appManager.awaitSettled('app'), { id: 'app', settled: true });
  const app = await getApp('app');
  assert.equal(app.tunnel?.kind, 'lan');
  assert.equal(app.autoShareStatus, null);
});

// Invariant: adoption is not a start — an adopted app is never auto-shared,
// even though its pre-restart share was torn down at boot.
test('an adopted app ticked for auto-share is left unshared after init() and autoStartAll()', async (t) => {
  await setup(t, [['app']]);
  await appSettings.update('app', { autoStart: true, autoShare: { mode: 'lan', tls: false } });
  await appManager.init();
  await appManager.autoStartAll();
  await appManager.awaitSettled('app');
  assert.equal((await getApp('app')).tunnel?.kind, 'lan'); // persisted share before the "restart"
  await appManager.init();
  await appManager.autoStartAll();
  await appManager.awaitSettled('app');
  const app = await getApp('app');
  assert.ok(isUp(app));
  assert.equal(app.tunnel, null);
});

// Invariant: auto-start runs after the hub is listening and doesn't hold up
// its boot.
test('server start() answers /api/health and auto-starts a ticked app in the background', async (t) => {
  await setup(t, [['app']]);
  await appSettings.update('app', { autoStart: true });
  const server = await startServer({ port: 0 });
  t.after(() => new Promise((r) => server.close(r)));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/health`);
  assert.deepEqual(await res.json(), { ok: true });
  await waitFor(async () => ['ready', 'running'].includes((await getApp('app')).status));
});
