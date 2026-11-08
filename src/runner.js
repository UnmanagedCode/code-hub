import { spawn } from 'node:child_process';
import { closeSync } from 'node:fs';
import http from 'node:http';
import { waitForPort, allocatePort } from './net.js';
import { createReadyMatcher } from './readyWhen.js';
import * as appLog from './appLog.js';

const GRACE_MS = 3000;       // SIGTERM → SIGKILL grace period
// How long a caller waits for a stopped group to be gone: stop() escalates to
// SIGKILL after GRACE_MS if any member is still alive, so this adds time for the
// kernel to deliver it and the group to be reaped.
const STOP_WAIT_MARGIN_MS = 1000;
export const STOP_WAIT_MS = GRACE_MS + STOP_WAIT_MARGIN_MS;
const GONE_POLL_MS = 20;
const READY_TIMEOUT_MS = 30000;
export const OUTPUT_CAP = 16 * 1024; // per-app crash-tail ring, fed from the log file; also caps each read
// Chars of a crashed app's output kept in `error` (the REST/UI crash message).
export const CRASH_TAIL_CHARS = 2000;
const EADDRINUSE_RETRIES = 3;
const SPAWN_SETTLE_MS = 400; // window to catch a fast EADDRINUSE crash before committing to this attempt's port

// In-memory runtime for children spawned by THIS code-hub process. Apps
// adopted after a restart have no entry here and are treated as already-ready
// by the app manager; their output is still in appLog.logFile(id).
const children = new Map(); // id → { proc, pgid, status, error, output, total, tail }

// Called with the app id whenever a child this process spawned exits, for any
// reason — a crash, the app stopping on its own, or a kill.
const exitListeners = new Set();
export function onExit(listener) {
  exitListeners.add(listener);
}

export function runtime(id) {
  const c = children.get(id);
  if (!c) return null;
  return { status: c.status, error: c.error, reason: c.reason, output: c.output, outputTruncated: c.total > c.output.length };
}

function appendOutput(c, chunk, skipped = 0) {
  c.output += chunk;
  c.total += chunk.length + skipped;
  if (c.output.length > OUTPUT_CAP) c.output = c.output.slice(-OUTPUT_CAP);
}

// Pull the bytes the app has written to its log since the last pump into the ring.
function pump(c) {
  const { text, skipped } = c.tail.read();
  appendOutput(c, text, skipped);
}

// The single exit from 'starting': resolves the child's `settled` promise
// with the status it settled to, whichever path (readiness, an early exit,
// a spawn error) got there first.
// `reason` is `error` without any output tail.
function settle(c, status, error = null, reason = error) {
  if (c.status !== 'starting') return;
  c.status = status;
  c.error = error;
  c.reason = reason;
  c.resolveSettled(status);
  try { c.tail.close(); } finally { c.release(); } // the sweep may rotate this log again
}

// Spawn the manifest's blocking start command in its OWN process group
// (detached ⇒ child is group leader ⇒ pgid === pid), with PORT injected.
function spawnChild(app, port) {
  // stdout and stderr share one O_APPEND fd, so they stay interleaved in write
  // order and no code-hub process is in the output path.
  const { fd, file, release } = appLog.openForChild(app.id);
  let proc, tail;
  try {
    tail = appLog.tail(file, OUTPUT_CAP);
    proc = spawn('bash', ['-lc', app.manifest.start], {
      cwd: app.path,
      env: { ...process.env, PORT: String(port) },
      detached: true,
      stdio: ['ignore', fd, fd],
    });
  } catch (e) {
    try { tail?.close(); } finally { release(); }
    throw e;
  } finally {
    closeSync(fd);
  }
  const c = { proc, pgid: proc.pid, status: 'starting', error: null, reason: null, output: '', total: 0, tail, release };
  c.settled = new Promise((resolve) => { c.resolveSettled = resolve; });

  proc.on('exit', (code, signal) => {
    // Exit before readiness = crash; after = the app stopped on its own.
    if (c.status === 'starting') {
      pump(c); // drain the log first so the tail (and raceSettle's EADDRINUSE check) sees the app's last output
      const reason = `start command exited (code=${code}, signal=${signal})`;
      settle(c, 'crashed', `${reason}\n${c.output.slice(-CRASH_TAIL_CHARS)}`, reason);
    } else if (c.status === 'ready') c.status = 'exited';
    for (const listener of exitListeners) {
      try { listener(app.id); } catch (e) { console.error(`[runner] exit listener failed: ${e.message}`); }
    }
  });
  proc.on('error', (e) => settle(c, 'crashed', e.message));

  return c;
}

// Resolve once the child settles (crashes) or `ms` elapses, whichever first.
// Only used to decide whether an early failure was an EADDRINUSE race worth
// retrying on a new port — full readiness detection (below) is unaffected.
function raceSettle(c, ms) {
  const deadline = Date.now() + ms;
  return new Promise((resolve) => {
    const tick = () => {
      if (c.status !== 'starting' || Date.now() >= deadline) return resolve();
      setTimeout(tick, 20);
    };
    tick();
  });
}

