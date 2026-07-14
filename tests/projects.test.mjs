import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { discoverApps, registerInMemory, unregisterInMemory, registryFile } from '../src/projects.js';
import { mkRoot, rmRoot, mkProject, writeRegistrations } from './helpers.mjs';

test('discovers only dirs with a .hub.json, honouring PROJECTS_ROOT', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkProject(root, 'alpha', { start: 'x' });
  await mkProject(root, 'beta', { start: 'y', name: 'Beta App' });
  await mkProject(root, 'no-manifest', null); // dir without .hub.json → skipped

  const apps = await discoverApps();
  const ids = apps.map((a) => a.id);
  assert.deepEqual(ids, ['alpha', 'beta']);
  assert.equal(apps.find((a) => a.id === 'beta').manifest.name, 'Beta App');
  assert.equal(apps.every((a) => !a.isWorktree), true);
});

test('classifies <project>_worktree_<hash> dirs as worktrees of their parent', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkProject(root, 'alpha', { start: 'x' });
  await mkProject(root, 'alpha_worktree_ab12cd', { start: 'x' });

  const apps = await discoverApps();
  const wt = apps.find((a) => a.id === 'alpha_worktree_ab12cd');
  assert.ok(wt);
  assert.equal(wt.isWorktree, true);
  assert.equal(wt.project, 'alpha');
});

test('surfaces a broken manifest as a non-startable app', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const dir = path.join(root, 'broken');
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, '.hub.json'), '{ not json');

  const apps = await discoverApps();
  const broken = apps.find((a) => a.id === 'broken');
  assert.ok(broken);
  assert.equal(broken.manifest, null);
  assert.match(broken.manifestError, /invalid JSON/);
});

test('skips dot-prefixed dirs (the store itself)', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await fs.mkdir(path.join(root, '.code-hub'));
  await fs.writeFile(path.join(root, '.code-hub', '.hub.json'), '{"start":"x"}');
  const apps = await discoverApps();
  assert.equal(apps.length, 0);
});

test('registrations.json fills in a manifest for a dir with no .hub.json', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkProject(root, 'unmanifested', null);
  await writeRegistrations(root, { unmanifested: { start: 'npm start', name: 'Unmanifested' } });

  const apps = await discoverApps();
  const app = apps.find((a) => a.id === 'unmanifested');
  assert.ok(app);
  assert.equal(app.source, 'registry');
  assert.equal(app.manifest.start, 'npm start');
  assert.equal(app.manifest.name, 'Unmanifested');
  assert.equal(app.manifestError, null);
});

test('a real .hub.json always wins over a registry entry for the same id', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkProject(root, 'both', { start: 'from-manifest' });
  await writeRegistrations(root, { both: { start: 'from-registry' } });

  const apps = await discoverApps();
  const app = apps.find((a) => a.id === 'both');
  assert.equal(app.source, 'manifest');
  assert.equal(app.manifest.start, 'from-manifest');
});

test('a broken .hub.json wins over a registry entry too (not silently overridden)', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const dir = path.join(root, 'broken-with-registry');
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, '.hub.json'), '{ not json');
  await writeRegistrations(root, { 'broken-with-registry': { start: 'from-registry' } });

  const apps = await discoverApps();
  const app = apps.find((a) => a.id === 'broken-with-registry');
  assert.equal(app.source, 'manifest');
  assert.equal(app.manifest, null);
  assert.match(app.manifestError, /invalid JSON/);
});

test('a malformed registry entry surfaces as a non-startable app with manifestError', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkProject(root, 'bad-entry', null);
  await writeRegistrations(root, { 'bad-entry': { name: 'Missing start' } });

  const apps = await discoverApps();
  const app = apps.find((a) => a.id === 'bad-entry');
  assert.ok(app);
  assert.equal(app.source, 'registry');
  assert.equal(app.manifest, null);
  assert.match(app.manifestError, /"start" is required/);
});

test('malformed whole-file registrations.json is ignored, not fatal', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkProject(root, 'alpha', { start: 'x' });
  await writeRegistrations(root, '{ not json');

  const apps = await discoverApps();
  assert.deepEqual(apps.map((a) => a.id), ['alpha']);
});

test('a registry entry naming a nonexistent dir is skipped, no phantom app', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkProject(root, 'alpha', { start: 'x' });
  await writeRegistrations(root, { 'ghost-project': { start: 'x' } });

  const apps = await discoverApps();
  assert.deepEqual(apps.map((a) => a.id), ['alpha']);
});

