import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { discoverApps, registerInMemory, unregisterInMemory, registryFile, appDir, worktreeId } from '../src/projects.js';
import { mkRoot, rmRoot, mkProject, mkWorktree, writeRegistrations, useConductorOverlay, resetConductorOverlay, ccProject } from './helpers.mjs';

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
  // required — an adopted project whose own tree lives outside the scanned
  // root still has its worktrees inside it, and requiring the sibling would
  // make every one of them invisible.
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
  // A dir name carries no worktree meaning: nothing splits on `_worktree_`,
  // and classification comes only from sitting under `.worktrees/`. Gives the
  // dir its own .hub.json so it appears in the output either way — otherwise
  // "not a worktree" and "dropped for lack of a manifest" would look
  // identical. The companion test below covers the inheritance path.
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

test('a manifest-less top-level <x>_worktree_<key> dir never inherits from a sibling <x>', async (t) => {
  // The other half of "the flat layout is gone": recognition must be absent
  // from the inheritance path too, not just from the path where the dir has
  // its own manifest. With `alpha` present and servable, a surviving flat
  // parent-fallback would surface this dir as a worktree of `alpha`; with
  // none, it is simply an ordinary dir with no manifest source, i.e. skipped.
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkProject(root, 'alpha', { start: 'x' });
  await mkProject(root, 'alpha_worktree_ab12cd', null); // no manifest of its own

  const apps = await discoverApps();
  assert.ok(!apps.find((a) => a.id === 'alpha_worktree_ab12cd'), 'must not be surfaced at all');
  assert.ok(!apps.some((a) => a.isWorktree), 'and nothing anywhere is classified as a worktree');
});

test('a dot-prefixed project dir under .worktrees/ is invisible, mirroring the root scan', async (t) => {
  // Gives it a real manifest so it WOULD surface if the filter were dropped —
  // otherwise "filtered" and "nothing to inherit" look identical.
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkProject(root, 'alpha', { start: 'x' });
  await mkWorktree(root, 'alpha', 'ab12cd', null);
  await mkWorktree(root, '.hidden', 'ab12cd', { start: 'should-not-surface' });

  const apps = await discoverApps();
  assert.ok(apps.find((a) => a.id === 'alpha:ab12cd'), 'test setup sanity: a normal worktree still surfaces');
  assert.ok(!apps.find((a) => a.id === '.hidden:ab12cd'));
  assert.ok(!apps.some((a) => a.project === '.hidden'));
});

test('a symlink under .worktrees/<project>/ is not a worktree, even pointing at a real project', async (t) => {
  // Live on the real root: `.worktrees/p2p-dashboard/code-playwright` links to
  // a plugin checkout. A Dirent for a symlink reports isDirectory() === false,
  // so it is skipped — a linked-in dir is not a checkout conductor created,
  // and following it would surface a foreign project under a borrowed id.
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkProject(root, 'alpha', { start: 'x' });
  const target = await mkProject(root, 'elsewhere', { start: 'from-the-link-target' });
  await mkWorktree(root, 'alpha', 'ab12cd', null);
  await fs.symlink(target, path.join(root, '.worktrees', 'alpha', 'linked'));

  const apps = await discoverApps();
  assert.ok(apps.find((a) => a.id === 'alpha:ab12cd'), 'test setup sanity: a real worktree dir still surfaces');
  assert.ok(!apps.find((a) => a.id === 'alpha:linked'));
  assert.equal(await appDir('alpha:linked'), null);
});

