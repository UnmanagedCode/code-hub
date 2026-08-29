import test from 'node:test';
import assert from 'node:assert/strict';
import * as tailscale from '../src/tailscale.js';
import { fakeTailscaleBin, waitFor, pidAlive } from './helpers.mjs';

test('available() reflects a running daemon with a MagicDNS name', async () => {
  process.env.CODEHUB_TAILSCALE_BIN = fakeTailscaleBin;
  delete process.env.FAKE_TAILSCALE_MODE;
  assert.equal(await tailscale.available(), true);

  process.env.CODEHUB_TAILSCALE_BIN = '/no/such/tailscale-xyz';
  assert.equal(await tailscale.available(), false);

  // Daemon reachable but not logged in: no MagicDNS name, so no URL exists —
  // this must read as unavailable, not as available-with-a-broken-URL.
  process.env.CODEHUB_TAILSCALE_BIN = fakeTailscaleBin;
  process.env.FAKE_TAILSCALE_MODE = 'logged-out';
  assert.equal(await tailscale.available(), false);
  delete process.env.FAKE_TAILSCALE_MODE;
});

test('magicDnsName strips the trailing dot tailscale reports', async () => {
  process.env.CODEHUB_TAILSCALE_BIN = fakeTailscaleBin;
  delete process.env.FAKE_TAILSCALE_MODE;
  assert.equal(await tailscale.magicDnsName(), 'fake-node.example-tailnet.ts.net');
});

test('startFunnel derives the URL from status and stopFunnel kills the child', async () => {
  process.env.CODEHUB_TAILSCALE_BIN = fakeTailscaleBin;
  delete process.env.FAKE_TAILSCALE_MODE;
  const { url, pid } = await tailscale.startFunnel(12345);
  // Exactly the MagicDNS name: trailing dot stripped, no trailing path.
  assert.equal(url, 'https://fake-node.example-tailnet.ts.net');
  assert.ok(pidAlive(pid));
  tailscale.stopFunnel(pid);
  await waitFor(() => !pidAlive(pid));
});

test('startFunnel rejects with a clear message when the binary is missing', async () => {
  process.env.CODEHUB_TAILSCALE_BIN = '/no/such/tailscale-xyz';
  await assert.rejects(tailscale.startFunnel(12345), /not ready|not found|not available|ENOENT/);
});

// A tailnet that refuses Funnel (no nodeAttr, HTTPS off, 443 already taken)
// shows up only as a nonzero exit. Resolving a URL anyway would hand back a
// public address that never answers — the exact silent failure the readiness
// check exists to prevent.
test('startFunnel rejects, carrying tailscale stderr, when the funnel is refused', async () => {
  process.env.CODEHUB_TAILSCALE_BIN = fakeTailscaleBin;
  process.env.FAKE_TAILSCALE_MODE = 'denied';
  let resolved = null;
  await assert.rejects(
    tailscale.startFunnel(12345).then((r) => { resolved = r; }),
    (e) => {
      assert.match(e.message, /Funnel is not enabled on your tailnet/);
      assert.match(e.message, /exited \(code=1\)/);
      return true;
    },
  );
  assert.equal(resolved, null, 'no URL is handed back for a refused funnel');
  delete process.env.FAKE_TAILSCALE_MODE;
});