// Returns the record fields to persist, plus `settled` (never persisted): a
// promise of the status the child leaves 'starting' with — 'ready', or
// 'crashed' for an exit before readiness or an unconfirmed readiness.
// Readiness runs in the background and updates the in-memory runtime status.
// If the freshly spawned child dies almost immediately with EADDRINUSE — the free port `allocatePort()` handed
// out got claimed by something else before this bind — retry on a new port
// a bounded number of times before giving up.
//
// `fixed: true` means the caller pinned this port (a manifest `port`), so
// moving to a free one would silently defeat the whole point: the retry is
// skipped and the EADDRINUSE surfaces as a crash on the requested port, which
// appManager.start turns into a 409.
export async function start(app, port, { fixed = false } = {}) {
  for (let attempt = 1; ; attempt++) {
    const c = spawnChild(app, port);
    children.set(app.id, c);

    await raceSettle(c, SPAWN_SETTLE_MS);

    const isPortRace = c.status === 'crashed' && /EADDRINUSE/.test(c.error ?? '');
    if (isPortRace && fixed) {
      console.error(`[runner] ${app.id}: fixed port ${port} is already in use — not retrying on another port`);
    } else if (isPortRace && attempt <= EADDRINUSE_RETRIES) {
      console.error(`[runner] ${app.id}: port ${port} was claimed before bind (attempt ${attempt}/${EADDRINUSE_RETRIES}) — retrying on a new port`);
      port = await allocatePort();
      continue;
    }
    if (isPortRace && !fixed) {
      console.error(`[runner] ${app.id}: still hitting EADDRINUSE after ${EADDRINUSE_RETRIES} retries — giving up`);
    }

    if (c.status === 'starting') {
      try {
        detectReady(app, port, c).then(
          () => settle(c, 'ready'),
          (e) => settle(c, 'crashed', e.message),
        );
      } catch (e) {
        settle(c, 'crashed', e.message); // a synchronous throw (e.g. an invalid readyWhen) must still release the claim
      }
    }
    return { pid: c.proc.pid, pgid: c.proc.pid, port, startedAt: new Date().toISOString(), settled: c.settled };
  }
}

function detectReady(app, port, c) {
  const { readyWhen, healthPath } = app.manifest;
  if (readyWhen) {
    const m = createReadyMatcher(readyWhen);
    return poll(() => { pump(c); return m.scan(c.output, c.total); });
  }
  if (healthPath) {
    return poll(() => httpOk(port, healthPath));
  }
  return waitForPort(port, { timeoutMs: READY_TIMEOUT_MS });
}

// Poll a (possibly async) predicate until truthy or timeout.
function poll(pred, { timeoutMs = READY_TIMEOUT_MS, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      let ok;
      try { ok = await pred(); } catch (e) { return reject(e); }
      if (ok) return resolve();
      if (Date.now() >= deadline) return reject(new Error('readiness not confirmed within timeout'));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

function httpOk(port, path) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode != null); // any HTTP response = the server answered
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// Kill the process group: SIGTERM, then SIGKILL after a grace period if the
// leader is still alive. Works even when the source dir is gone, since we
// only need the pgid. Safe to call on an already-dead group.
export function stop({ id, pgid }) {
  children.delete(id);
  // A missing/zero pgid would make kill(-pgid) target this process's own group.
  if (!validPgid(pgid)) return;
  try { process.kill(-pgid, 'SIGTERM'); } catch { /* already gone */ }
  const t = setTimeout(() => {
    // Gate on the group, not the leader: a member can outlive an exited leader.
    // A live group is the same group the record named; that is not proof the
    // record's processes are the ones in it, only that the pgid is not free.
    try {
      if (groupAlive(pgid)) process.kill(-pgid, 'SIGKILL');
    } catch { /* gone, or not ours to signal */ }
  }, GRACE_MS);
  t.unref();
}

// True while any member of process group `pgid` exists (the leader alone is not
// enough: a wrapper can exit while its child keeps holding the port).
function validPgid(pgid) { return Number.isInteger(pgid) && pgid > 0; }

// A non-positive or missing pgid is never a group: kill(-0, 0) would probe this
// process's own group.
export function groupAlive(pgid) {
  if (!validPgid(pgid)) return false;
  try { process.kill(-pgid, 0); return true; } catch (e) {
    if (e.code === 'ESRCH') return false;
    if (e.code === 'EPERM') return true; // exists, not ours to signal
    throw e;
  }
}

// Resolves true once no member of the group is left, false if some still live
// after `timeoutMs`. It signals nothing — pair it with stop().
export async function waitGone(pgid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (groupAlive(pgid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, GONE_POLL_MS));
  }
  return true;
}