test('a root dir whose name carries the reserved qualifier cannot collide with a worktree id', async (t) => {
  // `:` is code-hub's own reserved qualifier, so the two passes cannot emit
  // the same id: a root dir literally named `alpha:ab12cd` (legal on Linux)
  // is refused as an app — loudly, since it has a manifest — and the id
  // resolves to the worktree, single-valued, in discovery AND appDir.
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkProject(root, 'alpha', { start: 'x' });
  const collidingDir = await mkProject(root, 'alpha:ab12cd', { start: 'from-the-root-dir' });
  const wtDir = await mkWorktree(root, 'alpha', 'ab12cd', { start: 'from-the-worktree' });

  const warnings = [];
  const orig = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  let apps;
  try { apps = await discoverApps(); } finally { console.warn = orig; }

  const hits = apps.filter((a) => a.id === 'alpha:ab12cd');
  assert.equal(hits.length, 1, 'exactly one app may carry an id');
  assert.equal(hits[0].isWorktree, true);
  assert.equal(hits[0].path, wtDir);
  assert.equal(hits[0].manifest.start, 'from-the-worktree');
  assert.notEqual(hits[0].path, collidingDir);

  assert.equal(new Set(apps.map((a) => a.id)).size, apps.length, 'ids are unique across both passes');
  assert.equal(await appDir('alpha:ab12cd'), wtDir);

  assert.equal(warnings.length, 1, warnings.join('\n'));
  assert.match(warnings[0], /'alpha:ab12cd' is not servable/);
});

test('two worktrees whose components compose the SAME id are both refused', async (t) => {
  // The injectivity hole: `.worktrees/a/b:c` and `.worktrees/a:b/c` both
  // compose `a:b:c`. Composing them would put two checkouts under one id —
  // the UI showing two cards, every action on either reaching whichever
  // readdir returned first, the other silently unreachable. Both carry their
  // own manifest, so each would surface if it were composed at all.
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkWorktree(root, 'a', 'b:c', { start: 'x', name: 'one' });
  await mkWorktree(root, 'a:b', 'c', { start: 'x', name: 'two' });

  const warnings = [];
  const orig = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  let apps;
  try { apps = await discoverApps(); } finally { console.warn = orig; }

  assert.equal(apps.filter((app) => app.id === 'a:b:c').length, 0, 'neither may be composed');
  assert.equal(new Set(apps.map((app) => app.id)).size, apps.length, 'ids are unique');
  assert.equal(await appDir('a:b:c'), null);

  // Both were servable, so both refusals are said out loud and name their path.
  assert.equal(warnings.length, 2, warnings.join('\n'));
  assert.ok(warnings.some((w) => w.includes(path.join('.worktrees', 'a', 'b:c'))), warnings.join('\n'));
  assert.ok(warnings.some((w) => w.includes(path.join('.worktrees', 'a:b', 'c'))), warnings.join('\n'));
});

test('a worktree whose key carries the reserved qualifier is refused, and warns when it cost an app', async (t) => {
  // Singly, too — not only when a second checkout collides with it. The
  // parent is servable, so this worktree would have surfaced by inheritance.
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkProject(root, 'alpha', { start: 'x' });
  await mkWorktree(root, 'alpha', 'ok', null);
  await mkWorktree(root, 'alpha', 'we:ird', null);

  const warnings = [];
  const orig = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  let apps;
  try { apps = await discoverApps(); } finally { console.warn = orig; }

  assert.ok(apps.find((app) => app.id === 'alpha:ok'), 'test setup sanity: a normal sibling worktree still surfaces');
  assert.ok(!apps.some((app) => app.id.includes('we:ird')));
  assert.equal(await appDir('alpha:we:ird'), null);
  assert.equal(warnings.length, 1, warnings.join('\n'));
  assert.match(warnings[0], /is not servable/);
});

test('a refused worktree that was never going to serve anything is skipped silently', async (t) => {
  // Warn scoping, mirroring the root pass: no own manifest source and no
  // parent to inherit from means nothing was lost, so nothing is logged on
  // every 2s discovery poll.
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkWorktree(root, 'orphan', 'we:ird', null); // no parent, no manifest

  const warnings = [];
  const orig = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  let apps;
  try { apps = await discoverApps(); } finally { console.warn = orig; }

  assert.deepEqual(warnings, []);
  assert.equal(apps.length, 0);
});

