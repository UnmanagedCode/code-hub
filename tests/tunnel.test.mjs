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
