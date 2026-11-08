import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createServer } from '../server.js';
import * as appManager from '../src/appManager.js';
import { OUTPUT_CAP, CRASH_TAIL_CHARS } from '../src/runner.js';
import { appSettingsFile } from '../src/appSettings.js';
import { unregisterInMemory } from '../src/projects.js';
import { callTool } from './mcpClient.mjs';
import { assertTextCovers, assertListText } from './textCover.mjs';
import {
  mkRoot, rmRoot, mkProject, mkWorktree, waitFor, fakeAppCmd, fakeCloudflaredBin, fakeTailscaleBin,
  dataDirIn, writeRegistrations, useConductorOverlay, resetConductorOverlay, nonEphemeralPort, FIXED_PORT_SKIP,
} from './helpers.mjs';

// Boots a server over a fresh scratch root. `setup(root)` creates projects
// before init(). Cleanup stops every app the test left running.
async function boot(t, setup) {
  process.env.CODEHUB_TAILSCALE_BIN = fakeTailscaleBin;
  process.env.CODEHUB_CLOUDFLARED_BIN = fakeCloudflaredBin;
  const root = await mkRoot();
  await setup?.(root);
  await appManager.init();
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    const { apps } = await appManager.list();
    for (const a of apps) await appManager.unshare(a.id).catch(() => {});
    for (const a of apps) await appManager.stop(a.id).catch(() => {});
    server.close();
    await rmRoot(root);
  });
  return { root, base };
}

const json = (base, tool, args) => callTool(base, tool, args, { format: 'json' });
const prose = (base, tool, args) => callTool(base, tool, args, { format: 'text' });
const listJson = async (base) => (await json(base, 'list_apps', {})).body.structured;
const appOf = (list, id) => list.apps.find((a) => a.id === id);
const isReady = (base, id) => async () => ['ready', 'running'].includes(appOf(await listJson(base), id)?.status);
const quiet = (t) => {
  const real = console.error;
  console.error = () => {};
  t.after(() => { console.error = real; });
};