test('a refused worktree whose parent donates via registrations.json still warns', async (t) => {
  // resolve() looks the parent up BY NAME against the registries, which is
  // independent of any root directory — so a registration keyed `a:b` is a
  // real app this refusal costs, even though `<root>/a:b` doesn't exist and
  // would itself be refused if it did. Skipping the parent arm for a refused
  // `<project>` loses this silently: the only log would be the generic
  // orphan-key warning, which says nothing about the checkout.
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkWorktree(root, 'a:b', 'c', null); // no manifest of its own → would inherit
  await writeRegistrations(root, { 'a:b': { start: 'from-registry' } });

  const warnings = [];
  const orig = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  let apps;
  try { apps = await discoverApps(); } finally { console.warn = orig; }

  assert.equal(apps.length, 0);
  assert.ok(
    warnings.some((w) => w.includes('is not servable') && w.includes(path.join('.worktrees', 'a:b', 'c'))),
    warnings.join('\n'),
  );
});

test('a refused worktree carrying a BROKEN manifest of its own warns', async (t) => {
  // The own.error arm, isolated: no parent anywhere, so neither own.manifest
  // nor the parent arm can carry this — only the broken manifest can. A
  // servable app was not lost, but a loud failure was, and swallowing it
  // would leave the checkout silently invisible with a broken file on disk.
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const wtDir = await mkWorktree(root, 'orphan', 'we:ird', null);
  await fs.writeFile(path.join(wtDir, '.hub.json'), '{ not json');

  const warnings = [];
  const orig = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  let apps;
  try { apps = await discoverApps(); } finally { console.warn = orig; }

  assert.equal(apps.length, 0);
  assert.equal(warnings.length, 1, warnings.join('\n'));
  assert.match(warnings[0], /is not servable/);
  assert.ok(warnings[0].includes(path.join('.worktrees', 'orphan', 'we:ird')), warnings[0]);
});

test('a registry key whose only in-root worktrees are REFUSED still warns as orphaned', async (t) => {
  // The orphan-key exemption reads the composable `worktrees` array, never
  // `refused`: a refused checkout consumes nothing, so the key really does
  // name nothing servable. Folding `refused` into the exemption would
  // suppress this warning and leave a dead registration unreported forever.
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkWorktree(root, 'ghost', 'we:ird', null); // clean project name, refused key
  await writeRegistrations(root, { ghost: { start: 'x' } });

  const warnings = [];
  const orig = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  let apps;
  try { apps = await discoverApps(); } finally { console.warn = orig; }

  assert.equal(apps.length, 0);
  assert.ok(warnings.some((w) => /'ghost' has no matching directory/.test(w)), warnings.join('\n'));
});

test('a qualified id never resolves to a root directory of that exact name', async (t) => {
  // The no-worktree arm of appDir's short-circuit. Pre-reservation this
  // resolved to the root dir, so registerApp wrote a registry entry under an
  // id discovery then refuses — a phantom registration plus a permanent
  // orphan-key warning.
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkProject(root, 'alpha:ab12cd', null); // exists, but no worktree anywhere

  assert.equal(await appDir('alpha:ab12cd'), null);
});

