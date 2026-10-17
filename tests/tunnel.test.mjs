import test from 'node:test';
import assert from 'node:assert/strict';
import * as tunnel from '../src/tunnel.js';
import { qrSvg } from '../src/qr.js';
import { fakeCloudflaredBin, waitFor, pidAlive } from './helpers.mjs';

test('available() reflects whether the binary runs', async () => {
  process.env.CODEHUB_CLOUDFLARED_BIN = fakeCloudflaredBin;
  assert.equal(await tunnel.available(), true);
  process.env.CODEHUB_CLOUDFLARED_BIN = '/no/such/cloudflared-xyz';
  assert.equal(await tunnel.available(), false);
});

test('startTunnel captures the trycloudflare URL and stopTunnel kills it', async () => {
  process.env.CODEHUB_CLOUDFLARED_BIN = fakeCloudflaredBin;
  const { url, pid } = await tunnel.startTunnel(12345);
  assert.match(url, /^https:\/\/[\w-]+\.trycloudflare\.com$/);
  assert.ok(pidAlive(pid));
  tunnel.stopTunnel(pid);
  await waitFor(() => !pidAlive(pid));
});

test('startTunnel rejects with a clear message when the binary is missing', async () => {
  process.env.CODEHUB_CLOUDFLARED_BIN = '/no/such/cloudflared-xyz';
  await assert.rejects(tunnel.startTunnel(12345), /not found|not available|ENOENT/);
});

test('qrSvg renders an inline SVG for a URL', async () => {
  const svg = await qrSvg('https://fake-tunnel.trycloudflare.com');
  assert.match(svg, /<svg/);
  assert.match(svg, /<\/svg>/);
});

// Invariant: a wedged cloudflared answers "not available" within the probe's
// bound instead of hanging the caller (a share would hold its app's one share
// slot for as long as this takes).
test('available() reports false for a binary that never answers, within its timeout', async (t) => {
  process.env.CODEHUB_CLOUDFLARED_BIN = fakeCloudflaredBin;
  process.env.FAKE_CLOUDFLARED_MODE = 'hang';
  t.after(() => { delete process.env.FAKE_CLOUDFLARED_MODE; });
  const t0 = Date.now();
  assert.equal(await tunnel.available({ timeoutMs: 300 }), false);
  assert.ok(Date.now() - t0 < tunnel.PROBE_TIMEOUT_MS, 'answered within the bound, not left hanging');
  assert.ok(tunnel.PROBE_TIMEOUT_MS > 0 && Number.isFinite(tunnel.PROBE_TIMEOUT_MS));
});
