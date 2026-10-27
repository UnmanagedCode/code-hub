import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs, closeSync, readFileSync, writeFileSync, existsSync, statSync, appendFileSync, mkdirSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import * as appLog from '../src/appLog.js';
import * as appManager from '../src/appManager.js';
import { storeRoot } from '../src/projects.js';
import { mkRoot, rmRoot, mkProject, waitFor, pidAlive, fakeAppCmd } from './helpers.mjs';

const mkLogsDir = (id) => fs.mkdir(path.dirname(appLog.logFile(id)), { recursive: true });
// Sync write into the logs dir (created on demand).
function writeLog(id, content, suffix = '') {
  const f = appLog.logFile(id) + suffix;
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, content);
  return f;
}

// Pins: copy-truncate really frees the disk under a live O_APPEND writer (the
// next write lands at offset 0, not a sparse hole at the old offset), and one
// rotated generation keeps the old content.
test('rotation by the sweep truncates a live O_APPEND writer\'s file to the start', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const cap = 8 * 1024;
  const { fd, file, release } = appLog.openForChild('rot');
  const line = 'x'.repeat(1023) + '\n';
  const proc = spawn(process.execPath, ['-e',
    `setInterval(() => process.stdout.write(${JSON.stringify(line)}), 10)`], { stdio: ['ignore', fd, fd] });
  closeSync(fd);
  release(); // the start has settled
  t.after(() => proc.kill('SIGKILL'));

  await waitFor(() => statSync(file).size > cap);
  appLog.sweep({ running: ['rot'], capBytes: cap });
  const rotated = readFileSync(file + '.1', 'utf8');
  assert.equal(rotated.length, cap); // only the last capBytes are kept
  assert.match(rotated, /^x*\n(x{1023}\n)+$/);

  await waitFor(() => statSync(file).size > 0);
  const now = readFileSync(file, 'utf8');
  assert.ok(now.length < cap, `live log should restart small, was ${now.length}`);
  assert.match(now, /^(x{1023}\n)+$/);
});

// Pins: every start begins a fresh log — no leftovers of the previous run.
test('a start truncates the log and drops .log.1', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkLogsDir('s');
  const f = writeLog('s', 'old run output');
  writeLog('s', 'older', '.1');
  const { fd } = appLog.openForChild('s');
  closeSync(fd);
  assert.equal(readFileSync(f, 'utf8'), '');
  assert.equal(existsSync(f + '.1'), false);
});

// Pins: a running app's log is never deleted however quiet it is; stale logs
// of non-running ids go, both generations; fresh ones stay.
test('retention deletes only stale logs of non-running ids', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkLogsDir('x');
  const now = Date.now();
  const old = new Date(now - appLog.LOG_RETENTION_MS - 60_000);
  const files = {};
  for (const id of ['stale', 'staleRunning', 'fresh']) {
    files[id] = writeLog(id, 'a');
    writeLog(id, 'b', '.1');
  }
  await Promise.all(['stale', 'staleRunning'].flatMap((id) => [
    fs.utimes(files[id], old, old), fs.utimes(files[id] + '.1', old, old)]));
  appLog.sweep({ running: ['staleRunning'], now });
  assert.equal(existsSync(files.stale), false);
  assert.equal(existsSync(files.stale + '.1'), false);
  assert.equal(existsSync(files.staleRunning), true);
  assert.equal(existsSync(files.staleRunning + '.1'), true);
  assert.equal(existsSync(files.fresh), true);
});

// Pins: a file claimed by a start (from openForChild until release) is never
// rotated or deleted by the sweep — however oversized or stale, and even when
// its id isn't in the running set yet — and is swept normally once released.
// This is what keeps a fresh start's output (a readyWhen marker) from being
// wiped, and a just-opened live log from being unlinked.
test('the sweep skips a claimed file for rotation and for retention, until released', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const { fd, file, release } = appLog.openForChild('c');
  closeSync(fd);
  writeFileSync(file, 'y'.repeat(4096));
  writeFileSync(file + '.1', 'older');
  const old = new Date(Date.now() - appLog.LOG_RETENTION_MS - 60_000);
  await fs.utimes(file, old, old);

  appLog.sweep({ running: [], capBytes: 1024 });
  assert.equal(statSync(file).size, 4096);
  assert.equal(readFileSync(file + '.1', 'utf8'), 'older');

  release();
  release(); // idempotent: a second release can't free another start's claim
  appLog.sweep({ running: [], capBytes: 1024 });
  assert.equal(existsSync(file), false);
  assert.equal(existsSync(file + '.1'), false);
});

