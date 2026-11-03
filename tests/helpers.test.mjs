import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { MIN_FIXED_PORT } from '../src/projects.js';
import { nonEphemeralPort, FIXED_PORT_SKIP, PORT_CLAIM_DIR, PORT_RANGE_FILE } from './helpers.mjs';

const exists = (p) => fs.access(p).then(() => true, () => false);

test('nonEphemeralPort hands out distinct, claimed, non-ephemeral ports and releases the claims', { skip: FIXED_PORT_SKIP }, async (t) => {
  // Read independently of the helper's own parsing.
  const lo = Number(readFileSync(PORT_RANGE_FILE, 'utf8').trim().split(/\s+/)[0]);
  const ports = [];
  await t.test('while the owning test runs', async (st) => {
    ports.push(await nonEphemeralPort(st), await nonEphemeralPort(st));
    // Distinct: two callers never share a port (the claim file is per port).
    assert.notEqual(ports[0], ports[1]);
    for (const port of ports) {
      // Below the ephemeral range: the automatic allocator can never hand it out.
      assert.ok(port < lo, `${port} is below ${lo}`);
      // A valid Settings/manifest port.
      assert.ok(port >= MIN_FIXED_PORT, `${port} >= ${MIN_FIXED_PORT}`);
      // Claimed: other callers (concurrent runs) skip it until release.
      assert.equal(await exists(path.join(PORT_CLAIM_DIR, String(port))), true);
    }
  });
  // Released: the owning test's end frees the claim for reuse.
  for (const port of ports) assert.equal(await exists(path.join(PORT_CLAIM_DIR, String(port))), false);
});