test('discovered apps from a real manifest are tagged source: manifest', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkProject(root, 'alpha', { start: 'x' });

  const apps = await discoverApps();
  assert.equal(apps.find((a) => a.id === 'alpha').source, 'manifest');
});

test('an in-memory registration fills in a manifest for a dir with no .hub.json, tagged source: memory', async (t) => {
  const root = await mkRoot();
  t.after(() => { unregisterInMemory('mem-app'); return rmRoot(root); });
  await mkProject(root, 'mem-app', null);
  registerInMemory('mem-app', { start: 'npm start', name: 'Mem App' });

  const apps = await discoverApps();
  const app = apps.find((a) => a.id === 'mem-app');
  assert.ok(app);
  assert.equal(app.source, 'memory');
  assert.equal(app.manifest.start, 'npm start');
  assert.equal(app.manifest.name, 'Mem App');
  assert.equal(app.manifestError, null);
});

test('registerInMemory rejects an invalid body and never touches registrations.json', async (t) => {
  const root = await mkRoot();
  t.after(() => { unregisterInMemory('mem-bad'); return rmRoot(root); });
  await mkProject(root, 'mem-bad', null);

  assert.throws(() => registerInMemory('mem-bad', { name: 'no start' }), /"start" is required/);

  await assert.rejects(() => fs.access(registryFile()), /ENOENT/);
});

test('unregisterInMemory removes the in-memory entry; it never persisted to registrations.json', async (t) => {
  const root = await mkRoot();
  t.after(() => { unregisterInMemory('mem-app2'); return rmRoot(root); });
  await mkProject(root, 'mem-app2', null);
  registerInMemory('mem-app2', { start: 'npm start' });

  let apps = await discoverApps();
  assert.ok(apps.find((a) => a.id === 'mem-app2'));
  await assert.rejects(() => fs.access(registryFile()), /ENOENT/);

  unregisterInMemory('mem-app2');
  apps = await discoverApps();
  assert.ok(!apps.find((a) => a.id === 'mem-app2'));
});

test('an in-memory registration wins over a disk registry entry for the same id', async (t) => {
  const root = await mkRoot();
  t.after(() => { unregisterInMemory('both-reg'); return rmRoot(root); });
  await mkProject(root, 'both-reg', null);
  await writeRegistrations(root, { 'both-reg': { start: 'from-disk' } });
  registerInMemory('both-reg', { start: 'from-memory' });

  const apps = await discoverApps();
  const app = apps.find((a) => a.id === 'both-reg');
  assert.equal(app.source, 'memory');
  assert.equal(app.manifest.start, 'from-memory');
});

test('a real .hub.json still wins over an in-memory registration for the same id', async (t) => {
  const root = await mkRoot();
  t.after(() => { unregisterInMemory('both-mem'); return rmRoot(root); });
  await mkProject(root, 'both-mem', { start: 'from-manifest' });
  registerInMemory('both-mem', { start: 'from-memory' });

  const apps = await discoverApps();
  const app = apps.find((a) => a.id === 'both-mem');
  assert.equal(app.source, 'manifest');
  assert.equal(app.manifest.start, 'from-manifest');
});

test('an in-memory registration key with no matching directory warns as orphaned, same as a disk one', async (t) => {
  const root = await mkRoot();
  t.after(() => unregisterInMemory('ghost-mem'));
  t.after(() => rmRoot(root));
  registerInMemory('ghost-mem', { start: 'x' });

  const apps = await discoverApps();
  assert.ok(!apps.find((a) => a.id === 'ghost-mem'));
});

test('a worktree with no manifest of its own inherits its parent\'s .hub.json', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkProject(root, 'alpha', { start: 'from-parent-manifest' });
  await mkProject(root, 'alpha_worktree_ab12cd', null);

  const apps = await discoverApps();
  const wt = apps.find((a) => a.id === 'alpha_worktree_ab12cd');
  assert.ok(wt);
  assert.equal(wt.isWorktree, true);
  assert.equal(wt.project, 'alpha');
  assert.equal(wt.source, 'manifest');
  assert.equal(wt.manifest.start, 'from-parent-manifest');
  assert.equal(wt.manifestError, null);
});

