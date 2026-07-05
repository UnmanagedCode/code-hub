import test from 'node:test';
import assert from 'node:assert/strict';
import * as tunnel from '../src/tunnel.js';
import { waitFor, pidAlive } from './helpers.mjs';

// Gated real-dependency smoke test: exercises the ACTUAL cloudflared binary.
// Opt in with RUN_REAL_CLOUDFLARED=1 (needs network + cloudflared installed).
const run = process.env.RUN_REAL_CLOUDFLARED === '1';

test('real cloudflared quick tunnel yields a trycloudflare URL', { skip: !run }, async () => {
  delete process.env.CODEHUB_CLOUDFLARED_BIN; // use the real binary in PATH
  assert.equal(await tunnel.available(), true);
  const { url, pid } = await tunnel.startTunnel(65535);
  assert.match(url, /trycloudflare\.com$/);
  tunnel.stopTunnel(pid);
  await waitFor(() => !pidAlive(pid), { timeout: 5000 });
});