// Invariant: list_apps' json validates against the declared schema on a
// realistic store: every share kind (LAN with auth on and off, a cloudflared
// tunnel, which is always gated, and tailscale), a crash, a worktree, a registry app, a broken manifest, a
// stale record whose source is gone, hand-edited off-type settings and a
// relay-info object on LAN shares, a failed auto-share, a failed auto-start and a
// default-login share. Its text view covers every field by label.
test('list_apps json validates on a realistic store covering every share kind and app state', async (t) => {
  const cmd = { start: fakeAppCmd() };
  const { root, base } = await boot(t, async (r) => {
    await mkProject(r, 'plain', cmd, { git: true });
    await mkProject(r, 'multi', { ...cmd, name: 'Multi', routes: [{ name: 'Main', path: '/' }, { name: 'Editor', path: '/editor.html' }] });
    await mkProject(r, 'reg', null);
    await writeRegistrations(r, { reg: { start: fakeAppCmd(), port: 3100 } });
    await mkProject(r, 'broken', null);
    await fs.writeFile(path.join(r, 'broken', '.hub.json'), '{ not json');
    await mkWorktree(r, 'plain', 'k1', cmd, { git: true });
    for (const id of ['lan', 'tun-auth', 'lan-open', 'ts', 'gone']) await mkProject(r, id, cmd, { git: true });
    await mkProject(r, 'crashy', { start: fakeAppCmd('crashloud') });
    await mkProject(r, 'autofail', cmd);
    await mkProject(r, 'edited', cmd);
    await fs.writeFile(appSettingsFile(), JSON.stringify({ edited: { username: 7, autoShare: 'lan', port: '80' } }));
  });
  quiet(t);
  t.after(() => { delete process.env.FAKE_CLOUDFLARED_MODE; });

  // A failed auto-start (the broken manifest refuses) and a stored default login for 'lan'.
  await appManager.setAppSettings('broken', { autoStart: true });
  await appManager.autoStartAll();
  await appManager.setAppSettings('lan', { username: 'hubuser', password: 'hubpass' });

  const running = ['lan', 'tun-auth', 'lan-open', 'ts', 'gone', 'crashy'];
  for (const id of running) assert.equal((await json(base, 'start_app', { id })).status, 200);
  for (const id of running.filter((i) => i !== 'crashy')) await waitFor(isReady(base, id));
  await waitFor(async () => appOf(await listJson(base), 'crashy').status === 'crashed');

  await appManager.share('lan', { mode: 'lan', tls: false });
  await appManager.share('tun-auth', { mode: 'tunnel' });
  await appManager.share('lan-open', { mode: 'lan', auth: false, tls: false });
  await appManager.share('ts', { mode: 'tailscale' });
  // A failed auto-share: the app starts, its tunnel cannot come up.
  process.env.FAKE_CLOUDFLARED_MODE = 'fail';
  await appManager.setAppSettings('autofail', { autoShare: { mode: 'tunnel' } });
  assert.equal((await json(base, 'start_app', { id: 'autofail' })).status, 200);
  await waitFor(async () => appOf(await listJson(base), 'autofail').autoShareStatus === 'failed');
  delete process.env.FAKE_CLOUDFLARED_MODE;
  await fs.rm(path.join(root, 'gone'), { recursive: true, force: true });
  // Relay info as hostRelay's infoFor() builds it, seeded onto the live LAN records (no relay runs here).
  const relayUp = { state: 'up', error: null, port: 41500, requestedPort: appManager._record('lan').tunnel.proxyPort, portFallback: false, recovery: null };
  const relayDown = { state: 'down', error: 'connection to the relay lost: reset', port: null, requestedPort: appManager._record('lan-open').tunnel.proxyPort, portFallback: false, recovery: 'retrying' };
  appManager._record('lan').tunnel.relay = relayUp;
  appManager._record('lan-open').tunnel.relay = relayDown;

  const list = await listJson(base); // callTool validated it against the manifest schema
  assert.deepEqual(appOf(list, 'lan').tunnel.relay, relayUp);
  assert.deepEqual(appOf(list, 'lan-open').tunnel.relay, relayDown);
  // output/outputTruncated belong to a crashed app only; a stopped one carries its manifestError as error.
  for (const a of list.apps.filter((x) => x.status !== 'crashed')) {
    assert.equal(a.output, null, `${a.id} output`);
    assert.equal(a.outputTruncated, null, `${a.id} outputTruncated`);
  }
  assert.equal(appOf(list, 'broken').error, appOf(list, 'broken').manifestError);
  const text = (await prose(base, 'list_apps', {})).body.text;
  // The states the coverage check must reach, so no rule is vacuous.
  assert.equal(appOf(list, 'autofail').autoShareStatus, 'failed');
  assert.ok(appOf(list, 'autofail').autoShareError);
  assert.ok(appOf(list, 'broken').autoStartError);
  assert.equal(appOf(list, 'lan').tunnel.passwordIsDefault, true);
  assert.equal(appOf(list, 'lan').settings.hasPassword, true);
  assert.deepEqual(list.funnelPorts.filter((f) => f.holder).map((f) => f.holder), ['ts']);
  assertListText(list, text);
  assert.equal(appOf(list, 'lan').tunnel.kind, 'lan');
  assert.equal(appOf(list, 'tun-auth').tunnel.kind, 'tunnel');
  assert.equal(appOf(list, 'tun-auth').tunnel.auth, true);
  assert.equal(appOf(list, 'lan-open').tunnel.kind, 'lan');
  assert.equal(appOf(list, 'lan-open').tunnel.auth, false);
  assert.equal(appOf(list, 'ts').tunnel.kind, 'tailscale');
  assert.equal(appOf(list, 'gone').sourceMissing, true);
  assert.equal(appOf(list, 'crashy').status, 'crashed');
  assert.equal(appOf(list, 'broken').status, 'stopped');
  assert.ok(appOf(list, 'broken').manifestError);
  assert.equal(appOf(list, 'plain:k1').isWorktree, true);
  assert.equal(appOf(list, 'reg').source, 'registry');
  assert.equal(appOf(list, 'multi').routes.length, 2);
  assert.equal(appOf(list, 'edited').settings.username, 7);
});

