import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import * as runner from '../src/runner.js';
import { allocatePort } from '../src/net.js';
import path from 'node:path';
import { promises as fs, existsSync, readFileSync, writeFileSync, statSync, openSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import * as appLog from '../src/appLog.js';
import { mkRoot, rmRoot, mkProject, waitFor, pidAlive, fakeAppCmd, openFdsOf } from './helpers.mjs';

function get(port) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/' }, (res) => { res.resume(); resolve(res.statusCode); })
      .on('error', reject);
  });
}

test('start injects PORT, becomes ready (TCP), and serves; stop kills the process group', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const dir = await mkProject(root, 'app', { start: fakeAppCmd() });
  const app = { id: 'app', path: dir, manifest: { start: fakeAppCmd(), healthPath: null, readyWhen: null } };

  const port = await allocatePort();
  const rec = await runner.start(app, port);
  assert.equal(rec.port, port);
  assert.equal(rec.pid, rec.pgid);

  await waitFor(() => runner.runtime('app')?.status === 'ready');
  assert.equal(await get(port), 200);

  runner.stop({ id: 'app', pgid: rec.pgid });
  await waitFor(() => !pidAlive(rec.pgid));
  assert.equal(pidAlive(rec.pgid), false);
});

test('readyWhen regex drives readiness from stdout', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const dir = await mkProject(root, 'app', { start: fakeAppCmd() });
  const app = { id: 'rw', path: dir, manifest: { start: fakeAppCmd(), healthPath: null, readyWhen: 'listening on' } };

  const port = await allocatePort();
  const rec = await runner.start(app, port);
  await waitFor(() => runner.runtime('rw')?.status === 'ready');
  runner.stop({ id: 'rw', pgid: rec.pgid });
  await waitFor(() => !pidAlive(rec.pgid));
});

test('readyWhen matches a ready line split across two output chunks', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const dir = await mkProject(root, 'app', { start: fakeAppCmd('split') });
  const app = { id: 'rwsplit', path: dir, manifest: { start: fakeAppCmd('split'), healthPath: null, readyWhen: 'listening on \\d+' } };

  const port = await allocatePort();
  const rec = await runner.start(app, port);
  t.after(() => runner.stop({ id: 'rwsplit', pgid: rec.pgid }));
  await waitFor(() => runner.runtime('rwsplit')?.status === 'ready');
  runner.stop({ id: 'rwsplit', pgid: rec.pgid });
  await waitFor(() => !pidAlive(rec.pgid));
});

// Pins: the runner advances the matcher's `total` with every chunk. A frozen
// total makes each scan cover only the overlap tail, so a ready line followed
// by at least READY_OVERLAP_CHARS more output in the same tick is never seen.
test('readyWhen still finds a ready line buried under more than READY_OVERLAP_CHARS of later output', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const dir = await mkProject(root, 'app', { start: fakeAppCmd('flood') });
  const app = { id: 'rwflood', path: dir, manifest: { start: fakeAppCmd('flood'), healthPath: null, readyWhen: 'listening on \\d+' } };

  const port = await allocatePort();
  const rec = await runner.start(app, port);
  t.after(() => runner.stop({ id: 'rwflood', pgid: rec.pgid }));
  await waitFor(() => runner.runtime('rwflood')?.status === 'ready');
});

test('a start command that exits immediately is reported crashed with a tail', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const dir = await mkProject(root, 'app', { start: fakeAppCmd('crash') });
  const app = { id: 'boom', path: dir, manifest: { start: fakeAppCmd('crash'), healthPath: null, readyWhen: null } };

  const port = await allocatePort();
  await runner.start(app, port);
  await waitFor(() => runner.runtime('boom')?.status === 'crashed');
  assert.match(runner.runtime('boom').error, /boom: could not start/);
});

test('EADDRINUSE on first bind triggers a retry on a new port', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const dir = await mkProject(root, 'app', { start: fakeAppCmd() });
  const app = { id: 'race', path: dir, manifest: { start: fakeAppCmd(), healthPath: null, readyWhen: null } };

  const port = await allocatePort();
  // Occupy the allocated port ourselves to force a real EADDRINUSE in the child.
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(port, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => blocker.close(resolve)));

  const rec = await runner.start(app, port);
  assert.notEqual(rec.port, port);
  await waitFor(() => runner.runtime('race')?.status === 'ready');

  runner.stop({ id: 'race', pgid: rec.pgid });
  await waitFor(() => !pidAlive(rec.pgid));
});

test('EADDRINUSE that never clears still surfaces as crashed after the retry budget', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const dir = await mkProject(root, 'app', { start: fakeAppCmd('addrinuse') });
  const app = { id: 'stuck', path: dir, manifest: { start: fakeAppCmd('addrinuse'), healthPath: null, readyWhen: null } };

  const port = await allocatePort();
  await runner.start(app, port);
  assert.equal(runner.runtime('stuck').status, 'crashed');
  assert.match(runner.runtime('stuck').error, /EADDRINUSE/);
});

