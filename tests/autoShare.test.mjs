import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { createServer } from '../server.js';
import * as appManager from '../src/appManager.js';
import * as appSettings from '../src/appSettings.js';
import * as autoRun from '../src/autoRun.js';
import { storeRoot } from '../src/projects.js';
import { mkRoot, rmRoot, mkProject, mkWorktree, waitFor, pidAlive, fakeAppCmd, fakeCloudflaredBin, fakeTailscaleBin } from './helpers.mjs';

// End-to-end auto-share over HTTP: a fake app, fake cloudflared and fake
// tailscale (env-injected), and the GET …/settled long-poll as the only wait.

async function boot(t, projects = ['app']) {
  process.env.CODEHUB_CLOUDFLARED_BIN = fakeCloudflaredBin;
  process.env.CODEHUB_TAILSCALE_BIN = fakeTailscaleBin;
  const root = await mkRoot();
  for (const name of projects) await mkProject(root, name, { start: fakeAppCmd() }, { git: true });
  await appManager.init();
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const ids = new Set(projects);
  t.after(async () => {
    for (const id of ids) await appManager.stop(id).catch(() => {});
    server.close();
    await rmRoot(root);
  });
  return { root, base, ids };
}

const j = async (base, method, path, body) => {
  const r = await fetch(base + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json() };
};
const getApp = async (base, id = 'app') => (await j(base, 'GET', '/api/apps')).body.apps.find((a) => a.id === id);
const enc = encodeURIComponent;
const settled = (base, id = 'app') => j(base, 'GET', `/api/apps/${enc(id)}/settled`);
const quiet = (t) => {
  const real = console.error;
  console.error = () => {};
  t.after(() => { console.error = real; });
};

// Invariant: one Start of a ticked app shares it with no second request, using
// the stored mode/auth/TLS and the stored default login.
test('a ticked app is shared by its Start alone, with the stored config and login', async (t) => {
  const { base } = await boot(t);
  await j(base, 'PUT', '/api/apps/app/settings', { username: 'alice', autoShare: { mode: 'lan', auth: true, tls: false } });
  assert.equal((await j(base, 'POST', '/api/apps/app/start')).status, 200);
  assert.deepEqual((await settled(base)).body, { id: 'app', settled: true });
  const app = await getApp(base);
  assert.equal(app.tunnel?.kind, 'lan');
  assert.equal(app.tunnel.tls, false);
  assert.equal(app.tunnel.auth, true);
  assert.equal(app.tunnel.username, 'alice');
  assert.equal(app.autoShareStatus, null);
  assert.equal(app.autoShareError, null);
});

// Invariant: an app without auto-share is started exactly as before.
test('an unticked app starts unshared, with nothing pending', async (t) => {
  const { base } = await boot(t);
  await j(base, 'POST', '/api/apps/app/start');
  assert.equal((await getApp(base)).autoShareStatus, null);
  assert.deepEqual((await settled(base)).body, { id: 'app', settled: true });
  const app = await getApp(base);
  assert.ok(['ready', 'running'].includes(app.status));
  assert.equal(app.tunnel, null);
  assert.equal(app.autoShareStatus, null);
});

// Invariant: Restart is a start, so it auto-shares the fresh process.
test('restarting a ticked, shared app shares it again', async (t) => {
  const { base } = await boot(t);
  await j(base, 'PUT', '/api/apps/app/settings', { autoShare: { mode: 'tunnel' } });
  await j(base, 'POST', '/api/apps/app/start');
  await settled(base);
  const first = await getApp(base);
  assert.equal(first.tunnel?.kind, 'tunnel');
  assert.equal((await j(base, 'POST', '/api/apps/app/restart')).status, 200);
  await settled(base);
  const again = await getApp(base);
  assert.equal(again.tunnel?.kind, 'tunnel');
  assert.notEqual(again.tunnel.proxyPort, first.tunnel.proxyPort);
});

