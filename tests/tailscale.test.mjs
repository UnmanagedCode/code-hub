import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import * as tailscale from '../src/tailscale.js';
import { fakeTailscaleBin, waitFor, pidAlive, tailscaleEvents, funnelEvents } from './helpers.mjs';

// Fresh temp file per use, cleaned up by the caller's t.after.
const tmpFile = async (name) => path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'codehub-ts-')), name);

test('available() is true only for a running daemon that also has a MagicDNS name', async (t) => {
  t.after(() => { delete process.env.FAKE_TAILSCALE_MODE; });
  process.env.CODEHUB_TAILSCALE_BIN = fakeTailscaleBin;
  delete process.env.FAKE_TAILSCALE_MODE;
  assert.equal(await tailscale.available(), true);

  process.env.CODEHUB_TAILSCALE_BIN = '/no/such/tailscale-xyz';
  assert.equal(await tailscale.available(), false);

  // The two conjuncts are isolated deliberately: each of these fixtures fails
  // exactly ONE of them, so neither arm of the check can be dropped unnoticed.
  process.env.CODEHUB_TAILSCALE_BIN = fakeTailscaleBin;

  // Not logged in, but the node's name is still cached — only BackendState
  // disqualifies it.
  process.env.FAKE_TAILSCALE_MODE = 'logged-out';
  assert.equal(await tailscale.available(), false);

  // Daemon up and Running, but MagicDNS is off, so no URL exists at all.
  // Reading this as available would mint a share URL of `https://null`.
  process.env.FAKE_TAILSCALE_MODE = 'no-magicdns';
  assert.equal(await tailscale.available(), false);
  assert.equal(await tailscale.magicDnsName(), null);
  await assert.rejects(tailscale.startFunnel(12345, 443), /not ready/);
});

test('magicDnsName strips the trailing dot tailscale reports', async () => {
  process.env.CODEHUB_TAILSCALE_BIN = fakeTailscaleBin;
  delete process.env.FAKE_TAILSCALE_MODE;
  assert.equal(await tailscale.magicDnsName(), 'fake-node.example-tailnet.ts.net');
});

test('startFunnel derives the URL from status and stopFunnel kills the child', async () => {
  process.env.CODEHUB_TAILSCALE_BIN = fakeTailscaleBin;
  delete process.env.FAKE_TAILSCALE_MODE;
  const { url, pid } = await tailscale.startFunnel(12345, 443);
  // Exactly the MagicDNS name: trailing dot stripped, no trailing path.
  assert.equal(url, 'https://fake-node.example-tailnet.ts.net');
  assert.ok(pidAlive(pid));
  tailscale.stopFunnel(pid);
  await waitFor(() => !pidAlive(pid));
});

test('startFunnel rejects with a clear message when the binary is missing', async () => {
  process.env.CODEHUB_TAILSCALE_BIN = '/no/such/tailscale-xyz';
  await assert.rejects(tailscale.startFunnel(12345, 443), /not ready|not found|not available|ENOENT/);
});

// A tailnet that refuses Funnel (no nodeAttr, HTTPS off, the port already taken)
// shows up only as a nonzero exit. Resolving a URL anyway would hand back a
// public address that never answers — the exact silent failure the readiness
// check exists to prevent.
test('startFunnel rejects, carrying tailscale stderr, when the funnel is refused', async () => {
  process.env.CODEHUB_TAILSCALE_BIN = fakeTailscaleBin;
  process.env.FAKE_TAILSCALE_MODE = 'denied';
  let resolved = null;
  await assert.rejects(
    tailscale.startFunnel(12345, 443).then((r) => { resolved = r; }),
    (e) => {
      assert.match(e.message, /Funnel is not enabled on your tailnet/);
      assert.match(e.message, /exited \(code=1\)/);
      return true;
    },
  );
  assert.equal(resolved, null, 'no URL is handed back for a refused funnel');
  delete process.env.FAKE_TAILSCALE_MODE;
});

// The funnel must point at the port it was HANDED (the gated auth proxy), not
// at some other port, and publish on the Funnel port it was asked for.
// Asserted from the argv the fake actually received — the banner it prints is
// canned and would say the right thing regardless.
test('startFunnel passes --https=<funnelPort> and funnels exactly the proxy port', async (t) => {
  const log = await tmpFile('argv.log');
  t.after(async () => { delete process.env.FAKE_TAILSCALE_ARGV_LOG; await fs.rm(path.dirname(log), { recursive: true, force: true }); });
  process.env.CODEHUB_TAILSCALE_BIN = fakeTailscaleBin;
  delete process.env.FAKE_TAILSCALE_MODE;
  process.env.FAKE_TAILSCALE_ARGV_LOG = log;

  const { pid } = await tailscale.startFunnel(54321, 8443);
  tailscale.stopFunnel(pid);
  await waitFor(() => !pidAlive(pid));

  const [invoked] = funnelEvents(await tailscaleEvents(log), 'invoke');
  assert.ok(invoked, 'the funnel subcommand was invoked');
  assert.deepEqual(invoked.argv.filter((a) => a.startsWith('--https')), ['--https=8443']);
  assert.equal(invoked.argv[invoked.argv.length - 1], 'http://localhost:54321');
});

