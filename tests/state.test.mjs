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

// Dropping a record takes the only copy of its share child's pid with it, so
// reconcile must hand back any child still ALIVE at that moment — nothing else
// in the system can find it afterwards. A child already dead is not reported:
// there is nothing to kill.
test('reconcile reports the tunnels of dropped records whose child is still alive', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const liveFunnel = spawnLived();
  t.after(() => { try { process.kill(-liveFunnel.pid, 'SIGKILL'); } catch {} });

  const s = { apps: {
    stranded: { id: 'stranded', pid: 2 ** 30, tunnel: { kind: 'tailscale', pid: liveFunnel.pid, url: 'https://n.ts.net' } },
    alreadyDead: { id: 'alreadyDead', pid: 2 ** 30, tunnel: { kind: 'tailscale', pid: 2 ** 30, url: 'https://d.ts.net' } },
    noShare: { id: 'noShare', pid: 2 ** 30, tunnel: null },
  } };
  const { strandedTunnels } = await state.reconcile(s);

  assert.deepEqual(Object.keys(s.apps), [], 'all three dead apps are dropped');
  assert.deepEqual(strandedTunnels.map((x) => x.id), ['stranded']);
  assert.equal(strandedTunnels[0].tunnel.pid, liveFunnel.pid, 'the pid survives the delete, in the caller\'s hands');
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

// Invariant: saves land in call order, one at a time — a save started while an
// earlier one is still publishing neither breaks it (they share one tmp path)
// nor loses to it: the file ends up holding the newer snapshot.
test('save() serialises: a second save during the first one\'s rename lands after it', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const file = path.join(storeRoot(), 'state.json');
  const realRename = fs.rename;
  let release, reached, armed = true;
  const gate = new Promise((r) => { release = r; });
  const parked = new Promise((r) => { reached = r; });
  fs.rename = async (from, to) => {
    if (armed && to === file) { armed = false; reached(); await gate; }
    return realRename.call(fs, from, to);
  };
  t.after(() => { release(); fs.rename = realRename; });
  const first = state.save({ apps: { a: { id: 'a', snapshot: 1 } } });
  await parked;
  const second = state.save({ apps: { a: { id: 'a', snapshot: 2 } } });
  await new Promise((r) => setImmediate(r));
  release();
  await Promise.all([first, second]);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).apps.a.snapshot, 2);
});