// Pins: a claim's release is idempotent per claim — releasing the FIRST of two
// claims twice must not drop the second's claim (a shared counter would).
test('a double release of one claim does not free another start\'s claim', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const first = appLog.openForChild('dr'); closeSync(first.fd);
  const second = appLog.openForChild('dr'); closeSync(second.fd);
  writeFileSync(second.file, 'y'.repeat(4096));
  first.release();
  first.release();
  appLog.sweep({ running: [], capBytes: 1024 });
  assert.equal(statSync(second.file).size, 4096);
  second.release();
});

// Pins: claims are counted per start — releasing one of two overlapping starts
// of the same id leaves the file protected.
test('overlapping claims of one file keep it protected until the last release', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const first = appLog.openForChild('o'); closeSync(first.fd);
  const second = appLog.openForChild('o'); closeSync(second.fd);
  writeFileSync(second.file, 'y'.repeat(4096));
  first.release();
  appLog.sweep({ running: [], capBytes: 1024 });
  assert.equal(statSync(second.file).size, 4096);
  second.release();
  appLog.sweep({ running: [], capBytes: 1024 });
  assert.equal(statSync(second.file).size, 0);
});

// Pins: a stale orphan `.log.1` (no `.log` beside it) is removed only when its
// id is neither running nor claimed, and only once past retention.
test('an orphan .log.1 is deleted when stale and not live, and kept when live, claimed or fresh', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const now = Date.now();
  const old = new Date(now - appLog.LOG_RETENTION_MS - 60_000);
  const mk = async (id, when) => {
    const f = writeLog(id, 'x', '.1');
    await fs.utimes(f, when, when);
    return f;
  };
  const gone = await mk('gone', old);
  const live = await mk('live', old);
  const fresh = await mk('fresh', new Date(now));
  const c = appLog.openForChild('claimed'); // removes any .1, so claim first
  closeSync(c.fd);
  await fs.rm(c.file);
  const claimed = await mk('claimed', old);

  appLog.sweep({ running: ['live'], now });
  assert.equal(existsSync(gone), false);
  assert.equal(existsSync(live), true);
  assert.equal(existsSync(fresh), true);
  assert.equal(existsSync(claimed), true);
  c.release();
});

// Pins: the log file is 0600 and its directory 0700 (output can hold secrets).
test('the log file is created 0600 inside a 0700 directory', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const { fd, file, release } = appLog.openForChild('m');
  closeSync(fd);
  release();
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);
});

// Pins: startSweep ticks periodically (a later tick rotates a log that grew
// after the initial pass) and is idempotent — a second call replaces the first
// interval instead of leaking it.
test('startSweep rotates on a later tick and a second call replaces the first interval', async (t) => {
  const root = await mkRoot();
  t.after(() => { appLog.stopSweep(); return rmRoot(root); });
  let a = 0; let b = 0;
  appLog.startSweep(() => { a += 1; return ['g']; }, { intervalMs: 10, capBytes: 100 });
  appLog.startSweep(() => { b += 1; return ['g']; }, { intervalMs: 10, capBytes: 100 });
  const file = writeLog('g', 'z'.repeat(500));
  await waitFor(() => existsSync(file + '.1'));
  assert.equal(readFileSync(file + '.1', 'utf8'), 'z'.repeat(100));
  assert.equal(statSync(file).size, 0);
  await waitFor(() => b >= 3);
  assert.equal(a, 1, 'the replaced interval must not keep ticking');
});