// Invariant: every start path auto-shares, the MCP start_app tool included.
test('MCP start_app on a ticked app shares it', async (t) => {
  const { base } = await boot(t);
  await j(base, 'PUT', '/api/apps/app/settings', { autoShare: { mode: 'lan', tls: false } });
  const res = await j(base, 'POST', '/api/mcp', { tool: 'start_app', arguments: { id: 'app' }, caller: { sessionId: 's', project: 'p' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.error, undefined);
  await settled(base);
  assert.equal((await getApp(base)).tunnel?.kind, 'lan');
});

// Invariant: a funnel held by another app makes the auto-share fail visibly,
// naming the holder, while the start stands and the holder's share is untouched.
test('auto-share into a held tailscale funnel fails visibly; the start and the holder are unaffected', async (t) => {
  quiet(t);
  const { base } = await boot(t, ['holder', 'app']);
  await j(base, 'POST', '/api/apps/holder/start');
  await settled(base, 'holder');
  assert.equal((await j(base, 'POST', '/api/apps/holder/share', { mode: 'tailscale' })).status, 200);
  const held = (await getApp(base, 'holder')).tunnel;

  await j(base, 'PUT', '/api/apps/app/settings', { autoShare: { mode: 'tailscale' } });
  await j(base, 'POST', '/api/apps/app/start');
  await settled(base);
  const app = await getApp(base);
  assert.ok(['ready', 'running'].includes(app.status));
  assert.equal(app.tunnel, null);
  assert.equal(app.autoShareStatus, 'failed');
  assert.match(app.autoShareError, /'holder' already has a tailscale share/);
  const after = (await getApp(base, 'holder')).tunnel;
  assert.equal(after.url, held.url);
  assert.equal(after.proxyPort, held.proxyPort);
});

// Invariant: a share never runs against an app that did not become ready; the
// start itself still answers 200, and the reason shows in the listing.
test('a ticked app that crashes is not shared, and the failure is visible', async (t) => {
  const { root, base } = await boot(t, []);
  await mkProject(root, 'app', { start: fakeAppCmd('crash') }, { git: true });
  await j(base, 'PUT', '/api/apps/app/settings', { autoShare: { mode: 'lan' } });
  assert.equal((await j(base, 'POST', '/api/apps/app/start')).status, 200);
  await settled(base);
  const app = await getApp(base);
  assert.equal(app.status, 'crashed');
  assert.equal(app.tunnel, null);
  assert.equal(app.autoShareStatus, 'failed');
  assert.equal(app.autoShareError, 'app did not become ready (crashed) — not shared');
});

// Invariant: a worktree is never auto-shared, even with a hand-written config.
test('a worktree with a hand-written autoShare is started but never shared', async (t) => {
  const { root, base, ids } = await boot(t);
  await mkWorktree(root, 'app', 'feat', { start: fakeAppCmd() }, { git: true });
  ids.add('app:feat');
  await appSettings.update('app:feat', { autoShare: { mode: 'lan' } }); // the store itself doesn't police the kind
  await j(base, 'POST', `/api/apps/${enc('app:feat')}/start`);
  assert.equal((await getApp(base, 'app:feat')).autoShareStatus, null);
  await settled(base, 'app:feat');
  const wt = await getApp(base, 'app:feat');
  assert.ok(['ready', 'running'].includes(wt.status));
  assert.equal(wt.tunnel, null);
  assert.equal(wt.autoShareStatus, null);
});

// Invariant: any successful share, by hand included, clears a stale failure.
test('a manual share after a failed auto-share clears the failure', async (t) => {
  quiet(t);
  const { base } = await boot(t);
  await j(base, 'PUT', '/api/apps/app/settings', { autoShare: { mode: 'tailscale' } });
  process.env.CODEHUB_TAILSCALE_BIN = '/nonexistent/tailscale'; // the auto-share answers 501
  t.after(() => { process.env.CODEHUB_TAILSCALE_BIN = fakeTailscaleBin; });
  await j(base, 'POST', '/api/apps/app/start');
  await settled(base);
  assert.equal((await getApp(base)).autoShareStatus, 'failed');
  assert.match((await getApp(base)).autoShareError, /tailscale is not available/);
  assert.equal((await j(base, 'POST', '/api/apps/app/share', { mode: 'lan', tls: false })).status, 200);
  const app = await getApp(base);
  assert.equal(app.autoShareStatus, null);
  assert.equal(app.autoShareError, null);
});

// Invariant: the settle wait never hangs on an app with nothing in flight.
test('GET settled for a stopped app answers at once with settled:true', async (t) => {
  const { base } = await boot(t);
  const t0 = Date.now();
  assert.deepEqual((await settled(base)).body, { id: 'app', settled: true });
  assert.ok(Date.now() - t0 < 2000);
  await waitFor(async () => (await getApp(base)).status === 'stopped');
});

// --- Deterministic in-flight states: a gated app (`starting` until its gate
// file exists) and a gated cloudflared (its URL held back until its gate file
// exists, each tunnel child's pid logged). Gate files are dot-files under the
// projects root, which discovery skips.

async function gatedApp(t, root, ids, id = 'app') {
  const gate = path.join(root, `.${id}-gate`);
  await mkProject(root, id, { start: fakeAppCmd('gated', gate) }, { git: true });
  ids.add(id);
  return { open: () => fs.writeFile(gate, '') };
}

function gatedCloudflared(t, root) {
  const gate = path.join(root, '.cloudflared-gate');
  const log = path.join(root, '.cloudflared-pids');
  process.env.FAKE_CLOUDFLARED_GATE = gate;
  process.env.FAKE_CLOUDFLARED_PID_LOG = log;
  t.after(async () => {
    await fs.writeFile(gate, '').catch(() => {}); // never leave a child parked
    delete process.env.FAKE_CLOUDFLARED_GATE;
    delete process.env.FAKE_CLOUDFLARED_PID_LOG;
  });
  const pids = async () => (await fs.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(Number);
  return { open: () => fs.writeFile(gate, ''), pids };
}

// Invariant: a real start of a ticked app reports its auto-share as pending
// while the app is still starting.
test('a listing taken while a ticked app is still starting shows autoShareStatus pending', async (t) => {
  const { root, base, ids } = await boot(t, []);
  const app = await gatedApp(t, root, ids);
  await j(base, 'PUT', '/api/apps/app/settings', { autoShare: { mode: 'lan', tls: false } });
  assert.equal((await j(base, 'POST', '/api/apps/app/start')).status, 200);
  const listed = await getApp(base);
  assert.equal(listed.status, 'starting');
  assert.equal(listed.autoShareStatus, 'pending');
  await app.open();
  await settled(base);
  assert.equal((await getApp(base)).tunnel?.kind, 'lan');
});

// Invariant: a share made by hand while a ticked app is starting is the one
// the app keeps — the auto-share, once readiness settles, doesn't replace it.
test('a manual share during startup survives the auto-share when the start settles', async (t) => {
  const { root, base, ids } = await boot(t, []);
  const app = await gatedApp(t, root, ids);
  await j(base, 'PUT', '/api/apps/app/settings', { autoShare: { mode: 'lan', tls: false } });
  await j(base, 'POST', '/api/apps/app/start');
  const manual = await j(base, 'POST', '/api/apps/app/share', { mode: 'tunnel' });
  assert.equal(manual.status, 200);
  const before = (await getApp(base)).tunnel;
  assert.equal(before.kind, 'tunnel');
  await app.open();
  await settled(base);
  const after = await getApp(base);
  assert.ok(['ready', 'running'].includes(after.status));
  assert.equal(after.tunnel?.kind, 'tunnel');
  assert.equal(after.tunnel.url, before.url);
  assert.equal(after.tunnel.proxyPort, before.proxyPort);
  assert.equal(after.autoShareStatus, null);
  assert.equal(after.autoShareError, null);
});

// Invariant: Stop drops the app's automation state — a failed auto-share and
// a recorded auto-start failure don't outlive it on a stopped card.
test('Stop after a failed auto-share leaves autoShareStatus, autoShareError and autoStartError null', async (t) => {
  quiet(t);
  const { base } = await boot(t);
  await j(base, 'PUT', '/api/apps/app/settings', { autoShare: { mode: 'tailscale' } });
  process.env.CODEHUB_TAILSCALE_BIN = '/nonexistent/tailscale';
  t.after(() => { process.env.CODEHUB_TAILSCALE_BIN = fakeTailscaleBin; });
  await j(base, 'POST', '/api/apps/app/start');
  await settled(base);
  autoRun.recordStartError('app', 'an earlier boot start failed');
  const failed = await getApp(base);
  assert.equal(failed.autoShareStatus, 'failed');
  assert.equal(failed.autoStartError, 'an earlier boot start failed');
  assert.equal((await j(base, 'POST', '/api/apps/app/stop')).status, 200);
  const stopped = await getApp(base);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.autoShareStatus, null);
  assert.equal(stopped.autoShareError, null);
  assert.equal(stopped.autoStartError, null);
});

// Invariant: an unreadable settings file during a start is reported on the
// card, never swallowed into a silent, unshared start.
test('an unreadable app-settings.json during a start shows an auto-share failure on the card', async (t) => {
  quiet(t);
  const { base } = await boot(t);
  const file = appSettings.appSettingsFile();
  await fs.mkdir(file, { recursive: true }); // a directory where the file belongs: EISDIR, even as root
  t.after(() => fs.rm(file, { recursive: true, force: true }));
  assert.equal((await j(base, 'POST', '/api/apps/app/start')).status, 200);
  await settled(base);
  await fs.rm(file, { recursive: true }); // the listing reads the file too
  const app = await getApp(base);
  assert.ok(['ready', 'running'].includes(app.status));
  assert.equal(app.tunnel, null);
  assert.equal(app.autoShareStatus, 'failed');
  assert.match(app.autoShareError, /EISDIR|directory/);
});

// Invariant: one share operation per app at a time — a share overlapping an
// in-flight auto-share is refused, exactly one tunnel child ever runs, and
// Unshare kills it.
test('a manual share overlapping an in-flight auto-share is refused; one child, and Unshare kills it', async (t) => {
  const { root, base } = await boot(t);
  const cf = gatedCloudflared(t, root);
  await j(base, 'PUT', '/api/apps/app/settings', { autoShare: { mode: 'tunnel' } });
  await j(base, 'POST', '/api/apps/app/start');
  await waitFor(async () => (await cf.pids()).length === 1); // the auto-share's child is up, URL held back
  const clash = await j(base, 'POST', '/api/apps/app/share', { mode: 'tunnel' });
  assert.equal(clash.status, 409);
  assert.match(clash.body.error, /already has a share starting/);
  await cf.open();
  await settled(base);
  const app = await getApp(base);
  assert.equal(app.tunnel?.kind, 'tunnel');
  assert.equal(app.autoShareStatus, null);
  const pids = await cf.pids();
  assert.equal(pids.length, 1, 'the refused share never started a child');
  assert.equal(pidAlive(pids[0]), true);
  assert.equal((await j(base, 'DELETE', '/api/apps/app/share')).status, 200);
  await waitFor(() => !pidAlive(pids[0]));
});

// Invariant: a share still in flight when its app is stopped commits nothing —
// its tunnel child is killed and no share is left on any record.
test('Stop during an in-flight auto-share leaves no tunnel child behind', async (t) => {
  const { root, base } = await boot(t);
  const cf = gatedCloudflared(t, root);
  await j(base, 'PUT', '/api/apps/app/settings', { autoShare: { mode: 'tunnel' } });
  await j(base, 'POST', '/api/apps/app/start');
  await waitFor(async () => (await cf.pids()).length === 1);
  const [pid] = await cf.pids();
  assert.equal((await j(base, 'POST', '/api/apps/app/stop')).status, 200);
  await cf.open();
  await settled(base); // the auto-share's own run is the tracked transition
  await waitFor(() => !pidAlive(pid));
  const app = await getApp(base);
  assert.equal(app.status, 'stopped');
  assert.equal(app.tunnel, null);
  assert.equal(app.autoShareStatus, null);
});

// Invariant: start() tracks its transition (and marks the auto-share pending)
// in the same step that makes its record visible — a listing can't show the
// app `starting` while a settle wait would answer at once.
test('while start() is still persisting, the visible record is already tracked and pending', async (t) => {
  const { root, ids } = await boot(t, []);
  const app = await gatedApp(t, root, ids);
  await appSettings.update('app', { autoShare: { mode: 'lan', tls: false } });
  const stateFile = path.join(storeRoot(), 'state.json');
  const realRename = fs.rename;
  let release, reached, armed = true;
  const gate = new Promise((r) => { release = r; });
  const parked = new Promise((r) => { reached = r; });
  fs.rename = async (from, to) => {
    if (armed && to === stateFile) { armed = false; reached(); await gate; }
    return realRename(from, to);
  };
  t.after(() => { release(); fs.rename = realRename; });
  const starting = appManager.start('app');
  await parked; // the record is in the store; its persist hasn't landed
  const listed = (await appManager.list()).apps.find((a) => a.id === 'app');
  assert.equal(listed.status, 'starting');
  assert.equal(listed.autoShareStatus, 'pending');
  assert.deepEqual(await autoRun.awaitSettled('app', { capMs: 50 }), { id: 'app', settled: false });
  release();
  await starting;
  await app.open();
  assert.deepEqual(await appManager.awaitSettled('app'), { id: 'app', settled: true });
});

// Invariant: when list() drops the record of an app that died unnoticed, its
// automation state goes with it — no stale failure on a stopped card.
test('list()\'s prune of a dead adopted app clears its automation state', async (t) => {
  const { root } = await boot(t, []);
  const dir = await mkProject(root, 'adopted', { start: fakeAppCmd() }, { git: true });
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { detached: true, stdio: 'ignore' });
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } });
  await fs.mkdir(storeRoot(), { recursive: true });
  await fs.writeFile(path.join(storeRoot(), 'state.json'), JSON.stringify({ apps: { adopted: {
    id: 'adopted', project: 'adopted', path: dir, isWorktree: false, branch: null,
    pid: child.pid, pgid: child.pid, port: 1, fixedPort: null, urls: [], startedSha: null, startedAt: null, tunnel: null,
  } } }));
  await appManager.init(); // adopts the live pid
  const gen = autoRun.begin('adopted', { autoShare: true });
  await autoRun.run({ id: 'adopted', gen, settled: Promise.resolve('crashed'), isCurrent: () => true, readConfig: async () => ({ mode: 'lan' }), share: async () => {} });
  autoRun.recordStartError('adopted', 'boot start failed');
  const before = (await appManager.list()).apps.find((a) => a.id === 'adopted');
  assert.equal(before.status, 'running');
  assert.equal(before.autoShareStatus, 'failed');
  child.kill('SIGKILL');
  await once(child, 'exit');
  const after = (await appManager.list()).apps.find((a) => a.id === 'adopted');
  assert.equal(after.status, 'stopped');
  assert.deepEqual([after.autoShareStatus, after.autoShareError, after.autoStartError], [null, null, null]);
});