test('a pinned port that is busy does NOT move — no retry, surfaces as crashed', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const dir = await mkProject(root, 'app', { start: fakeAppCmd() });
  const app = { id: 'pinned', path: dir, manifest: { start: fakeAppCmd(), healthPath: null, readyWhen: null } };

  const port = await allocatePort();
  // Same deliberate-blocker setup as the retry test above — the only difference
  // is `{ fixed: true }`, so this pins exactly the behaviour that flag buys:
  // the retry path would have returned a DIFFERENT port here.
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(port, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => blocker.close(resolve)));

  const rec = await runner.start(app, port, { fixed: true });
  assert.equal(rec.port, port, 'a fixed port must never be silently reallocated');
  assert.equal(runner.runtime('pinned').status, 'crashed');
  assert.match(runner.runtime('pinned').error, /EADDRINUSE/);
});

test('a pinned port that is free starts normally', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const dir = await mkProject(root, 'app', { start: fakeAppCmd() });
  const app = { id: 'pinned-ok', path: dir, manifest: { start: fakeAppCmd(), healthPath: null, readyWhen: null } };

  const port = await allocatePort();
  const rec = await runner.start(app, port, { fixed: true });
  assert.equal(rec.port, port);
  await waitFor(() => runner.runtime('pinned-ok')?.status === 'ready');
  assert.equal(await get(port), 200);

  runner.stop({ id: 'pinned-ok', pgid: rec.pgid });
  await waitFor(() => !pidAlive(rec.pgid));
});

// Invariant: the readiness outcome is observable as a promise on start()'s
// result — 'ready' once the app answers, 'crashed' for one that exits first.
test('start() returns a settled promise: ready for a healthy app, crashed for one that exits', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const dir = await mkProject(root, 'app', { start: fakeAppCmd() });
  const ok = { id: 'settle-ok', path: dir, manifest: { start: fakeAppCmd(), healthPath: null, readyWhen: null } };
  const rec = await runner.start(ok, await allocatePort());
  t.after(() => runner.stop({ id: 'settle-ok', pgid: rec.pgid }));
  assert.equal(await rec.settled, 'ready');
  assert.equal(runner.runtime('settle-ok').status, 'ready');

  const bad = { id: 'settle-crash', path: dir, manifest: { start: fakeAppCmd('crash'), healthPath: null, readyWhen: null } };
  const crashed = await runner.start(bad, await allocatePort());
  assert.equal(await crashed.settled, 'crashed');
});

// Invariant: the app gets code-hub's environment plus its injected PORT.
test('apps are spawned with code-hub\'s environment and PORT', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  process.env.CODEHUB_TEST_INHERITED = 'inherited-value';
  t.after(() => { delete process.env.CODEHUB_TEST_INHERITED; });
  const marker = path.join(root, 'env.json');
  const cmd = fakeAppCmd('envdump', marker);
  const dir = await mkProject(root, 'app', { start: cmd });
  const port = await allocatePort();
  const rec = await runner.start({ id: 'envdump', path: dir, manifest: { start: cmd, healthPath: null, readyWhen: null } }, port);
  t.after(() => runner.stop({ id: 'envdump', pgid: rec.pgid }));
  await waitFor(() => runner.runtime('envdump')?.status === 'ready');
  const env = JSON.parse(await fs.readFile(marker, 'utf8'));
  assert.equal(env.PORT, String(port));
  assert.equal(env.CODEHUB_TEST_INHERITED, 'inherited-value');
});

// Invariant (S10): every exit of a spawned child — a crash before readiness,
// the app exiting on its own after it, a stop — calls the onExit listeners
// with its id, so the loopback mirror set can follow it without a persist.
test('onExit listeners hear every child exit with the app id: crash, self-exit and stop', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const heard = [];
  runner.onExit((id) => heard.push(id));
  const dir = await mkProject(root, 'app', { start: fakeAppCmd() });

  const crash = await runner.start({ id: 'exit-crash', path: dir, manifest: { start: fakeAppCmd('crash'), healthPath: null, readyWhen: null } }, await allocatePort());
  assert.equal(await crash.settled, 'crashed');
  await waitFor(() => heard.includes('exit-crash'));

  // Ready first, then the app exits on its own: SIGTERM to the app process
  // only (not the group), which the fake app answers by exiting 0.
  const self = await runner.start({ id: 'exit-self', path: dir, manifest: { start: `exec ${fakeAppCmd()}`, healthPath: null, readyWhen: null } }, await allocatePort());
  t.after(() => runner.stop({ id: 'exit-self', pgid: self.pgid }));
  assert.equal(await self.settled, 'ready');
  assert.ok(!heard.includes('exit-self'));
  process.kill(self.pid, 'SIGTERM');
  await waitFor(() => heard.includes('exit-self'));
  assert.equal(runner.runtime('exit-self').status, 'exited');

  const stopped = await runner.start({ id: 'exit-stop', path: dir, manifest: { start: fakeAppCmd(), healthPath: null, readyWhen: null } }, await allocatePort());
  assert.equal(await stopped.settled, 'ready');
  runner.stop({ id: 'exit-stop', pgid: stopped.pgid });
  await waitFor(() => heard.includes('exit-stop'));
});