// 443 is the https default and never appears in a URL; any other Funnel port
// must, or the link points at a port nothing serves.
test('a non-443 Funnel port is in the URL; 443 has no suffix', async (t) => {
  process.env.CODEHUB_TAILSCALE_BIN = fakeTailscaleBin;
  delete process.env.FAKE_TAILSCALE_MODE;
  for (const [funnelPort, url] of [
    [443, 'https://fake-node.example-tailnet.ts.net'],
    [8443, 'https://fake-node.example-tailnet.ts.net:8443'],
    [10000, 'https://fake-node.example-tailnet.ts.net:10000'],
  ]) {
    const started = await tailscale.startFunnel(12345, funnelPort);
    t.after(() => { try { process.kill(-started.pid, 'SIGKILL'); } catch { /* gone */ } });
    assert.equal(started.url, url);
    tailscale.stopFunnel(started.pid);
    await waitFor(() => !pidAlive(started.pid));
  }
});

// A Funnel port served outside code-hub (the user's own `tailscale serve` or
// `funnel`) is refused by tailscaled, and that must reach the caller in
// tailscale's own words rather than as a URL that serves someone else's app.
test('startFunnel rejects with tailscale\'s words when the Funnel port is held outside code-hub', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codehub-ts-ports-'));
  t.after(async () => { delete process.env.FAKE_TAILSCALE_PORT_DIR; await fs.rm(dir, { recursive: true, force: true }); });
  process.env.CODEHUB_TAILSCALE_BIN = fakeTailscaleBin;
  delete process.env.FAKE_TAILSCALE_MODE;
  process.env.FAKE_TAILSCALE_PORT_DIR = dir;
  await fs.writeFile(path.join(dir, '8443'), String(process.pid)); // a live outside holder

  await assert.rejects(tailscale.startFunnel(12345, 8443), (e) => {
    assert.match(e.message, /listener already exists for port 8443/);
    assert.match(e.message, /exited \(code=1\)/);
    return true;
  });
  // The refusal is per port: another Funnel port still comes up.
  const { pid } = await tailscale.startFunnel(12345, 443);
  tailscale.stopFunnel(pid);
  await waitFor(() => !pidAlive(pid));
});

// The fake must refuse what the real CLI would not run as code-hub means it:
// a fake that ignored `--https` would let a funnel on the wrong port, or on no
// named port at all, pass every test above.
test('the fake refuses a funnel with a missing, malformed, repeated or disallowed --https', async () => {
  const runFake = (argv) => new Promise((resolve) => {
    const p = spawn(fakeTailscaleBin, argv, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FAKE_TAILSCALE_MODE: '' } });
    let stderr = '';
    p.stderr.on('data', (d) => { stderr += d; });
    // A funnel that came up would block forever; never let one hang the test.
    const timer = setTimeout(() => p.kill('SIGKILL'), 5000);
    p.on('exit', (code) => { clearTimeout(timer); resolve({ code, stderr }); });
  });
  const base = ['funnel', '--bg=false', '--yes'];
  const target = 'http://localhost:12345';
  for (const [argv, why] of [
    [[...base, target], /without --https/],
    [[...base, '--https', target], /malformed/],
    [[...base, '--https=abc', target], /malformed/],
    [[...base, '--https=443', '--https=8443', target], /repeated/],
    [[...base, '--https=8080', target], /port 8080 is not allowed for funnel/],
  ]) {
    const { code, stderr } = await runFake(argv);
    assert.notEqual(code, 0, `refused: ${argv.join(' ')}`);
    assert.notEqual(code, null, `exited on its own rather than being killed: ${argv.join(' ')}`);
    assert.match(stderr, why);
  }
});

// stopFunnel signals the process GROUP (`kill(-pid)`), not just the leader.
// The real `tailscale funnel` is a single process today, so the difference is
// invisible against a childless fake — this fixture spawns a child in the same
// group that outlives its parent, so signalling only the leader would leave it.
test('stopFunnel kills the whole process group, not just the leader', async (t) => {
  const pidFile = await tmpFile('child.pid');
  let childPid = null;
  t.after(async () => {
    if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch { /* gone */ } }
    delete process.env.FAKE_TAILSCALE_CHILD_PID_FILE;
    await fs.rm(path.dirname(pidFile), { recursive: true, force: true });
  });
  process.env.CODEHUB_TAILSCALE_BIN = fakeTailscaleBin;
  delete process.env.FAKE_TAILSCALE_MODE;
  process.env.FAKE_TAILSCALE_CHILD_PID_FILE = pidFile;

  const { pid } = await tailscale.startFunnel(12345, 443);
  await waitFor(async () => !!(await fs.readFile(pidFile, 'utf8').catch(() => '')).trim());
  childPid = Number((await fs.readFile(pidFile, 'utf8')).trim());
  assert.ok(pidAlive(childPid), 'the fixture spawned a live child in the funnel process group');

  tailscale.stopFunnel(pid);
  await waitFor(() => !pidAlive(pid));
  await waitFor(() => !pidAlive(childPid)); // fails if only the leader was signalled
  childPid = null;
});