test('an unservable root dir carrying the reserved qualifier is skipped silently', async (t) => {
  // The warning exists to explain a vanished app; a dir that was never
  // servable must not log on every 2s discovery poll.
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkProject(root, 'alpha', { start: 'x' });
  await mkProject(root, 'notes:2026', null); // no manifest, no registration

  const warnings = [];
  const orig = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  let apps;
  try { apps = await discoverApps(); } finally { console.warn = orig; }

  assert.deepEqual(warnings, []);
  assert.ok(!apps.find((a) => a.id === 'notes:2026'));
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

test('an unpinned parent\'s manifest object is SHARED with its worktrees, not copied', async (t) => {
  // Object identity is the only observable of "no spurious copy", and the
  // sharing is what makes the copy-on-strip above load-bearing: `resolve()`
  // memoizes one manifest per project and hands that same object to the
  // parent's row and every worktree row that inherits it. A strip-always or
  // clone-everything implementation breaks this identity (and reports the
  // same `port: null` either way, which is why asserting the port here
  // proves nothing).
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkProject(root, 'plain', { start: 'x' }); // no fixed port → strip branch not entered
  await mkWorktree(root, 'plain', 'aa', null);
  await mkWorktree(root, 'plain', 'bb', null);

  const apps = await discoverApps();
  const parent = apps.find((a) => a.id === 'plain');
  const aa = apps.find((a) => a.id === 'plain:aa');
  const bb = apps.find((a) => a.id === 'plain:bb');
  assert.equal(aa.manifest, parent.manifest);
  assert.equal(bb.manifest, parent.manifest);
  assert.equal(parent.manifest.port, null);
});

// ---------------------------------------------------------------------------
// The conductor project overlay: a project the ROOT SCAN produced no directory
// for, whose worktrees nevertheless live under the root, gets its real parent
// row from the conductor's record of where its tree is.
// ---------------------------------------------------------------------------

test('embedded with an unreachable conductor returns exactly the standalone answer', async (t) => {
  // Requirement in one assertion: the overlay is strictly additive, and a
  // conductor that cannot be reached degrades to the filesystem answer rather
  // than to a degraded one. Anything the overlay changed unconditionally —
  // ordering, a field default, dirFor() — would show up as a diff here.
  const root = await mkRoot();
  t.after(async () => { resetConductorOverlay(); await rmRoot(root); });
  await mkProject(root, 'alpha', { start: 'x' });
  await mkProject(root, 'no-manifest', null);
  await mkWorktree(root, 'alpha', 'ab12cd', { start: 'x' });
  await mkWorktree(root, 'orphan', 'ab12cd', { start: 'y' });

  const standalone = await discoverApps();
  await useConductorOverlay(null); // embedded, conductor refuses the connection
  const embedded = await discoverApps();

  assert.deepStrictEqual(embedded, standalone);
  assert.ok(standalone.find((a) => a.id === 'orphan:ab12cd'), 'setup: the orphaned worktree is present either way');
});

test('an out-of-root project the conductor knows becomes the parent row for its worktrees', async (t) => {
  const root = await mkRoot();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'codehub-outside-'));
  t.after(async () => { resetConductorOverlay(); await rmRoot(root); await rmRoot(outside); });
  const tree = await mkProject(outside, 'wanderer', { start: 'x' });
  await mkWorktree(root, 'wanderer', 'ab12cd', { start: 'x' });
  await useConductorOverlay([ccProject('wanderer', tree)]);

  const apps = await discoverApps();
  const main = apps.find((a) => a.id === 'wanderer');
  assert.ok(main, 'the conductor-known tree must surface as a main checkout');
  assert.equal(main.isWorktree, false);
  assert.equal(main.path, tree);
  assert.equal(main.project, 'wanderer');
  // The nesting contract render() consumes: the worktree's `project` names a
  // row that is now in the payload, so it stops being an orphan card.
  assert.equal(apps.find((a) => a.id === 'wanderer:ab12cd').project, 'wanderer');
});

test('a tree nested under a DOT-dir of the projects root is an overlay case too', async (t) => {
  // The real-world shape: `.plugins/<name>` is lexically under the root, so
  // "outside the root" would miss it — the root scan skips it for the leading
  // dot, and "the root scan produced no directory of that name" is what the
  // overlay keys on.
  const root = await mkRoot();
  t.after(async () => { resetConductorOverlay(); await rmRoot(root); });
  const tree = path.join(root, '.plugins', 'nested');
  await fs.mkdir(tree, { recursive: true });
  await fs.writeFile(path.join(tree, '.hub.json'), JSON.stringify({ start: 'x' }));
  await mkWorktree(root, 'nested', 'ab12cd', null);
  await useConductorOverlay([ccProject('nested', tree)]);

  const apps = await discoverApps();
  const main = apps.find((a) => a.id === 'nested');
  assert.ok(main);
  assert.equal(main.path, tree);
  assert.equal(main.manifest.start, 'x');
});