// Invariant: json lists every app and text names every one: no row cap.
test('list_apps lists all 30 apps in both formats', async (t) => {
  const ids = Array.from({ length: 30 }, (_, i) => `proj${String(i).padStart(2, '0')}`);
  const { base } = await boot(t, async (r) => { for (const id of ids) await mkProject(r, id, { start: fakeAppCmd() }); });
  assert.deepEqual((await listJson(base)).apps.map((a) => a.id), ids);
  const { text } = (await prose(base, 'list_apps', {})).body;
  for (const id of ids) assert.ok(text.includes(`${id} (`), `text names ${id}`);
});

const crashApp = (bytes) => ({ start: bytes === undefined ? fakeAppCmd('crashloud') : `FAKE_APP_CRASH_BYTES=${bytes} ${fakeAppCmd('crashloud')}` });
const crashed = async (base) => {
  assert.equal((await json(base, 'start_app', { id: 'crashy' })).status, 200);
  await waitFor(async () => appOf(await listJson(base), 'crashy').status === 'crashed');
};

// Invariant: the CRASH_TAIL_CHARS cut lives only in text, which says so and
// names the log; json carries the reason alone plus the whole retained output.
// (REST's `error` still embeds the tail: see the REST test below.)
test('a crashed app: json has the full output, text a labelled tail', async (t) => {
  const { base, root } = await boot(t, (r) => mkProject(r, 'crashy', crashApp()));
  quiet(t);
  await crashed(base);

  const app = appOf(await listJson(base), 'crashy');
  assert.equal(app.error, 'start command exited (code=1, signal=null)');
  assert.ok(app.output.includes('HEAD-MARK') && app.output.includes('TAIL-MARK'));
  assert.equal(app.outputTruncated, false);
  assert.equal(app.output, await fs.readFile(app.logFile, 'utf8'));
  assert.equal(app.logFile, path.join(dataDirIn(root), 'logs', 'crashy.log'));
  await fs.access(app.logFile);

  const { text } = (await prose(base, 'list_apps', {})).body;
  assert.ok(text.includes('TAIL-MARK'));
  assert.ok(text.includes(`last ${CRASH_TAIL_CHARS}`));
  assert.ok(text.includes(app.logFile));
  assert.ok(!text.includes('HEAD-MARK'));
});

// Invariant: the json output is exactly the retained ring (the log's last
// OUTPUT_CAP chars), so any smaller cap on the json path is detectable, and the
// ring's own memory bound is never silent.
test('output beyond the retained ring is flagged outputTruncated', async (t) => {
  const { base } = await boot(t, (r) => mkProject(r, 'crashy', crashApp(OUTPUT_CAP + 4096)));
  quiet(t);
  await crashed(base);
  const app = appOf(await listJson(base), 'crashy');
  assert.equal(app.outputTruncated, true);
  assert.equal(app.output.length, OUTPUT_CAP);
  assert.equal(app.output, (await fs.readFile(app.logFile, 'utf8')).slice(-OUTPUT_CAP));
});

// Invariant: REST and the UI receive exactly today's crash shape: `error`
// embeds the output tail and none of the MCP-only keys appear.
test('GET /api/apps keeps its crash error string and gains no MCP-only keys', async (t) => {
  const { base } = await boot(t, (r) => mkProject(r, 'crashy', crashApp()));
  quiet(t);
  await crashed(base);
  const rest = (await (await fetch(`${base}/api/apps`)).json()).apps.find((a) => a.id === 'crashy');
  assert.ok(rest.error.startsWith('start command exited (code=1, signal=null)\n'));
  assert.ok(rest.error.includes('TAIL-MARK'));
  for (const k of ['output', 'logFile', 'outputTruncated']) assert.ok(!(k in rest), k);
});