// waitForExit is what keeps a re-share from racing the previous funnel's exit,
// since tailscaled refuses a new funnel on a port an exiting one still holds.
test('waitForExit returns only once the funnel child is actually gone', async (t) => {
  process.env.CODEHUB_TAILSCALE_BIN = fakeTailscaleBin;
  delete process.env.FAKE_TAILSCALE_MODE;
  const { pid } = await tailscale.startFunnel(12345, 443);
  t.after(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } });

  tailscale.stopFunnel(pid);
  await tailscale.waitForExit(pid);
  assert.equal(pidAlive(pid), false, 'the child is dead by the time waitForExit resolves');

  // A pid that is already gone (or absent) resolves PROMPTLY rather than
  // spinning to the 5s timeout — share() awaits this on every re-share, so a
  // full-timeout wait would stall the request by five seconds.
  const t0 = Date.now();
  await tailscale.waitForExit(pid);
  await tailscale.waitForExit(null);
  assert.ok(Date.now() - t0 < 500, `returned promptly for a dead/absent pid (took ${Date.now() - t0}ms)`);
});

// A funnel that ignores SIGTERM must not be waited on forever: the caller is
// about to spawn a replacement, and the old process still holds its Funnel
// port until it dies.
test('waitForExit escalates to SIGKILL when the funnel ignores SIGTERM', async (t) => {
  process.env.CODEHUB_TAILSCALE_BIN = fakeTailscaleBin;
  process.env.FAKE_TAILSCALE_MODE = 'ignore-sigterm';
  t.after(() => { delete process.env.FAKE_TAILSCALE_MODE; });

  const { pid } = await tailscale.startFunnel(12345, 443);
  t.after(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } });

  tailscale.stopFunnel(pid);
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(pidAlive(pid), 'the fixture really does ignore SIGTERM');

  await tailscale.waitForExit(pid, { timeoutMs: 200 });
  await waitFor(() => !pidAlive(pid)); // only a SIGKILL can have done this
});

// The guard on the one path that signals a pid this process did not spawn.
test('looksLikeFunnel tells a funnel child from an unrelated process', async (t) => {
  process.env.CODEHUB_TAILSCALE_BIN = fakeTailscaleBin;
  delete process.env.FAKE_TAILSCALE_MODE;
  const { pid } = await tailscale.startFunnel(12345, 443);
  t.after(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } });

  assert.equal(tailscale.looksLikeFunnel(pid), true);
  assert.equal(tailscale.looksLikeFunnel(process.pid), false, 'this test runner is not a funnel');
  assert.equal(tailscale.looksLikeFunnel(null), false);
});

// Invariant: a wedged `tailscale status` answers "not available" within the
// probe's bound instead of hanging the caller (a share would hold its app's one
// share slot for as long as this takes).
test('available() reports false for a status call that never answers, within its timeout', async (t) => {
  process.env.CODEHUB_TAILSCALE_BIN = fakeTailscaleBin;
  process.env.FAKE_TAILSCALE_MODE = 'hang';
  t.after(() => { delete process.env.FAKE_TAILSCALE_MODE; });
  const t0 = Date.now();
  assert.equal(await tailscale.available({ timeoutMs: 300 }), false);
  assert.ok(Date.now() - t0 < 2000, 'answered within the 300ms bound it was given (plus spawn slack)');
});

// Invariant: with no argument — how list() and share() call it — the probe is
// still bounded, by PROBE_TIMEOUT_MS, so a wedged CLI can neither hang the
// listing nor hold an app's share slot.
test('available() with no argument is bounded by PROBE_TIMEOUT_MS', async (t) => {
  process.env.CODEHUB_TAILSCALE_BIN = fakeTailscaleBin;
  process.env.FAKE_TAILSCALE_MODE = 'hang';
  t.after(() => { delete process.env.FAKE_TAILSCALE_MODE; });
  assert.ok(Number.isFinite(tailscale.PROBE_TIMEOUT_MS) && tailscale.PROBE_TIMEOUT_MS > 0 && tailscale.PROBE_TIMEOUT_MS <= 10_000);
  const t0 = Date.now();
  assert.equal(await tailscale.available(), false);
  const took = Date.now() - t0;
  assert.ok(took >= tailscale.PROBE_TIMEOUT_MS - 50, `gave up only at the bound (${took}ms)`);
  assert.ok(took < tailscale.PROBE_TIMEOUT_MS + 3000, `answered within PROBE_TIMEOUT_MS plus slack (${took}ms)`);
});
