import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as state from '../src/state.js';
import { storeRoot } from '../src/projects.js';
import { mkRoot, rmRoot, waitFor } from './helpers.mjs';

function spawnLived() {
  const p = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1e9)'], { detached: true, stdio: 'ignore' });
  return p;
}

test('save + load round-trips', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await state.save({ apps: { a: { id: 'a', pid: 123 } } });
  const loaded = await state.load();
  assert.equal(loaded.apps.a.pid, 123);
});

test('reconcile drops dead pids and keeps live ones (even if source dir is gone)', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const live = spawnLived();
  t.after(() => { try { process.kill(-live.pid, 'SIGKILL'); } catch {} });

  const s = {
    apps: {
      gone: { id: 'gone', pid: live.pid, pgid: live.pid, path: path.join(root, 'deleted-dir') }, // dir intentionally absent
      dead: { id: 'dead', pid: 2 ** 30, pgid: 2 ** 30 },
    },
  };
  await state.reconcile(s);
  assert.ok(s.apps.gone, 'live pid retained regardless of missing source dir');
  assert.equal(s.apps.dead, undefined, 'dead pid pruned');
});

test('reconcile clears a tunnel whose pid is dead but keeps the app', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const live = spawnLived();
  t.after(() => { try { process.kill(-live.pid, 'SIGKILL'); } catch {} });

  const s = { apps: { a: { id: 'a', pid: live.pid, tunnel: { pid: 2 ** 30, url: 'https://x' } } } };
  await state.reconcile(s);
  assert.ok(s.apps.a);
  assert.equal(s.apps.a.tunnel, null);
});

test('corrupt state file is moved aside, not fatal', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await fs.mkdir(storeRoot(), { recursive: true });
  await fs.writeFile(path.join(storeRoot(), 'state.json'), '{ broken');
  const loaded = await state.load();
  assert.deepEqual(loaded, { apps: {} });
  await waitFor(async () => {
    const entries = await fs.readdir(storeRoot());
    return entries.some((n) => n.endsWith('.corrupt'));
  });
});