// Pins: the app's output path depends on no code-hub process staying alive —
// after the launcher is SIGKILLed the app neither hits EPIPE nor stops serving,
// and its post-launcher output is readable at appLog.logFile for a new hub.
test('an app keeps running, writing and serving after the code-hub that launched it is killed', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const marker = path.join(root, 'marker');
  const start = fakeAppCmd('chatty', marker);
  const dir = await mkProject(root, 'app', { start });
  const port = await allocatePort();

  const launcher = spawn(process.execPath,
    [new URL('./fixtures/launch-app.mjs', import.meta.url).pathname, 'chat', dir, start, String(port)],
    { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, PROJECTS_ROOT: root } });
  t.after(() => launcher.kill('SIGKILL'));
  let out = '';
  launcher.stdout.on('data', (d) => { out += d; });
  await waitFor(() => out.includes('\n'));
  const { status, pid, pgid } = JSON.parse(out);
  t.after(() => { try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ } });
  assert.equal(status, 'ready');

  const exited = new Promise((r) => launcher.on('exit', r));
  launcher.kill('SIGKILL');
  await exited;

  const maxTick = () => Math.max(0, ...[...readFileSync(appLog.logFile('chat'), 'utf8').matchAll(/tick (\d+)/g)].map((m) => Number(m[1])));
  const before = maxTick();
  await waitFor(() => maxTick() >= before + 5);

  assert.equal(pidAlive(pid), true);
  assert.equal(existsSync(marker), false, existsSync(marker) ? readFileSync(marker, 'utf8') : '');
  assert.equal(await get(port), 200);
});

// Pins: settle() releases the start's claim and closes its tail on the ready
// path — without it the sweep would never rotate a running app's log.
test('a ready app\'s log grows past the cap and the sweep rotates it', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const start = fakeAppCmd('chatty', path.join(root, 'marker'));
  const dir = await mkProject(root, 'app', { start });
  const app = { id: 'rot', path: dir, manifest: { start, healthPath: null, readyWhen: null } };
  const rec = await runner.start(app, await allocatePort());
  t.after(() => runner.stop({ id: 'rot', pgid: rec.pgid }));
  await waitFor(() => runner.runtime('rot')?.status === 'ready');
  const file = appLog.logFile('rot');
  await waitFor(() => readFileSync(file, 'utf8').length > 100);
  appLog.sweep({ running: ['rot'], capBytes: 100 });
  assert.equal(readFileSync(file + '.1', 'utf8').length, 100);
});

// Pins: a crashed start also releases its claim (the exit/settle path), so its
// log is swept — and stays inspectable until then.
test('a crashed start\'s log is no longer claimed and is rotated by the sweep', { skip: process.platform !== 'linux' && '/proc/self/fd is Linux-only' }, async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const start = fakeAppCmd('crash');
  const dir = await mkProject(root, 'app', { start });
  const app = { id: 'crashlog', path: dir, manifest: { start, healthPath: null, readyWhen: null } };
  await runner.start(app, await allocatePort());
  await waitFor(() => runner.runtime('crashlog')?.status === 'crashed');
  appLog.sweep({ running: [], capBytes: 10 });
  assert.match(readFileSync(appLog.logFile('crashlog') + '.1', 'utf8'), /^not start\n$/);
  assert.deepEqual(openFdsOf(appLog.logFile('crashlog')), []);
});

// Pins: while a start is in progress its log is claimed — a sweep far past
// retention, with the id not yet in the running set, leaves it alone — and the
// parent closes its write fd after spawn (no fd of this process can write the
// log; once settled, none refers to it at all).
test('a starting app\'s log is protected, and the parent holds no write fd to it', { skip: process.platform !== 'linux' && '/proc/self/fd is Linux-only' }, async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const marker = path.join(root, 'gate');
  const start = fakeAppCmd('gated', marker);
  const dir = await mkProject(root, 'app', { start });
  const app = { id: 'gate', path: dir, manifest: { start, healthPath: null, readyWhen: null } };
  const rec = await runner.start(app, await allocatePort());
  t.after(() => runner.stop({ id: 'gate', pgid: rec.pgid }));
  assert.equal(runner.runtime('gate').status, 'starting');
  const file = appLog.logFile('gate');

  appLog.sweep({ running: [], now: Date.now() + 2 * appLog.LOG_RETENTION_MS });
  assert.equal(existsSync(file), true);

  assert.deepEqual(openFdsOf(file, { writable: true }), []);

  writeFileSync(marker, 'go');
  await waitFor(() => runner.runtime('gate')?.status === 'ready');
  assert.deepEqual(openFdsOf(file), []);
});