// Invariant: text is prose that keeps the field names agents rely on and
// declares its one omission (the QR).
test('list_apps text is prose naming each app, its status and share credentials', async (t) => {
  const { base } = await boot(t, async (r) => {
    await mkProject(r, 'shared', { start: fakeAppCmd() });
    await mkProject(r, 'idle', { start: fakeAppCmd() });
  });
  await json(base, 'start_app', { id: 'shared' });
  await waitFor(isReady(base, 'shared'));
  await appManager.share('shared', { mode: 'tunnel' });
  const tunnel = appOf(await listJson(base), 'shared').tunnel;

  const { text } = (await prose(base, 'list_apps', {})).body;
  assert.throws(() => JSON.parse(text));
  assert.match(text, /idle \("idle"\) — stopped/);
  assert.match(text, /shared \("shared"\) — (ready|running)/);
  assert.ok(text.includes(`password ${tunnel.password}`));
  assert.ok(text.includes(`authUrl ${tunnel.authUrl}`));
  assert.match(text, /qrSvg omitted .* json format/);
  assert.ok(!text.includes('<svg'));
});

// Invariant: the write tools answer the process's real state in both formats,
// and the acknowledgement is prose.
test('start_app and stop_app answer the live record in json and text', async (t) => {
  const { base } = await boot(t, async (r) => {
    await mkProject(r, 'app', { start: fakeAppCmd() });
    await mkProject(r, 'app2', { start: fakeAppCmd() });
  });

  let res = await json(base, 'start_app', { id: 'app' });
  assert.equal(res.body.structured.port, appManager._record('app').port);
  res = await json(base, 'stop_app', { id: 'app' });
  assert.deepEqual(res.body.structured, { id: 'app', status: 'stopped' });
  assert.equal(appManager._record('app'), undefined);

  res = await prose(base, 'start_app', { id: 'app2' });
  const urls = (await appManager.list()).apps.find((a) => a.id === 'app2').urls; // the reply's urls come from the same urlsFor()
  assertTextCovers('start', { ...appManager._record('app2'), urls }, res.body.text);
  assert.ok(res.body.text.includes("'app2'") && res.body.text.includes(String(appManager._record('app2').port)));
  assert.throws(() => JSON.parse(res.body.text));
  res = await prose(base, 'stop_app', { id: 'app2' });
  assertTextCovers('stop', { id: 'app2', status: 'stopped' }, res.body.text);
  assert.equal(appManager._record('app2'), undefined);
});

// Invariant: typed write acks match the on-disk registry.
test('register_app and unregister_app answer the registry state in json and text', async (t) => {
  const { base, root } = await boot(t, async (r) => { await mkProject(r, 'tool', null); await mkProject(r, 'tool2', null); });
  const registry = async () => JSON.parse(await fs.readFile(path.join(dataDirIn(root), 'registrations.json'), 'utf8'));

  let res = await json(base, 'register_app', { id: 'tool', start: 'npm start', name: 'Tool', port: 3100 });
  assert.equal(res.body.structured.source, 'registry');
  assert.equal(res.body.structured.manifest.port, 3100);
  assert.equal((await registry()).tool.port, 3100);
  res = await json(base, 'unregister_app', { id: 'tool' });
  assert.deepEqual(res.body.structured, { id: 'tool', registered: false });
  assert.ok(!('tool' in await registry()));

  const args2 = { id: 'tool2', start: 'npm start', name: 'Two', port: 3200 };
  const rec2 = (await json(base, 'register_app', args2)).body.structured;
  await json(base, 'unregister_app', { id: 'tool2' });
  res = await prose(base, 'register_app', args2);
  assertTextCovers('register', rec2, res.body.text);
  assert.throws(() => JSON.parse(res.body.text));
  assert.ok('tool2' in await registry());
  res = await prose(base, 'unregister_app', { id: 'tool2' });
  assertTextCovers('unregister', { id: 'tool2', registered: false }, res.body.text);
  assert.ok(!('tool2' in await registry()));
});

