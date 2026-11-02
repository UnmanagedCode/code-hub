import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { start } from '../server.js';
import * as hubSettings from '../src/hubSettings.js';
import { allocatePort } from '../src/net.js';
import { mkRoot, rmRoot, mkProject, dataDirIn, snapshotTree, fakeCloudflaredBin, fakeTailscaleBin, REPO_ROOT } from './helpers.mjs';

const exists = (p) => fs.lstat(p).then(() => true, () => false);

// `node server.js` with the data-dir variable removed (and the conductor's
// other variables, so it runs standalone), a scratch projects root and an
// allocated port — never the live hub's.
async function runServer(root, extraEnv = {}) {
  const env = { ...process.env, PROJECTS_ROOT: root, CODEHUB_CLOUDFLARED_BIN: fakeCloudflaredBin, CODEHUB_TAILSCALE_BIN: fakeTailscaleBin,
    HOST: '127.0.0.1', PORT: String(await allocatePort()), ...extraEnv };
  for (const k of ['CONDUCTOR_PLUGIN_DATA_DIR', 'CONDUCTOR_URL', 'CONDUCTOR_PLUGIN_ID']) if (!(k in extraEnv)) delete env[k];
  const proc = spawn(process.execPath, [path.join(REPO_ROOT, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  proc.stdout.on('data', (d) => { stdout += d; });
  proc.stderr.on('data', (d) => { stderr += d; });
  const timer = setTimeout(() => proc.kill('SIGKILL'), 15000);
  const code = await new Promise((r) => proc.once('exit', (c) => r(c)));
  clearTimeout(timer);
  return { code, stdout, stderr };
}

async function scratch(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codehub-boot-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const legacy = path.join(root, '.code-hub');
  await fs.mkdir(legacy);
  await fs.writeFile(path.join(legacy, 'registrations.json'), '{}');
  return { root, legacy };
}

// Invariant: boot refuses without the variable and writes nothing.
test('B1: unset CONDUCTOR_PLUGIN_DATA_DIR → non-zero exit naming it, no listening, tree untouched', async (t) => {
  const { root } = await scratch(t);
  const before = await snapshotTree(root);
  const r = await runServer(root);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /CONDUCTOR_PLUGIN_DATA_DIR/);
  assert.doesNotMatch(r.stdout, /code-hub listening/);
  assert.deepEqual(await snapshotTree(root), before);
  assert.equal(await exists(path.join(root, '.code-conductor')), false);
});

// Invariant: a migration refusal blocks boot, losslessly.
test('B2: legacy store plus a non-empty data dir → non-zero exit naming both paths, nothing changed', async (t) => {
  const { root, legacy } = await scratch(t);
  const dataDir = dataDirIn(root);
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, 'state.json'), '{"apps":{}}');
  const before = await snapshotTree(root);
  const r = await runServer(root, { CONDUCTOR_PLUGIN_DATA_DIR: dataDir });
  assert.notEqual(r.code, 0);
  assert.ok(r.stderr.includes(legacy) && r.stderr.includes(dataDir), r.stderr);
  assert.doesNotMatch(r.stdout, /code-hub listening/);
  assert.deepEqual(await snapshotTree(root), before);
});

// Invariant: nothing reads or writes the data dir before the migration — the hub
// lists an app registered only in the legacy store, serves the legacy
// hub-settings (a non-default value, so a pre-migration read cached as the
// default would fail), and the relay dir lands in the data dir.
// (An explicit `port: 0` is OS-assigned: only an omitted port defaults to 7000.)
test('B3: start() migrates the legacy store before any read or write of the data dir', async (t) => {
  const root = await mkRoot({ bridgeFallback: true }); // writes no hub-settings: the default (true) applies
  t.after(() => rmRoot(root));
  process.env.CODEHUB_CLOUDFLARED_BIN = fakeCloudflaredBin;
  process.env.CODEHUB_TAILSCALE_BIN = fakeTailscaleBin;
  await mkProject(root, 'reg'); // a manifest-less dir, so it is listed only through its registration
  const legacy = path.join(root, '.code-hub');
  await fs.mkdir(legacy);
  await fs.writeFile(path.join(legacy, 'registrations.json'), JSON.stringify({ reg: { start: 'true' } }));
  await fs.writeFile(path.join(legacy, 'hub-settings.json'), JSON.stringify({ bridgeFallback: false })); // differs from the default
  const server = await start({ port: 0, host: '127.0.0.1' });
  t.after(() => new Promise((r) => server.close(r)));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/apps`);
  const apps = await res.json();
  assert.ok((apps.apps ?? apps).some((a) => a.id === 'reg'), JSON.stringify(apps));
  assert.equal(hubSettings.get().bridgeFallback, false, 'the legacy hub-settings are the effective ones');
  assert.equal(await exists(legacy), false);
  assert.equal(await exists(path.join(dataDirIn(root), 'relay', 'relay.json')), true, 'code-hub provisioned its rendezvous file in the data dir');
});