const sweepable = (file) => { // true once the file's claim is gone: an over-cap sweep empties it
  appLog.sweep({ running: [], capBytes: 1 });
  return statSync(file).size === 0;
};

// Pins: a spawn that throws synchronously (invalid cwd type) still releases
// the claim and closes the tail — nothing leaks and the log is sweepable.
test('a synchronous spawn failure rejects start and releases the log claim and fds', { skip: process.platform !== 'linux' && '/proc/self/fd is Linux-only' }, async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const app = { id: 'syncfail', path: 123, manifest: { start: 'true', healthPath: null, readyWhen: null } };
  await assert.rejects(async () => runner.start(app, await allocatePort()), { code: 'ERR_INVALID_ARG_TYPE' });
  const file = appLog.logFile('syncfail');
  writeFileSync(file, 'junk');
  assert.deepEqual(openFdsOf(file), []);
  assert.equal(sweepable(file), true);
});

// Pins: an asynchronous spawn failure (ENOENT cwd, via proc 'error') settles
// crashed and releases the claim and tail.
test('an asynchronous spawn failure settles crashed and releases the log claim and fds', { skip: process.platform !== 'linux' && '/proc/self/fd is Linux-only' }, async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const app = { id: 'asyncfail', path: '/no/such/dir', manifest: { start: 'true', healthPath: null, readyWhen: null } };
  const rec = await runner.start(app, await allocatePort());
  assert.equal(await rec.settled, 'crashed');
  const file = appLog.logFile('asyncfail');
  writeFileSync(file, 'junk');
  assert.deepEqual(openFdsOf(file), []);
  assert.equal(sweepable(file), true);
});

// Pins: readiness setup that throws synchronously (an invalid readyWhen handed
// straight to the runner) still settles crashed and releases claim and tail.
test('a synchronous detectReady throw settles crashed and releases the log claim and fds', { skip: process.platform !== 'linux' && '/proc/self/fd is Linux-only' }, async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const start = fakeAppCmd();
  const dir = await mkProject(root, 'app', { start });
  const app = { id: 'badre', path: dir, manifest: { start, healthPath: null, readyWhen: '(' } };
  const rec = await runner.start(app, await allocatePort());
  t.after(() => runner.stop({ id: 'badre', pgid: rec.pgid }));
  assert.equal(await rec.settled, 'crashed');
  assert.match(runner.runtime('badre').error, /./);
  const file = appLog.logFile('badre');
  await waitFor(() => readFileSync(file, 'utf8').includes('listening'));
  assert.deepEqual(openFdsOf(file), []);
  assert.equal(sweepable(file), true);
});

// Pins: readiness failing asynchronously (the readyWhen match deadline rejects
// the readiness promise — the same settle handler a readiness timeout uses)
// closes the tail fd and releases the claim.
test('a readiness failure settles crashed and releases the log claim and fds', { skip: process.platform !== 'linux' && '/proc/self/fd is Linux-only' }, async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const start = fakeAppCmd('backtrack');
  const dir = await mkProject(root, 'app', { start });
  const app = { id: 'rdyfail', path: dir, manifest: { start, healthPath: null, readyWhen: '(a|a)+$' } };
  const rec = await runner.start(app, await allocatePort());
  t.after(() => runner.stop({ id: 'rdyfail', pgid: rec.pgid }));
  assert.equal(await rec.settled, 'crashed');
  assert.match(runner.runtime('rdyfail').error, /deadline/);
  const file = appLog.logFile('rdyfail');
  assert.deepEqual(openFdsOf(file), []);
  assert.equal(sweepable(file), true);
});

// Pins: openFdsOf finds a writable fd on a known file, so narrowing the helper
// (or breaking its flags parse) fails here instead of silently passing the fd tests.
test('openFdsOf reports a writable fd on an open file', { skip: process.platform !== 'linux' && '/proc/self/fd is Linux-only' }, async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const file = path.join(root, 'probe');
  const fd = openSync(file, 'w');
  try {
    assert.deepEqual(openFdsOf(file, { writable: true }), [String(fd)]);
    assert.deepEqual(openFdsOf(file), [String(fd)]);
  } finally {
    closeSync(fd);
  }
  assert.deepEqual(openFdsOf(file), []);
});