// Invariant: every refusal path maps to {error, code, details?} with a stable
// code, identically in both formats; machine extras sit in `details`.
test('refusals carry a stable code and details, the same in json and text', { skip: FIXED_PORT_SKIP }, async (t) => {
  const { root, base } = await boot(t, async (r) => {
    await mkProject(r, 'broken', null);
    await fs.writeFile(path.join(r, 'broken', '.hub.json'), '{ not json');
    await mkProject(r, 'hasman', { start: 'x' });
    await mkProject(r, 'idle', { start: fakeAppCmd() });
    await mkProject(r, 'tool', null);
  });
  quiet(t);
  const port = await nonEphemeralPort(t);
  await fs.writeFile(path.join(root, 'idle', '.hub.json'), JSON.stringify({ start: fakeAppCmd(), port }));
  await mkProject(root, 'twin', { start: fakeAppCmd(), port });

  const expectRefusal = async (tool, args, code, { error, details } = {}) => {
    const [j, x] = [await json(base, tool, args), await prose(base, tool, args)];
    assert.equal(j.status, 200);
    assert.deepEqual(j.body, x.body, `${tool} ${JSON.stringify(args)}: same body in both formats`);
    assert.equal(j.body.code, code, `${tool} ${JSON.stringify(args)}`);
    if (error) assert.match(j.body.error, error);
    if (details) assert.deepEqual(j.body.details, details);
    else assert.ok(!('details' in j.body));
  };

  await expectRefusal('nope', {}, 'TOOL_UNKNOWN');
  await expectRefusal('toString', {}, 'TOOL_UNKNOWN');
  await expectRefusal('start_app', {}, 'ARGS_INVALID', { error: /id is required/ });
  await expectRefusal('stop_app', {}, 'ARGS_INVALID');
  await expectRefusal('unregister_app', { id: '' }, 'ARGS_INVALID');
  await expectRefusal('register_app', { id: '../x', start: 'x' }, 'ARGS_INVALID');
  await expectRefusal('start_app', { id: 'ghost' }, 'APP_UNKNOWN');
  await expectRefusal('start_app', { id: 'broken' }, 'MANIFEST_INVALID');
  await expectRefusal('register_app', { id: 'tool', start: 'x', port: 80 }, 'MANIFEST_INVALID', { error: /"port" must be an integer between 1024 and 65535/ });
  await expectRefusal('stop_app', { id: 'idle' }, 'NOT_RUNNING');
  await expectRefusal('register_app', { id: 'missing-dir', start: 'x' }, 'DIR_NOT_FOUND');
  await expectRefusal('register_app', { id: 'a:b', start: 'x' }, 'DIR_NOT_FOUND');
  await expectRefusal('register_app', { id: 'hasman', start: 'x' }, 'MANIFEST_EXISTS');
  await expectRefusal('unregister_app', { id: 'tool' }, 'NOT_REGISTERED');

  // ALREADY_RUNNING and PORT_IN_USE with a holder: two apps pinned to one port.
  await json(base, 'start_app', { id: 'idle' });
  await expectRefusal('start_app', { id: 'idle' }, 'ALREADY_RUNNING');
  await expectRefusal('start_app', { id: 'twin' }, 'PORT_IN_USE', { details: { port, holder: 'idle' } });
  await json(base, 'stop_app', { id: 'idle' });

  // PORT_IN_USE with no holder: a socket this test itself holds on the port,
  // bound once the stopped app has released it.
  const held = net.createServer();
  await waitFor(() => new Promise((r) => { held.once('error', () => r(false)); held.listen(port, '0.0.0.0', () => r(true)); }));
  t.after(() => held.close());
  await expectRefusal('start_app', { id: 'twin' }, 'PORT_IN_USE', { details: { port } });
  held.close();

  // INTERNAL: an unreadable registry (a directory in its place).
  const registryPath = path.join(dataDirIn(root), 'registrations.json');
  await fs.rm(registryPath, { force: true });
  await fs.mkdir(registryPath);
  try {
    await expectRefusal('unregister_app', { id: 'tool' }, 'INTERNAL');
    await expectRefusal('register_app', { id: 'tool', start: 'x' }, 'INTERNAL');
  } finally {
    await fs.rm(registryPath, { recursive: true, force: true }); // the boot cleanup lists apps
  }
});

