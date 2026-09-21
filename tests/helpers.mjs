import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WORKTREES_DIRNAME } from '../src/projects.js';
import * as conductorProjects from '../src/conductorProjects.js';

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
// the real binary on every poll and `tailscaleAvailable` becomes host-dependent.
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
