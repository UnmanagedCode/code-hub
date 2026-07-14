import test from 'node:test';
import assert from 'node:assert/strict';
import * as appManager from '../src/appManager.js';
import { discoverApps } from '../src/projects.js';
import { mkRoot, rmRoot, mkProject } from './helpers.mjs';

test('registerApp: happy path makes a manifest-less dir startable', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkProject(root, 'tool', null);

  const app = await appManager.registerApp({ id: 'tool', start: 'npm start', name: 'Tool' });
  assert.equal(app.id, 'tool');
  assert.equal(app.source, 'registry');
  assert.equal(app.manifest.start, 'npm start');
  assert.equal(app.manifest.name, 'Tool');

  const apps = await discoverApps();
  assert.ok(apps.find((a) => a.id === 'tool' && a.source === 'registry'));
});

test('registerApp: rejects a missing id', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));

  await assert.rejects(() => appManager.registerApp({ start: 'x' }), /id is required/);
});

test('registerApp: rejects an id containing a path separator', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkProject(root, 'foo', null);

  await assert.rejects(
    () => appManager.registerApp({ id: 'foo/bar', start: 'npm start' }),
    /plain, non-dot-prefixed directory basename/,
  );
  await assert.rejects(
    () => appManager.registerApp({ id: 'foo/', start: 'npm start' }),
    /plain, non-dot-prefixed directory basename/,
  );
});

test('registerApp: rejects an id that is not an existing directory', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));

  await assert.rejects(
    () => appManager.registerApp({ id: 'does-not-exist', start: 'npm start' }),
    /is not an existing directory/,
  );
});

test('registerApp: rejects a dir that already has a .hub.json', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkProject(root, 'already-manifested', { start: 'x' });

  await assert.rejects(
    () => appManager.registerApp({ id: 'already-manifested', start: 'npm start' }),
    /already has a \.hub\.json/,
  );
});

test('registerApp: validates the manifest fields (missing start)', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkProject(root, 'tool', null);

  await assert.rejects(() => appManager.registerApp({ id: 'tool' }), /"start" is required/);
});

test('unregisterApp: happy path removes the entry', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkProject(root, 'tool', null);
  await appManager.registerApp({ id: 'tool', start: 'npm start' });

  const result = await appManager.unregisterApp('tool');
  assert.deepEqual(result, { id: 'tool', registered: false });

  const apps = await discoverApps();
  assert.ok(!apps.find((a) => a.id === 'tool'));
});

test('unregisterApp: rejects an id that is not registered', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));

  await assert.rejects(() => appManager.unregisterApp('never-registered'), /is not registered/);
});
