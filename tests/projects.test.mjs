import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { discoverApps, registerInMemory, unregisterInMemory, registryFile, appDir, worktreeId } from '../src/projects.js';
import { mkRoot, rmRoot, mkProject, mkWorktree, writeRegistrations } from './helpers.mjs';

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

test('classifies .worktrees/<project>/<key> dirs as worktrees of their parent', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkProject(root, 'alpha', { start: 'x' });
  await mkWorktree(root, 'alpha', 'ab12cd', { start: 'x' });

  const apps = await discoverApps();
  const wt = apps.find((a) => a.id === 'alpha:ab12cd');
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
  await mkWorktree(root, 'alpha', 'ab12cd', null);

  const apps = await discoverApps();
  const wt = apps.find((a) => a.id === 'alpha:ab12cd');
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
  await mkWorktree(root, 'conductor', 'ab12cd', null);
  registerInMemory('conductor', { start: 'npm start', name: 'Conductor' });

  const apps = await discoverApps();
  const wt = apps.find((a) => a.id === 'conductor:ab12cd');
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
  await mkWorktree(root, 'beta', 'ab12cd', null);
  await writeRegistrations(root, { beta: { start: 'from-registry' } });

  const apps = await discoverApps();
  const wt = apps.find((a) => a.id === 'beta:ab12cd');
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
  await mkWorktree(root, 'gamma', 'ab12cd', { start: 'own-worktree-manifest' });

  const apps = await discoverApps();
  const wt = apps.find((a) => a.id === 'gamma:ab12cd');
  assert.ok(wt);
  assert.equal(wt.source, 'manifest');
  assert.equal(wt.manifest.start, 'own-worktree-manifest');
});

test('a worktree\'s own disk registration still wins over the parent\'s manifest', async (t) => {
  // The registry lookup key for a worktree IS its app id, so the entry is
  // written under `<project>:<key>`, not the bare key.
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkProject(root, 'delta', { start: 'parent-manifest' });
  await mkWorktree(root, 'delta', 'ab12cd', null);
  await writeRegistrations(root, { 'delta:ab12cd': { start: 'own-worktree-registry' } });

  const apps = await discoverApps();
  const wt = apps.find((a) => a.id === 'delta:ab12cd');
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
  await mkWorktree(root, 'epsilon', 'ab12cd', null);

  const apps = await discoverApps();
  assert.ok(!apps.find((a) => a.id === 'epsilon:ab12cd'));
});

test('a broken parent .hub.json is not inherited; the worktree is skipped, not crashed', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const dir = path.join(root, 'zeta');
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, '.hub.json'), '{ not json');
  await mkWorktree(root, 'zeta', 'ab12cd', null);

  const apps = await discoverApps();
  const parent = apps.find((a) => a.id === 'zeta');
  assert.ok(parent);
  assert.match(parent.manifestError, /invalid JSON/);
  assert.ok(!apps.find((a) => a.id === 'zeta:ab12cd'));
});

test('a broken parent disk registration is not inherited either', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkProject(root, 'eta', null);
  await writeRegistrations(root, { eta: { name: 'missing start' } });
  await mkWorktree(root, 'eta', 'ab12cd', null);

  const apps = await discoverApps();
  const parent = apps.find((a) => a.id === 'eta');
  assert.ok(parent);
  assert.match(parent.manifestError, /"start" is required/);
  assert.ok(!apps.find((a) => a.id === 'eta:ab12cd'));
});

test('a worktree of a project with NO main checkout under the root still surfaces', async (t) => {
  // The nested layout names the parent project structurally, so parenthood is
  // read off the intermediate dir and a sibling `<root>/<project>` is NOT
  // required. This is the live adopted/out-of-root project case (code-hub's
  // own checkout lives in `.plugins/`, its worktrees under the scanned root):
  // requiring the sibling would make those worktrees invisible.
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkWorktree(root, 'ghost', 'ab12cd', { start: 'own-manifest' });

  const apps = await discoverApps();
  const wt = apps.find((a) => a.id === 'ghost:ab12cd');
  assert.ok(wt, 'a worktree with its own manifest must surface without a parent dir under the root');
  assert.equal(wt.isWorktree, true);
  assert.equal(wt.project, 'ghost');
  assert.equal(wt.source, 'manifest');
  assert.ok(!apps.find((a) => a.id === 'ghost'));
});

test('a parentless worktree with nothing to inherit is still skipped', async (t) => {
  // The other half of the rule above: surfacing is decided by having a
  // manifest source, never by the parenthood check.
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkWorktree(root, 'ghost', 'ab12cd', null);

  const apps = await discoverApps();
  assert.ok(!apps.find((a) => a.id === 'ghost:ab12cd'));
});