// Invariant: the host-conductor refusal has its own code, and the always-on row
// fits the schema.
test('the embedded host conductor: start and stop are APP_ALWAYS_ON, list_apps validates', async (t) => {
  const { base } = await boot(t, async (r) => {
    await mkProject(r, 'code-conductor', { start: fakeAppCmd() });
    process.env.CONDUCTOR_PROJECT_DIR = path.join(r, 'code-conductor');
    await useConductorOverlay([]);
  });
  t.after(() => { resetConductorOverlay(); unregisterInMemory('code-conductor'); delete process.env.CONDUCTOR_PROJECT_DIR; });

  for (const tool of ['start_app', 'stop_app']) {
    const res = await json(base, tool, { id: 'code-conductor' });
    assert.equal(res.body.code, 'APP_ALWAYS_ON');
  }
  const app = appOf(await listJson(base), 'code-conductor');
  assert.equal(app.alwaysOn, true);
  assert.equal(app.status, 'running');
  assertListText(await listJson(base), (await prose(base, 'list_apps', {})).body.text); // the alwaysOn row, in text
});

// Invariant: a missing format is answered as text (old cc); an unknown one is
// refused, not guessed; malformed envelopes are transport 400s.
test('envelope: format defaults to text, bad format and missing tool are 400s', async (t) => {
  const { base } = await boot(t);
  let res = await callTool(base, 'list_apps', {});
  assert.equal(typeof res.body.text, 'string');
  res = await callTool(base, 'list_apps', {}, { format: 'xml' });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'FORMAT_INVALID');
  assert.deepEqual(res.body.details, { format: 'xml' });
  res = await callTool(base, undefined, {});
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'REQUEST_INVALID');
  const raw = await fetch(base + '/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not valid json' });
  assert.equal(raw.status, 400);
  assert.ok((await raw.json()).error);
});

// Invariant: a hand-edited integer-string port starts the app on that integer
// (so the reply validates), and any other stored value, an out-of-range integer
// included, refuses before a spawn with SETTINGS_INVALID, identically in both formats.
test('start_app reads a stored port string as an integer and refuses garbage', { skip: FIXED_PORT_SKIP }, async (t) => {
  const { base } = await boot(t, async (r) => { await mkProject(r, 'app', { start: fakeAppCmd() }); });
  const port = await nonEphemeralPort(t);
  const setPort = (v) => fs.writeFile(appSettingsFile(), JSON.stringify({ app: { port: v } }));

  await setPort(String(port));
  const res = await json(base, 'start_app', { id: 'app' }); // callTool validated the reply against the schema
  assert.equal(res.body.structured.port, port);
  assert.equal(res.body.structured.fixedPort, port);
  assert.equal(appManager._record('app').port, port);
  await json(base, 'stop_app', { id: 'app' });

  for (const bad of ['abc', 99999, '99999', '041500']) {
    await setPort(bad);
    const [j, x] = [await json(base, 'start_app', { id: 'app' }), await prose(base, 'start_app', { id: 'app' })];
    assert.deepEqual(j.body, x.body);
    assert.equal(j.body.code, 'SETTINGS_INVALID', String(bad));
    assert.deepEqual(j.body.details, { field: 'port', value: bad });
    assert.ok(j.body.error.includes(`'app'`) && j.body.error.includes(JSON.stringify(bad)));
    assert.equal(appManager._record('app'), undefined, 'refused before any spawn');
  }
});

// Invariant: the post-spawn EADDRINUSE refusal (a child that loses the bind
// race after a clean pre-check) is PORT_IN_USE with details {port}, in both formats.
test('a fixed-port child that hits EADDRINUSE after a clean pre-check is PORT_IN_USE', { skip: FIXED_PORT_SKIP }, async (t) => {
  const port = await nonEphemeralPort(t);
  const { base } = await boot(t, async (r) => {
    // `flaky` fails once with EADDRINUSE; the marker is per attempt, so each call below is a first run.
    await mkProject(r, 'app', { start: fakeAppCmd('flaky', path.join(r, 'flaky-marker')), port });
  });
  quiet(t);
  const j = await json(base, 'start_app', { id: 'app' });
  await fs.rm(path.join(process.env.PROJECTS_ROOT, 'flaky-marker'), { force: true });
  const x = await prose(base, 'start_app', { id: 'app' });
  assert.deepEqual(j.body, x.body);
  assert.equal(j.body.code, 'PORT_IN_USE');
  assert.deepEqual(j.body.details, { port });
  assert.equal(appManager._record('app'), undefined);
});
