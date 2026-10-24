import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WORKTREES_DIRNAME, storeRoot } from '../src/projects.js';
import * as conductorProjects from '../src/conductorProjects.js';
import * as appSettings from '../src/appSettings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');

// `marker` is only used by FAKE_APP_MODE=flaky, which fails once with
// EADDRINUSE and then succeeds — the marker file is what makes "first run vs
// later run" deterministic instead of timing-dependent.
export const fakeAppCmd = (mode, marker) =>
  `${mode ? `FAKE_APP_MODE=${mode} ` : ''}${marker ? `FAKE_APP_MARKER=${JSON.stringify(marker)} ` : ''}node ${JSON.stringify(path.join(FIXTURES, 'fake-app.mjs'))}`;

export const fakeCloudflaredBin = path.join(FIXTURES, 'fake-cloudflared.mjs');

// Tailscale is genuinely installed and Running on some dev machines, so every
// test that boots the server must inject this — otherwise list() shells out to
// the real binary on every listing and `tailscaleAvailable` becomes host-dependent.
export const fakeTailscaleBin = path.join(FIXTURES, 'fake-tailscale.mjs');

// A detached stand-in for an orphaned tailscale funnel. Deliberately the REAL
// fixture rather than a `sleep`: appManager verifies a persisted pid really is
// a funnel before signalling it (pids can be recycled across a reboot), so a
// generic process would — correctly — not be killed.
export function spawnFakeFunnel(port = 39999, env = {}) {
  return spawn(fakeTailscaleBin, ['funnel', '--bg=false', '--yes', `http://localhost:${port}`],
    { detached: true, stdio: 'ignore', env: { ...process.env, ...env } });
}

// Parse a FAKE_TAILSCALE_ARGV_LOG: one JSON line per event,
// `{ t, pid, event: 'invoke'|'exit', argv }`.
export async function tailscaleEvents(logPath) {
  const raw = await fs.readFile(logPath, 'utf8').catch(() => '');
  return raw.trim() ? raw.trim().split('\n').map((l) => JSON.parse(l)) : [];
}

export const funnelEvents = (events, event) =>
  events.filter((e) => e.event === event && e.argv?.[0] === 'funnel');

// A loopback alias used as a "third address" in bind tests: distinct from
// 127.0.0.1, still covered by a 0.0.0.0 wildcard bind, and purely local (it
// never touches a real interface, so tests using it stay host-independent —
// they work on a box with no LAN at all). Not bindable on every OS, so callers
// guard with altLoopbackBindable().
export const ALT_LOOPBACK = '127.0.0.2';

export function altLoopbackBindable() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.on('error', () => resolve(false));
    s.listen(0, ALT_LOOPBACK, () => s.close(() => resolve(true)));
  });
}

// Fresh temp projects root; sets PROJECTS_ROOT so all modules resolve to it.
export async function mkRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codehub-test-'));
  process.env.PROJECTS_ROOT = root;
  return root;
}

export async function rmRoot(root) {
  await fs.rm(root, { recursive: true, force: true });
}

// Create a servable project dir under root with a `.hub.json`. If `git` is
// true, init a repo with one commit so HEAD/sha logic has something to read.
export async function mkProject(root, name, manifest, { git = false } = {}) {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  if (manifest) await fs.writeFile(path.join(dir, '.hub.json'), JSON.stringify(manifest, null, 2));
  if (git) {
    const g = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' });
    g('init', '-q');
    g('config', 'user.email', 'test@example.com');
    g('config', 'user.name', 'test');
    await fs.writeFile(path.join(dir, 'README'), 'v1');
    g('add', '-A');
    g('commit', '-q', '-m', 'init');
  }
  return dir;
}

// Create a worktree checkout at the layout code-conductor produces:
// <root>/.worktrees/<project>/<key>. Same manifest/git options as mkProject.
export const mkWorktree = (root, project, key, manifest, opts) =>
  mkProject(root, path.join(WORKTREES_DIRNAME, project, key), manifest, opts);