test('a worktree with no manifest of its own inherits its parent\'s in-memory registration', async (t) => {
  const root = await mkRoot();
  t.after(() => { unregisterInMemory('conductor'); return rmRoot(root); });
  await mkProject(root, 'conductor', null);
  await mkProject(root, 'conductor_worktree_ab12cd', null);
  registerInMemory('conductor', { start: 'npm start', name: 'Conductor' });

  const apps = await discoverApps();
  const wt = apps.find((a) => a.id === 'conductor_worktree_ab12cd');
  assert.ok(wt);
  assert.equal(wt.isWorktree, true);
  assert.equal(wt.project, 'conductor');
  assert.equal(wt.source, 'memory');
  assert.equal(wt.manifest.start, 'npm start');
});

test('a worktree with no manifest of its own inherits its parent\'s disk registration', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkProject(root, 'beta', null);
  await mkProject(root, 'beta_worktree_ab12cd', null);
  await writeRegistrations(root, { beta: { start: 'from-registry' } });

  const apps = await discoverApps();
  const wt = apps.find((a) => a.id === 'beta_worktree_ab12cd');
  assert.ok(wt);
  assert.equal(wt.isWorktree, true);
  assert.equal(wt.project, 'beta');
  assert.equal(wt.source, 'registry');
  assert.equal(wt.manifest.start, 'from-registry');
});

test('a worktree\'s own .hub.json still wins over inheriting the parent\'s manifest', async (t) => {
  const root = await mkRoot();
  t.after(() => { unregisterInMemory('gamma'); return rmRoot(root); });
  await mkProject(root, 'gamma', null);
  registerInMemory('gamma', { start: 'from-parent-memory' });
  await mkProject(root, 'gamma_worktree_ab12cd', { start: 'own-worktree-manifest' });

  const apps = await discoverApps();
  const wt = apps.find((a) => a.id === 'gamma_worktree_ab12cd');
  assert.ok(wt);
  assert.equal(wt.source, 'manifest');
  assert.equal(wt.manifest.start, 'own-worktree-manifest');
});

test('a worktree\'s own disk registration still wins over the parent\'s manifest', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkProject(root, 'delta', { start: 'parent-manifest' });
  await mkProject(root, 'delta_worktree_ab12cd', null);
  await writeRegistrations(root, { 'delta_worktree_ab12cd': { start: 'own-worktree-registry' } });

  const apps = await discoverApps();
  const wt = apps.find((a) => a.id === 'delta_worktree_ab12cd');
  assert.ok(wt);
  assert.equal(wt.isWorktree, true);
  assert.equal(wt.project, 'delta');
  assert.equal(wt.source, 'registry');
  assert.equal(wt.manifest.start, 'own-worktree-registry');
});

test('neither the worktree nor its parent has any manifest source: the worktree is skipped entirely', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkProject(root, 'epsilon', null);
  await mkProject(root, 'epsilon_worktree_ab12cd', null);

  const apps = await discoverApps();
  assert.ok(!apps.find((a) => a.id === 'epsilon_worktree_ab12cd'));
});

test('a broken parent .hub.json is not inherited; the worktree is skipped, not crashed', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const dir = path.join(root, 'zeta');
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, '.hub.json'), '{ not json');
  await mkProject(root, 'zeta_worktree_ab12cd', null);

  const apps = await discoverApps();
  const parent = apps.find((a) => a.id === 'zeta');
  assert.ok(parent);
  assert.match(parent.manifestError, /invalid JSON/);
  assert.ok(!apps.find((a) => a.id === 'zeta_worktree_ab12cd'));
});

test('a broken parent disk registration is not inherited either', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkProject(root, 'eta', null);
  await writeRegistrations(root, { eta: { name: 'missing start' } });
  await mkProject(root, 'eta_worktree_ab12cd', null);

  const apps = await discoverApps();
  const parent = apps.find((a) => a.id === 'eta');
  assert.ok(parent);
  assert.match(parent.manifestError, /"start" is required/);
  assert.ok(!apps.find((a) => a.id === 'eta_worktree_ab12cd'));
});

test('a <x>_worktree_<hash>-shaped dir with no sibling <x> dir is not eligible for fallback, just skipped', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkProject(root, 'orphan_worktree_ab12cd', null);

  const apps = await discoverApps();
  assert.ok(!apps.find((a) => a.id === 'orphan_worktree_ab12cd'));
});
