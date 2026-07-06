import { spawn } from 'node:child_process';
import http from 'node:http';
import { waitForPort, allocatePort } from './net.js';
import { pidAlive } from './state.js';

const GRACE_MS = 3000;       // SIGTERM → SIGKILL grace period
const READY_TIMEOUT_MS = 30000;
const OUTPUT_CAP = 16 * 1024; // per-app crash-tail ring
const EADDRINUSE_RETRIES = 3;
const SPAWN_SETTLE_MS = 400; // window to catch a fast EADDRINUSE crash before committing to this attempt's port

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

function settle(c, status, error = null) {
  if (c.status !== 'starting') return;
  c.status = status;
  c.error = error;
}

// Spawn the manifest's blocking start command in its OWN process group
// (detached ⇒ child is group leader ⇒ pgid === pid), with PORT injected.
function spawnChild(app, port) {
  const proc = spawn('bash', ['-lc', app.manifest.start], {
    cwd: app.path,
    env: { ...process.env, PORT: String(port) },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const c = { proc, pgid: proc.pid, status: 'starting', error: null, output: '' };

  const onData = (d) => appendOutput(c, d.toString());
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);

  proc.on('exit', (code, signal) => {
    // Exit before readiness = crash; after = the app stopped on its own.
    if (c.status === 'starting') settle(c, 'crashed', `start command exited (code=${code}, signal=${signal})\n${c.output.slice(-2000)}`);
    else if (c.status === 'ready') c.status = 'exited';
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

// Returns the record fields to persist; readiness runs in the background and
// updates the in-memory runtime status. If the freshly spawned child dies
// almost immediately with EADDRINUSE — the free port `allocatePort()` handed
// out got claimed by something else before this bind — retry on a new port
// a bounded number of times before giving up.
export async function start(app, port) {
  for (let attempt = 1; ; attempt++) {
    const c = spawnChild(app, port);
    children.set(app.id, c);

    await raceSettle(c, SPAWN_SETTLE_MS);

    const isPortRace = c.status === 'crashed' && /EADDRINUSE/.test(c.error ?? '');
    if (isPortRace && attempt <= EADDRINUSE_RETRIES) {
      console.error(`[runner] ${app.id}: port ${port} was claimed before bind (attempt ${attempt}/${EADDRINUSE_RETRIES}) — retrying on a new port`);
      port = await allocatePort();
      continue;
    }
    if (isPortRace) {
      console.error(`[runner] ${app.id}: still hitting EADDRINUSE after ${EADDRINUSE_RETRIES} retries — giving up`);
    }

    if (c.status === 'starting') {
      detectReady(app, port, c).then(
        () => settle(c, 'ready'),
        (e) => settle(c, 'crashed', e.message),
      );
    }
    return { pid: c.proc.pid, pgid: c.proc.pid, port, startedAt: new Date().toISOString() };
  }
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
