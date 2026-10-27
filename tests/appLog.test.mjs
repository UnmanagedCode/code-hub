import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs, closeSync, readFileSync, writeFileSync, existsSync, statSync, appendFileSync, mkdirSync } from 'node:fs';
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
  const { fd, file } = appLog.openForChild('rot');
  const line = 'x'.repeat(1023) + '\n';
  const proc = spawn(process.execPath, ['-e',
    `setInterval(() => process.stdout.write(${JSON.stringify(line)}), 10)`], { stdio: ['ignore', fd, fd] });
  closeSync(fd);
  t.after(() => proc.kill('SIGKILL'));

  await waitFor(() => statSync(file).size > cap);
  await appLog.sweep({ running: ['rot'], capBytes: cap });
  const rotated = readFileSync(file + '.1', 'utf8');
  assert.ok(rotated.length > cap);
  assert.match(rotated, /^x{1023}\n/);

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
  await appLog.sweep({ running: ['staleRunning'], now });
  assert.equal(existsSync(files.stale), false);
  assert.equal(existsSync(files.stale + '.1'), false);
  assert.equal(existsSync(files.staleRunning), true);
  assert.equal(existsSync(files.staleRunning + '.1'), true);
  assert.equal(existsSync(files.fresh), true);
});

// Pins: readiness can't lose output to rotation while a tail is open.
test('the sweep never rotates a file being tailed', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkLogsDir('t');
  const f = writeLog('t', 'y'.repeat(4096));
  const tl = appLog.tail(f, 1024);
  await appLog.sweep({ running: ['t'], capBytes: 1024 });
  assert.equal(statSync(f).size, 4096);
  assert.equal(existsSync(f + '.1'), false);
  tl.close();
  tl.close(); // idempotent
  await appLog.sweep({ running: ['t'], capBytes: 1024 });
  assert.equal(statSync(f).size, 0);
  assert.equal(statSync(f + '.1').size, 4096);
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
  assert.equal(statSync(big + '.1').size, appLog.LOG_CAP_BYTES + 1);
  assert.equal(existsSync(stale), false);
  assert.equal(pidAlive(child.pid), true);
});
