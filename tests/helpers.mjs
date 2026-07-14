import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');

export const fakeAppCmd = (mode) =>
  `${mode ? `FAKE_APP_MODE=${mode} ` : ''}node ${JSON.stringify(path.join(FIXTURES, 'fake-app.mjs'))}`;

export const fakeCloudflaredBin = path.join(FIXTURES, 'fake-cloudflared.mjs');

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

// Write <root>/.code-hub/registrations.json directly, bypassing appManager,
// so tests can set up registry state (including deliberately malformed raw
// content) without going through registerApp.
export async function writeRegistrations(root, contents) {
  const dir = path.join(root, '.code-hub');
  await fs.mkdir(dir, { recursive: true });
  const raw = typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2);
  await fs.writeFile(path.join(dir, 'registrations.json'), raw);
}

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