test('an overlay project\'s own .hub.json makes it startable and donates to its worktrees', async (t) => {
  const root = await mkRoot();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'codehub-outside-'));
  t.after(async () => { resetConductorOverlay(); await rmRoot(root); await rmRoot(outside); });
  const tree = await mkProject(outside, 'wanderer', { start: 'from-its-own-tree', port: 3100 });
  await mkWorktree(root, 'wanderer', 'ab12cd', null); // no manifest of its own → inherits
  await useConductorOverlay([ccProject('wanderer', tree)]);

  const apps = await discoverApps();
  const main = apps.find((a) => a.id === 'wanderer');
  assert.equal(main.source, 'manifest');
  assert.equal(main.manifest.start, 'from-its-own-tree');
  assert.equal(main.manifestError, null);
  assert.equal(main.manifest.port, 3100);

  const wt = apps.find((a) => a.id === 'wanderer:ab12cd');
  assert.ok(wt, 'the worktree inherits the manifest read at the conductor-recorded tree');
  assert.equal(wt.source, 'manifest');
  assert.equal(wt.manifest.start, 'from-its-own-tree');
  assert.equal(wt.manifest.port, null, 'a worktree still never inherits a fixed port');
});

test('an overlay project with no manifest source is a non-startable row, not a Start that 400s', async (t) => {
  const root = await mkRoot();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'codehub-outside-'));
  t.after(async () => { resetConductorOverlay(); await rmRoot(root); await rmRoot(outside); });
  const tree = await mkProject(outside, 'bare', null);
  await mkWorktree(root, 'bare', 'ab12cd', { start: 'x' });
  await useConductorOverlay([ccProject('bare', tree)]);

  const apps = await discoverApps();
  const main = apps.find((a) => a.id === 'bare');
  assert.ok(main);
  assert.equal(main.path, tree);
  assert.equal(main.manifest, null);
  assert.equal(main.source, null);
  assert.match(main.manifestError, /no \.hub\.json and no registrations\.json entry — not startable/);
});

test('a conductor project with no worktrees under the root adds no card', async (t) => {
  // Scope guard: the overlay gives an ORPHANED WORKTREE GROUP its parent. A
  // project with no worktrees renders nothing today, and must keep rendering
  // nothing — the conductor's catalog is not a second discovery root.
  const root = await mkRoot();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'codehub-outside-'));
  t.after(async () => { resetConductorOverlay(); await rmRoot(root); await rmRoot(outside); });
  const tree = await mkProject(outside, 'solo', { start: 'x' });
  await useConductorOverlay([ccProject('solo', tree)]);

  const apps = await discoverApps();
  assert.equal(apps.find((a) => a.id === 'solo'), undefined);
});

test('a root directory of the same name wins, and the suppressed overlay row warns', async (t) => {
  const root = await mkRoot();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'codehub-outside-'));
  t.after(async () => { resetConductorOverlay(); await rmRoot(root); await rmRoot(outside); });
  const inRoot = await mkProject(root, 'foo', { start: 'in-root' });
  const elsewhere = await mkProject(outside, 'foo', { start: 'elsewhere' });
  await mkWorktree(root, 'foo', 'ab12cd', null);
  await useConductorOverlay([ccProject('foo', elsewhere)]);

  const warnings = [];
  const orig = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  let apps;
  try { apps = await discoverApps(); } finally { console.warn = orig; }

  assert.deepEqual(apps.filter((a) => a.id === 'foo').length, 1, 'exactly one row for the name');
  const main = apps.find((a) => a.id === 'foo');
  assert.equal(main.path, inRoot);
  assert.equal(main.manifest.start, 'in-root', 'the root directory\'s own manifest, not the conductor tree\'s');
  assert.equal(apps.find((a) => a.id === 'foo:ab12cd').manifest.start, 'in-root');
  assert.equal(warnings.length, 1, warnings.join('\n'));
  assert.ok(warnings[0].includes(inRoot) && warnings[0].includes(elsewhere), warnings[0]);
});

test('a conductor path that agrees with the root directory does not warn', async (t) => {
  // Scoping, same as the `:` refusals: loud only when the suppression cost
  // something. Agreement costs nothing, and a warning on every 2s poll would
  // be noise.
  const root = await mkRoot();
  t.after(async () => { resetConductorOverlay(); await rmRoot(root); });
  const inRoot = await mkProject(root, 'foo', { start: 'in-root' });
  await mkWorktree(root, 'foo', 'ab12cd', null);
  await useConductorOverlay([ccProject('foo', await fs.realpath(inRoot))]);

  const warnings = [];
  const orig = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try { await discoverApps(); } finally { console.warn = orig; }

  assert.deepEqual(warnings, []);
});

