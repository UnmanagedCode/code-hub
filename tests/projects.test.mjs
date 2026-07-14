import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { discoverApps } from '../src/projects.js';
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
