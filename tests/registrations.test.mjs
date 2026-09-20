import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as appManager from '../src/appManager.js';
import { discoverApps, registryFile } from '../src/projects.js';
import { mkRoot, rmRoot, mkProject, mkWorktree, useConductorOverlay, resetConductorOverlay, ccProject } from './helpers.mjs';

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

test('registerApp: an optional fixed port is persisted and surfaces on the discovered app', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkProject(root, 'tool', null);

  const app = await appManager.registerApp({ id: 'tool', start: 'npm start', port: 3100 });
  assert.equal(app.manifest.port, 3100);

  // It must actually reach registrations.json — `port` has to survive BOTH the
  // destructure allow-list in registerApp and validateManifestObject's
  // whitelist rebuild, either of which would silently drop it.
  const onDisk = JSON.parse(await fs.readFile(registryFile(), 'utf8'));
  assert.equal(onDisk.tool.port, 3100);

  assert.equal((await discoverApps()).find((a) => a.id === 'tool').manifest.port, 3100);
});

test('registerApp: omitting port stores null, not undefined', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkProject(root, 'tool', null);

  const app = await appManager.registerApp({ id: 'tool', start: 'npm start' });
  assert.equal(app.manifest.port, null);
});

test('registerApp: rejects an out-of-range port, naming the range', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkProject(root, 'tool', null);

  await assert.rejects(
    () => appManager.registerApp({ id: 'tool', start: 'npm start', port: 80 }),
    /register_app:tool: "port" must be an integer between 1024 and 65535 \(got 80\)/,
  );
  // ...and nothing was written.
  await assert.rejects(() => fs.readFile(registryFile(), 'utf8'));
});

test('a registry entry\'s fixed port is stripped from that project\'s worktrees', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkProject(root, 'tool', null);
  await mkWorktree(root, 'tool', 'ab12cd', null);
  await appManager.registerApp({ id: 'tool', start: 'npm start', port: 3100 });

  const apps = await discoverApps();
  assert.equal(apps.find((a) => a.id === 'tool').manifest.port, 3100);
  assert.equal(apps.find((a) => a.id === 'tool:ab12cd').manifest.port, null);
});

test('registerApp: a worktree id registers the worktree checkout itself', async (t) => {
  // registerApp is the one site that must map an id to a directory without
  // discovery; for a worktree that means resolving `<project>:<key>` to
  // `<root>/.worktrees/<project>/<key>` and writing the registry under that
  // same id — with the fixed port still stripped on the way out.
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkProject(root, 'tool', null);
  await mkWorktree(root, 'tool', 'ab12cd', null);

  const app = await appManager.registerApp({ id: 'tool:ab12cd', start: 'npm start', name: 'WT', port: 3100 });
  assert.equal(app.id, 'tool:ab12cd');
  assert.equal(app.isWorktree, true);
  assert.equal(app.project, 'tool');
  assert.equal(app.source, 'registry');
  assert.equal(app.manifest.start, 'npm start');
  assert.equal(app.manifest.port, null, 'a worktree never keeps a fixed port, even its own registration\'s');
  assert.equal(app.path, path.join(root, '.worktrees', 'tool', 'ab12cd'));

  const onDisk = JSON.parse(await fs.readFile(registryFile(), 'utf8'));
  assert.equal(onDisk['tool:ab12cd'].start, 'npm start');
  assert.equal(onDisk['tool:ab12cd'].port, 3100); // stripped at discovery, not at write

  const result = await appManager.unregisterApp('tool:ab12cd');
  assert.deepEqual(result, { id: 'tool:ab12cd', registered: false });
  assert.ok(!(await discoverApps()).find((a) => a.id === 'tool:ab12cd'));
});

test('registerApp: rejects a worktree id naming no checkout, naming the reservation', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkProject(root, 'tool', null);
  await mkWorktree(root, 'tool', 'ab12cd', null);

  await assert.rejects(
    () => appManager.registerApp({ id: 'tool:nope', start: 'npm start' }),
    /matches no worktree under the projects root — ':' is reserved for worktree ids/,
  );
});

test('registerApp: a qualified id is refused even when a root dir of that exact name exists', async (t) => {
  // The reservation excludes the directory, so the old
  // "is not an existing directory" would be a false statement of the reason —
  // and nothing may be written for an id discovery would then refuse.
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  await mkProject(root, 'tool:ab12cd', null); // a real dir; no worktree anywhere

  await assert.rejects(
    () => appManager.registerApp({ id: 'tool:ab12cd', start: 'npm start' }),
    (e) => {
      assert.equal(e.statusCode, 400);
      assert.doesNotMatch(e.message, /is not an existing directory/);
      assert.match(e.message, /reserved for worktree ids/);
      return true;
    },
  );
  await assert.rejects(() => fs.readFile(registryFile(), 'utf8'), /ENOENT/);
});

test('registerApp: an overlay id registers the conductor-recorded tree and makes it startable', async (t) => {
  // The overlay id is a real target for registration: `appDir()` reads the
  // same snapshot discovery does, so an id the listing shows as a card is an
  // id `register_app` can write for.
  const root = await mkRoot();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'codehub-outside-'));
  t.after(async () => { resetConductorOverlay(); await rmRoot(root); await rmRoot(outside); });
  const tree = await mkProject(outside, 'wanderer', null); // no .hub.json anywhere
  await mkWorktree(root, 'wanderer', 'ab12cd', null);
  await useConductorOverlay([ccProject('wanderer', tree)]);

  const app = await appManager.registerApp({ id: 'wanderer', start: 'npm start', name: 'Wanderer' });
  assert.equal(app.id, 'wanderer');
  assert.equal(app.path, tree);
  assert.equal(app.source, 'registry');
  assert.equal(app.manifest.start, 'npm start');
  assert.equal(app.manifestError, null);

  const onDisk = JSON.parse(await fs.readFile(registryFile(), 'utf8'));
  assert.equal(onDisk.wanderer.start, 'npm start');
  // ...and its worktree inherits the registration, as it did before the overlay.
  assert.equal((await discoverApps()).find((a) => a.id === 'wanderer:ab12cd').source, 'registry');
});

test('registerApp: with the conductor unreachable an overlay id refuses, and writes nothing', async (t) => {
  const root = await mkRoot();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'codehub-outside-'));
  t.after(async () => { resetConductorOverlay(); await rmRoot(root); await rmRoot(outside); });
  await mkProject(outside, 'wanderer', null);
  await mkWorktree(root, 'wanderer', 'ab12cd', null);
  await useConductorOverlay(null);

  await assert.rejects(
    () => appManager.registerApp({ id: 'wanderer', start: 'npm start' }),
    /'wanderer' is not an existing directory under the projects root/,
  );
  await assert.rejects(() => fs.readFile(registryFile(), 'utf8'), /ENOENT/);
});

test('registerApp: an overlay id the listing would not show is refused, and writes nothing', async (t) => {
  // A conductor project with no worktree under the root is not code-hub's to
  // serve. Accepting it would persist a registry entry naming an app that can
  // never appear or start, and make discovery warn about the orphaned key on
  // every poll.
  const root = await mkRoot();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'codehub-outside-'));
  t.after(async () => { resetConductorOverlay(); await rmRoot(root); await rmRoot(outside); });
  const solo = await mkProject(outside, 'solo', null);
  await useConductorOverlay([ccProject('solo', solo)]);

  await assert.rejects(
    () => appManager.registerApp({ id: 'solo', start: 'npm start' }),
    /'solo' is not an existing directory under the projects root/,
  );
  await assert.rejects(() => fs.readFile(registryFile(), 'utf8'), /ENOENT/);
});