// Write <root>/.code-hub/registrations.json directly, bypassing appManager,
// so tests can set up registry state (including deliberately malformed raw
// content) without going through registerApp.
export async function writeRegistrations(root, contents) {
  const dir = path.join(root, '.code-hub');
  await fs.mkdir(dir, { recursive: true });
  const raw = typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2);
  await fs.writeFile(path.join(dir, 'registrations.json'), raw);
}

// Put code-hub in the embedded state and land one canned `/api/projects`
// answer in the conductor overlay, without a socket: `rows` is the array the
// conductor would serve, or null for an unreachable conductor. Pair with
// resetConductorOverlay() in `t.after` — the overlay's cache and the env vars
// are module/process state that outlives a single test.
export async function useConductorOverlay(rows) {
  process.env.CONDUCTOR_PLUGIN_ID = 'code-hub';
  process.env.CONDUCTOR_URL = 'http://127.0.0.1:1';
  conductorProjects._setFetchImpl(async () => {
    if (rows === null) throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' });
    return { ok: true, status: 200, json: async () => rows };
  });
  await conductorProjects.refresh();
}

export function resetConductorOverlay() {
  conductorProjects._reset();
  delete process.env.CONDUCTOR_PLUGIN_ID;
  delete process.env.CONDUCTOR_URL;
}

// A `ProjectInfo` row as the conductor serves it, with the fields the overlay
// reads. Extra fields it carries (workspace, sessions, git facts) are ignored.
export const ccProject = (name, dir, extra = {}) => ({
  name, path: dir, workspace: null, system: 'local', remoteId: null, ...extra,
});

export function gitCommit(dir, msg = 'change') {
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' });
  execFileSync('sh', ['-c', `echo x >> ${JSON.stringify(path.join(dir, 'README'))}`]);
  g('add', '-A');
  g('commit', '-q', '-m', msg);
  return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD']).toString().trim();
}

// Poll a (possibly async) predicate until truthy or timeout.
export async function waitFor(pred, { timeout = 8000, interval = 50 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await pred()) return;
    if (Date.now() >= deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, interval));
  }
}

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Hold the next read of app-settings.json — the first await of a share — until
// released, and record every server that starts listening from then on.
export function holdShareAtSettingsRead(t) {
  const file = appSettings.appSettingsFile();
  const realRead = fs.readFile;
  const realListen = net.Server.prototype.listen;
  let release, reached, armed = true;
  const gate = new Promise((r) => { release = r; });
  const parked = new Promise((r) => { reached = r; });
  const servers = [];
  fs.readFile = async (p, ...rest) => {
    if (armed && p === file) { armed = false; reached(); await gate; }
    return realRead.call(fs, p, ...rest);
  };
  net.Server.prototype.listen = function (...args) { servers.push(this); return realListen.apply(this, args); };
  t.after(() => { release(); fs.readFile = realRead; net.Server.prototype.listen = realListen; });
  return { parked, release, listening: () => servers.filter((srv) => srv.listening) };
}

// --- host relay (relay/relay.py) ---------------------------------------------

export const REPO_ROOT = path.resolve(__dirname, '..');