test('a conductor path that no longer exists yields no row', async (t) => {
  // The snapshot can be up to its TTL stale, so every overlay path is
  // stat-verified before it becomes a card's `path`.
  const root = await mkRoot();
  t.after(async () => { resetConductorOverlay(); await rmRoot(root); });
  await mkWorktree(root, 'ghost', 'ab12cd', { start: 'x' });
  await useConductorOverlay([ccProject('ghost', path.join(root, '..', 'codehub-deleted-tree-does-not-exist'))]);

  const apps = await discoverApps();
  assert.equal(apps.find((a) => a.id === 'ghost'), undefined);
  assert.ok(apps.find((a) => a.id === 'ghost:ab12cd'), 'its worktree stays listed, orphaned as before');
});

test('appDir() resolves an overlay id to the conductor-recorded tree, and nothing when the conductor is down', async (t) => {
  const root = await mkRoot();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'codehub-outside-'));
  t.after(async () => { resetConductorOverlay(); await rmRoot(root); await rmRoot(outside); });
  const tree = await mkProject(outside, 'wanderer', null);
  await mkWorktree(root, 'wanderer', 'ab12cd', null);

  await useConductorOverlay([ccProject('wanderer', tree)]);
  assert.equal(await appDir('wanderer'), tree);

  resetConductorOverlay();
  await useConductorOverlay(null);
  assert.equal(await appDir('wanderer'), null, 'with no overlay the id names nothing — correct degradation');
});

test('a root directory still wins over the overlay in appDir()', async (t) => {
  const root = await mkRoot();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'codehub-outside-'));
  t.after(async () => { resetConductorOverlay(); await rmRoot(root); await rmRoot(outside); });
  const inRoot = await mkProject(root, 'foo', null);
  const elsewhere = await mkProject(outside, 'foo', null);
  await useConductorOverlay([ccProject('foo', elsewhere)]);

  assert.equal(await appDir('foo'), inRoot);
});

test('an overlay project whose recorded tree has a BROKEN .hub.json surfaces the error, not the generic reason', async (t) => {
  // Fail loudly: the same treatment an in-root project gets. Reporting "no
  // manifest source" here would hide a file that is right there and wrong.
  const root = await mkRoot();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'codehub-outside-'));
  t.after(async () => { resetConductorOverlay(); await rmRoot(root); await rmRoot(outside); });
  const tree = await mkProject(outside, 'wanderer', null);
  await fs.writeFile(path.join(tree, '.hub.json'), '{ not json');
  await mkWorktree(root, 'wanderer', 'ab12cd', null);
  await useConductorOverlay([ccProject('wanderer', tree)]);

  const apps = await discoverApps();
  const main = apps.find((a) => a.id === 'wanderer');
  assert.ok(main);
  assert.equal(main.manifest, null);
  assert.equal(main.source, 'manifest');
  assert.match(main.manifestError, /invalid JSON/);
});

test('appDir() refuses an overlay id with no worktree — the same condition the listing emits on', async (t) => {
  // The listing and id resolution decide through one predicate. When they
  // drifted, `register_app` accepted an id no card would ever show: a
  // permanent unusable registry entry, plus an orphan-key warning on every
  // 2s poll.
  const root = await mkRoot();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'codehub-outside-'));
  t.after(async () => { resetConductorOverlay(); await rmRoot(root); await rmRoot(outside); });
  const solo = await mkProject(outside, 'solo', null);       // conductor knows it, no worktree here
  const paired = await mkProject(outside, 'paired', null);   // conductor knows it, worktree here
  await mkWorktree(root, 'paired', 'ab12cd', null);
  await useConductorOverlay([ccProject('solo', solo), ccProject('paired', paired)]);

  assert.equal(await appDir('solo'), null, 'no worktree ⇒ no servable app ⇒ no directory');
  assert.equal(await appDir('paired'), paired, 'the same predicate says yes for the group that has one');
  assert.equal((await discoverApps()).find((a) => a.id === 'solo'), undefined);
});