// Pins: a per-tick read never exceeds the cap (so readyWhen's scanned surface
// isn't widened), reports what it skipped, and doesn't corrupt multi-byte text.
test('a tail read is bounded and decodes multi-byte chars across reads', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkLogsDir('b');
  const f = writeLog('b', '');
  const cap = 100;
  const tl = appLog.tail(f, cap);
  t.after(() => tl.close());
  appendFileSync(f, 'a'.repeat(2 * cap) + 'b'.repeat(cap));
  const r = tl.read();
  assert.equal(r.text, 'b'.repeat(cap));
  assert.equal(r.skipped, 2 * cap);
  assert.deepEqual(tl.read(), { text: '', skipped: 0 });

  const euro = Buffer.from('€');
  appendFileSync(f, euro.subarray(0, 2));
  const first = tl.read().text;
  appendFileSync(f, euro.subarray(2));
  assert.equal(first + tl.read().text, '€');
});

// Pins: when a read skips ahead, the decoder drops a pending partial character
// from before the skip instead of emitting U+FFFD into the new text.
test('a skip discards a pending partial multi-byte char (no U+FFFD)', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkLogsDir('d');
  const f = writeLog('d', '');
  const tl = appLog.tail(f, 100);
  t.after(() => tl.close());
  appendFileSync(f, Buffer.from('€').subarray(0, 2));
  assert.equal(tl.read().text, '');
  appendFileSync(f, 'a'.repeat(300));
  const r = tl.read();
  assert.equal(r.text, 'a'.repeat(100));
  assert.equal(r.skipped, 200);
});

// Pins: the id → filename mapping is injective and confined to the logs dir.
test('logFile maps every id to one component inside the logs dir', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const dir = path.join(storeRoot(), appLog.LOGS_DIRNAME);
  const files = ['a:b', 'a/b', 'a%3Ab', '../x'].map(appLog.logFile);
  assert.equal(new Set(files).size, files.length);
  for (const f of files) assert.equal(path.dirname(f), dir);
});

// Pins: init wires the sweep — a log grown over the cap while no hub ran is
// rotated, a stale log of an absent id is removed, the adopted app survives.
test('appManager.init sweeps once at boot', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const dir = await mkProject(root, 'adopted', { start: fakeAppCmd() });
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e9)'], { detached: true, stdio: 'ignore' });
  t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } });
  await fs.mkdir(storeRoot(), { recursive: true });
  await fs.writeFile(path.join(storeRoot(), 'state.json'), JSON.stringify({ apps: {
    adopted: { id: 'adopted', project: 'adopted', path: dir, isWorktree: false, branch: null,
      pid: child.pid, pgid: child.pid, port: 1, startedSha: null, startedAt: null, tunnel: null },
  } }));
  await mkLogsDir('adopted');
  const big = writeLog('adopted', 'z'.repeat(appLog.LOG_CAP_BYTES + 1));
  const stale = writeLog('gone', 'old');
  const old = new Date(Date.now() - appLog.LOG_RETENTION_MS - 60_000);
  await fs.utimes(stale, old, old);

  await appManager.init();

  assert.equal(statSync(big).size, 0);
  assert.equal(statSync(big + '.1').size, appLog.LOG_CAP_BYTES);
  assert.equal(existsSync(stale), false);
  assert.equal(pidAlive(child.pid), true);
});

// Pins: rotation keeps only the LAST capBytes in .log.1 (bounded copy; older
// backlog is dropped) and truncates the live file.
test('rotation keeps only the last capBytes of an oversized log', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const cap = 100;
  const content = Array.from({ length: 50 }, (_, i) => String(i).padStart(9, '0') + '\n').join('');
  const file = writeLog('big', content);
  appLog.sweep({ running: ['big'], capBytes: cap });
  assert.equal(statSync(file).size, 0);
  const kept = readFileSync(file + '.1', 'utf8');
  assert.equal(kept.length, cap);
  assert.equal(kept, content.slice(-cap));
});

// Pins: a failing openForChild (its .log.1 reset throws) releases its claim, so
// the file is sweepable afterwards.
test('openForChild failing releases its claim', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const file = appLog.logFile('fail');
  mkdirSync(file + '.1', { recursive: true });
  assert.throws(() => appLog.openForChild('fail'), /cannot reset/);
  rmSync(file + '.1', { recursive: true });
  writeFileSync(file, 'x');
  const old = new Date(Date.now() - appLog.LOG_RETENTION_MS - 60_000);
  await fs.utimes(file, old, old);
  appLog.sweep({ running: [] });
  assert.equal(existsSync(file), false);
});