// The Python interpreter the relay tests spawn: CODEHUB_PYTHON (a command line,
// e.g. `py -3`), else `python3` (`py -3` on win32). Resolves
// { ok: true, cmd, args } for one ≥3.9, else { ok: false, reason }. Cached.
let pythonCache = null;
export function findPython() {
  if (pythonCache) return pythonCache;
  const spec = process.env.CODEHUB_PYTHON || (process.platform === 'win32' ? 'py -3' : 'python3');
  const [cmd, ...args] = spec.split(/\s+/).filter(Boolean);
  try {
    const out = execFileSync(cmd, [...args, '-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const [major, minor] = out.split('.').map(Number);
    pythonCache = major > 3 || (major === 3 && minor >= 9)
      ? { ok: true, cmd, args, version: out }
      : { ok: false, reason: `${spec} is Python ${out}` };
  } catch (e) {
    pythonCache = { ok: false, reason: `${spec} could not run (${e.code ?? e.message})` };
  }
  return pythonCache;
}

const PYTHON_MISSING = 'python3 ≥3.9 not found — install it, point CODEHUB_PYTHON at it, or set CODEHUB_SKIP_PYTHON=1 to skip';

// Gate for a Python-dependent test, called first thing in its body. Fails
// closed: with no usable interpreter the test FAILS, unless CODEHUB_SKIP_PYTHON=1
// opts out explicitly, which skips it. Returns true when the test may proceed.
export function requirePython(t) {
  const py = findPython();
  if (py.ok) return true;
  if (process.env.CODEHUB_SKIP_PYTHON === '1') { t.skip(`${PYTHON_MISSING} (${py.reason})`); return false; }
  throw new Error(`${PYTHON_MISSING} (${py.reason})`);
}

// Relay processes a test may leave behind when it fails before stopping one:
// each is unref'd once listening (so it can't keep the test file alive) and
// SIGKILLed when the file's process exits.
const RELAY_START_TIMEOUT_MS = 10000;
const RELAY_RUN_TIMEOUT_MS = 10000;
const liveRelays = new Set();
function trackRelay(proc) {
  if (liveRelays.size === 0 && !trackRelay.hooked) {
    trackRelay.hooked = true;
    process.once('exit', () => { for (const p of liveRelays) { try { p.kill('SIGKILL'); } catch { /* gone */ } } });
  }
  liveRelays.add(proc);
  proc.once('exit', () => liveRelays.delete(proc));
}

// Spawn the real relay on loopback. The relay probes the default route at
// startup in every run (its listen guard compares against the answer);
// `advertise` null also makes that answer the advertised address, and
// CODEHUB_RELAY_PROBE_DEST (via `env`) is the seam that forces it. `relayDir`
// points at a (patched) copy of relay/. Resolves once its listening line is
// printed: { url, secret, secretFile, port, proc, output(), exited, stop() }.
// Rejects with the relay's stderr if it exits first, or kills it and rejects
// if it neither listens nor exits within RELAY_START_TIMEOUT_MS.
export async function startRelay({
  listenPort = 0, advertise = '127.0.0.1', leaseMs = 300, secretFile, acceptWaitMs,
  relayDir = path.join(REPO_ROOT, 'relay'), env = {}, extraArgs = [],
} = {}) {
  const py = findPython();
  if (!py.ok) throw new Error(`${PYTHON_MISSING} (${py.reason})`);
  let ownDir = null;
  if (!secretFile) {
    ownDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codehub-relay-'));
    secretFile = path.join(ownDir, 'secret');
  }
  const argv = [...py.args, path.join(relayDir, 'relay.py'), '--listen', `127.0.0.1:${listenPort}`,
    '--secret-file', secretFile, '--lease-ms', String(leaseMs)];
  if (advertise !== null) argv.push('--advertise', advertise);
  if (acceptWaitMs !== undefined) argv.push('--accept-wait-ms', String(acceptWaitMs));
  argv.push(...extraArgs);
  const proc = spawn(py.cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', ...env } });
  trackRelay(proc);
  let stdout = '', stderr = '';
  proc.stdout.on('data', (d) => { stdout += d; });
  proc.stderr.on('data', (d) => { stderr += d; });
  const exitedPromise = new Promise((r) => { if (proc.exitCode !== null) r(); else proc.once('exit', r); });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`relay neither listened nor exited within ${RELAY_START_TIMEOUT_MS}ms: ${stderr.trim()}`));
    }, RELAY_START_TIMEOUT_MS);
    const onData = () => {
      const m = /code-hub-relay listening on [\d.]+:(\d+)/.exec(stdout);
      if (m) { clearTimeout(timer); proc.stdout.off('data', onData); proc.off('exit', onExit); resolve(Number(m[1])); }
    };
    const onExit = (code) => { clearTimeout(timer); reject(Object.assign(new Error(`relay exited (code ${code}) before listening: ${stderr.trim()}`), { code, stderr })); };
    proc.stdout.on('data', onData);
    proc.once('exit', onExit);
  });
  // From here on the relay can't keep the test file alive; waiting on its exit refs it again.
  proc.unref(); proc.stdout.unref(); proc.stderr.unref();
  const secret = (await fs.readFile(secretFile, 'utf8')).trim();
  return {
    url: `http://127.0.0.1:${port}`, port, secret, secretFile, proc,
    output: () => ({ stdout, stderr }),
    get exited() { proc.ref(); return exitedPromise; },
    async stop(signal = 'SIGKILL') {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill(signal);
      proc.ref();
      await exitedPromise;
      if (ownDir) await fs.rm(ownDir, { recursive: true, force: true });
    },
  };
}

