import { spawn } from 'node:child_process';
import http from 'node:http';
import { waitForPort } from './net.js';
import { pidAlive } from './state.js';

const GRACE_MS = 3000;       // SIGTERM → SIGKILL grace period
const READY_TIMEOUT_MS = 30000;
const OUTPUT_CAP = 16 * 1024; // per-app crash-tail ring

// In-memory runtime for children spawned by THIS code-hub process. Apps
// adopted after a restart have no entry here (we can't recapture their
// stdout) and are treated as already-ready by the app manager.
const children = new Map(); // id → { proc, pgid, status, error, output }

export function runtime(id) {
  const c = children.get(id);
  if (!c) return null;
  return { status: c.status, error: c.error, output: c.output };
}

function appendOutput(c, chunk) {
  c.output += chunk;
  if (c.output.length > OUTPUT_CAP) c.output = c.output.slice(-OUTPUT_CAP);
}

// Spawn the manifest's blocking start command in its OWN process group
// (detached ⇒ child is group leader ⇒ pgid === pid), with PORT injected.
// Returns the record fields to persist; readiness runs in the background and
// updates the in-memory runtime status.
export function start(app, port) {
  const proc = spawn('bash', ['-lc', app.manifest.start], {
    cwd: app.path,
    env: { ...process.env, PORT: String(port) },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const c = { proc, pgid: proc.pid, status: 'starting', error: null, output: '' };
  children.set(app.id, c);

  const onData = (d) => appendOutput(c, d.toString());
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);

  let settled = false;
  const settle = (status, error = null) => {
    if (settled) return;
    settled = true;
    c.status = status;
    c.error = error;
  };

  proc.on('exit', (code, signal) => {
    // Exit before readiness = crash; after = the app stopped on its own.
    if (!settled) settle('crashed', `start command exited (code=${code}, signal=${signal})\n${c.output.slice(-2000)}`);
    else if (c.status === 'ready') c.status = 'exited';
  });
  proc.on('error', (e) => settle('crashed', e.message));

  detectReady(app, port, c).then(
    () => settle('ready'),
    (e) => { if (!settled) settle('crashed', e.message); },
  );

  return { pid: proc.pid, pgid: proc.pid, port, startedAt: new Date().toISOString() };
}

function detectReady(app, port, c) {
  const { readyWhen, healthPath } = app.manifest;
  if (readyWhen) {
    const re = new RegExp(readyWhen);
    return poll(() => re.test(c.output));
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
      let ok = false;
      try { ok = await pred(); } catch { ok = false; }
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
  try { process.kill(-pgid, 'SIGTERM'); } catch { /* already gone */ }
  const t = setTimeout(() => {
    if (pidAlive(pgid)) { try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ } }
  }, GRACE_MS);
  t.unref();
}