test('nothing about a worktree key is inspected: differently-shaped keys both classify', async (t) => {
  // code-conductor's key charset is its own to define and has already changed
  // once (hex shortId -> free-form slug). The nested layout means the key is
  // never matched against anything, so both shapes must classify identically.
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkProject(root, 'code-conductor', { start: 'x' });
  await mkWorktree(root, 'code-conductor', 'ab12cd', { start: 'x' });
  await mkWorktree(root, 'code-conductor', 'hub-probe', { start: 'x' });

  const apps = await discoverApps();
  for (const key of ['ab12cd', 'hub-probe']) {
    const wt = apps.find((a) => a.id === `code-conductor:${key}`);
    assert.ok(wt, `worktree key ${key} should classify`);
    assert.equal(wt.isWorktree, true);
    assert.equal(wt.project, 'code-conductor');
  }
});

test('two projects sharing a worktree key get distinct ids', async (t) => {
  // The collision the `<project>:<key>` id exists to prevent: conductor scopes
  // worktree keys per project precisely so two projects may share one.
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkProject(root, 'alpha', { start: 'a' });
  await mkProject(root, 'beta', { start: 'b' });
  await mkWorktree(root, 'alpha', 'shared', null);
  await mkWorktree(root, 'beta', 'shared', null);

  const apps = await discoverApps();
  const a = apps.find((x) => x.id === 'alpha:shared');
  const b = apps.find((x) => x.id === 'beta:shared');
  assert.ok(a && b);
  assert.equal(a.manifest.start, 'a');
  assert.equal(b.manifest.start, 'b');
  assert.equal(a.project, 'alpha');
  assert.equal(b.project, 'beta');
});

test('a worktree key equal to another project\'s name does not collide with it', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkProject(root, 'alpha', { start: 'a' });
  await mkProject(root, 'beta', { start: 'b' });
  await mkWorktree(root, 'alpha', 'beta', null);

  const apps = await discoverApps();
  const project = apps.find((x) => x.id === 'beta');
  const wt = apps.find((x) => x.id === 'alpha:beta');
  assert.ok(project && wt);
  assert.equal(project.isWorktree, false);
  assert.equal(project.manifest.start, 'b');
  assert.equal(wt.isWorktree, true);
  assert.equal(wt.project, 'alpha');
  assert.equal(wt.manifest.start, 'a'); // inherited from alpha, not beta
});

test('a worktree with its OWN broken .hub.json is an error row that still nests under its parent', async (t) => {
  // Parenthood is known before resolution now, so a broken worktree manifest
  // surfaces as a worktree of its project instead of a bogus top-level card.
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkProject(root, 'alpha', { start: 'x' });
  const wtDir = await mkWorktree(root, 'alpha', 'ab12cd', null);
  await fs.writeFile(path.join(wtDir, '.hub.json'), '{ not json');

  const apps = await discoverApps();
  const wt = apps.find((a) => a.id === 'alpha:ab12cd');
  assert.ok(wt);
  assert.equal(wt.isWorktree, true);
  assert.equal(wt.project, 'alpha');
  assert.equal(wt.manifest, null);
  assert.equal(wt.source, 'manifest');
  assert.match(wt.manifestError, /invalid JSON/);
  assert.match(wt.manifestError, /ab12cd/); // names the WORKTREE's own file
});

test('a worktree\'s own broken registry entry is labelled with the worktree id', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkProject(root, 'alpha', { start: 'x' });
  await mkWorktree(root, 'alpha', 'ab12cd', null);
  await writeRegistrations(root, { 'alpha:ab12cd': { name: 'missing start' } });

  const apps = await discoverApps();
  const wt = apps.find((a) => a.id === 'alpha:ab12cd');
  assert.ok(wt);
  assert.equal(wt.isWorktree, true);
  assert.equal(wt.project, 'alpha');
  assert.equal(wt.source, 'registry');
  assert.match(wt.manifestError, /registrations\.json#alpha:ab12cd/);
});

test('a registry key naming only a .worktrees/<project> dir is not warned as orphaned', async (t) => {
  // The out-of-root parent case: a project whose checkout isn't under the root
  // holds a registration consumed only by its worktrees. Warning on it would
  // fire on every discovery call.
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkWorktree(root, 'adopted', 'ab12cd', null);
  await writeRegistrations(root, { adopted: { start: 'from-registry' } });

  const warnings = [];
  const orig = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  let apps;
  try { apps = await discoverApps(); } finally { console.warn = orig; }

  assert.deepEqual(warnings, []);
  const wt = apps.find((a) => a.id === 'adopted:ab12cd');
  assert.ok(wt, 'the worktree inherits the out-of-root parent\'s registration');
  assert.equal(wt.source, 'registry');
  assert.equal(wt.manifest.start, 'from-registry');
});