// Run a relay process to completion (for startup refusals): { code, stdout,
// stderr }. One still running after RELAY_RUN_TIMEOUT_MS — it was expected to
// refuse, and started instead — is killed and the call rejects, so a failing
// test can't wedge the run.
export async function runRelay(args, { env = {}, relayDir = path.join(REPO_ROOT, 'relay') } = {}) {
  const py = findPython();
  if (!py.ok) throw new Error(`${PYTHON_MISSING} (${py.reason})`);
  const proc = spawn(py.cmd, [...py.args, path.join(relayDir, 'relay.py'), ...args],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', ...env } });
  trackRelay(proc);
  let stdout = '', stderr = '';
  proc.stdout.on('data', (d) => { stdout += d; });
  proc.stderr.on('data', (d) => { stderr += d; });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill('SIGKILL'); }, RELAY_RUN_TIMEOUT_MS);
  const code = await new Promise((r) => proc.once('exit', (c) => r(c)));
  clearTimeout(timer);
  if (timedOut) throw new Error(`relay still running after ${RELAY_RUN_TIMEOUT_MS}ms (expected it to exit); stdout: ${stdout.trim()} stderr: ${stderr.trim()}`);
  return { code, stdout, stderr };
}

// Point code-hub at `relay` for the rest of test `t` (CODEHUB_RELAY_URL/SECRET).
export function withRelayEnv(t, relay) {
  const prev = { url: process.env.CODEHUB_RELAY_URL, secret: process.env.CODEHUB_RELAY_SECRET };
  process.env.CODEHUB_RELAY_URL = relay.url;
  process.env.CODEHUB_RELAY_SECRET = relay.secret;
  t.after(() => {
    for (const [k, v] of [['CODEHUB_RELAY_URL', prev.url], ['CODEHUB_RELAY_SECRET', prev.secret]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
}

// A raw control call against a relay: { status, body }.
export async function relayCall(relay, method, path_, body, { secret = relay.secret } = {}) {
  const res = await fetch(relay.url + path_, {
    method,
    headers: { ...(secret ? { Authorization: `Bearer ${secret}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, body: parsed };
}

// Resolves true when a TCP connect to host:port succeeds, false when refused.
export function canConnect(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = net.connect(port, host);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

// Hold the next write of state.json's tmp file — the persist() that follows a
// share's commit — until released. `parked` resolves when the write is held;
// `stateRead` resolves once a read of state.json (init's load) has COMPLETED
// after that, so a test can release the write knowing the load saw the old file.
export function holdStateWrite(t) {
  const realWrite = fs.writeFile;
  const realRead = fs.readFile;
  let release, reached, readDone, armed = true, held = false;
  const gate = new Promise((r) => { release = r; });
  const parked = new Promise((r) => { reached = r; });
  const stateRead = new Promise((r) => { readDone = r; });
  fs.writeFile = async (p, ...rest) => {
    if (armed && typeof p === 'string' && path.dirname(p) === storeRoot() && p.endsWith('.tmp')) {
      armed = false; held = true; reached(); await gate;
    }
    return realWrite.call(fs, p, ...rest);
  };
  fs.readFile = async (p, ...rest) => {
    const out = await realRead.call(fs, p, ...rest);
    if (held && p === path.join(storeRoot(), 'state.json')) readDone();
    return out;
  };
  t.after(() => { release(); fs.writeFile = realWrite; fs.readFile = realRead; });
  return { parked, stateRead, release };
}
