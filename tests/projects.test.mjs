import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { discoverApps } from '../src/projects.js';
import { mkRoot, rmRoot, mkProject } from './helpers.mjs';

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