test('a registry key naming neither a root dir nor a .worktrees project still warns', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkWorktree(root, 'adopted', 'ab12cd', null);
  await writeRegistrations(root, { nowhere: { start: 'x' } });

  const warnings = [];
  const orig = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try { await discoverApps(); } finally { console.warn = orig; }

  assert.equal(warnings.length, 1, warnings.join('\n'));
  assert.match(warnings[0], /'nowhere' has no matching directory/);
});

test('appDir resolves a main checkout, a worktree id, and nothing else', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkProject(root, 'alpha', { start: 'x' });
  const wtDir = await mkWorktree(root, 'alpha', 'ab12cd', null);

  assert.equal(await appDir('alpha'), path.join(root, 'alpha'));
  assert.equal(await appDir('alpha:ab12cd'), wtDir);
  assert.equal(await appDir('alpha:nope'), null);
  assert.equal(await appDir('nope'), null);
});

test('worktreeId composes the id discovery uses', async (t) => {
  // discoverApps() and appDir() must never drift from each other on id shape.
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkProject(root, 'alpha', { start: 'x' });
  await mkWorktree(root, 'alpha', 'ab12cd', null);

  const apps = await discoverApps();
  assert.ok(apps.find((a) => a.id === worktreeId('alpha', 'ab12cd')));
});

test('a top-level dir literally named <x>_worktree_<key> is an ordinary project', async (t) => {
  // The old flat layout is gone, not half-recognised: nothing splits on
  // `_worktree_` any more. Gives the dir its own .hub.json so it appears in
  // the output either way — otherwise "not a worktree" and "dropped for lack
  // of a manifest" would look identical.
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkProject(root, 'alpha', { start: 'x' });
  await mkProject(root, 'alpha_worktree_ab12cd', { start: 'x' });

  const apps = await discoverApps();
  const app = apps.find((a) => a.id === 'alpha_worktree_ab12cd');
  assert.ok(app);
  assert.equal(app.isWorktree, false);
  assert.equal(app.project, 'alpha_worktree_ab12cd');
});

// A fixed port is per-checkout. These cases cover every route by which a
// worktree could otherwise acquire one: inheriting the parent's manifest, its
// own git-carried copy of that `.hub.json`, and — the discriminating one — the
// memoized parent object being mutated rather than copied.
test('a worktree inheriting its parent\'s manifest never inherits the fixed port', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkProject(root, 'pinned', { start: 'x', port: 3000 });
  await mkWorktree(root, 'pinned', 'ab12cd', null); // no manifest of its own → inherits

  const apps = await discoverApps();
  assert.equal(apps.find((a) => a.id === 'pinned').manifest.port, 3000);
  const wt = apps.find((a) => a.id === 'pinned:ab12cd');
  assert.equal(wt.isWorktree, true);
  assert.equal(wt.manifest.port, null);
  assert.equal(wt.manifest.start, 'x'); // everything else still inherited
});

test('a worktree with its OWN .hub.json carrying a port still reports null', async (t) => {
  // The common case: git carries the parent's tracked `.hub.json` into the
  // worktree checkout, so the worktree resolves its own manifest and never
  // touches the inheritance branch at all.
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkProject(root, 'pinned', { start: 'x', port: 3000 });
  await mkWorktree(root, 'pinned', 'ab12cd', { start: 'x', port: 3000 });

  const apps = await discoverApps();
  const wt = apps.find((a) => a.id === 'pinned:ab12cd');
  assert.equal(wt.manifest.port, null);
  assert.equal(wt.manifest.start, 'x');
});

test('stripping a worktree\'s port copies the manifest — the parent keeps its own', async (t) => {
  // `resolve()` memoizes one object per project name and hands the SAME object
  // to both the parent's row and its worktrees'. Mutating it in place to strip
  // the worktree's port would also strip the parent's. The worktree pass runs
  // AFTER the root pass, so a mutating implementation corrupts the parent entry
  // that was already pushed — this asserts on the parent read back out of the
  // final result, which is where that shows up.
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkProject(root, 'pinned', { start: 'x', port: 3000 });
  await mkWorktree(root, 'pinned', 'aa', null);
  await mkWorktree(root, 'pinned', 'bb', null);

  const apps = await discoverApps();
  assert.equal(apps.find((a) => a.id === 'pinned').manifest.port, 3000);
  assert.equal(apps.find((a) => a.id === 'pinned:aa').manifest.port, null);
  assert.equal(apps.find((a) => a.id === 'pinned:bb').manifest.port, null);
});

test('a worktree of an unpinned parent is unaffected (no spurious copy)', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkProject(root, 'plain', { start: 'x' });
  await mkWorktree(root, 'plain', 'ab12cd', null);

  const apps = await discoverApps();
  assert.equal(apps.find((a) => a.id === 'plain:ab12cd').manifest.port, null);
});
