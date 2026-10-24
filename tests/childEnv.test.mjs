import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { childEnv } from '../src/childEnv.js';
import { REPO_ROOT } from './helpers.mjs';

// Invariant: the child environment drops the relay variables under any letter case (Windows env names are case-insensitive) and keeps everything else.
test('childEnv strips the relay variables case-insensitively', (t) => {
  const names = ['CODEHUB_RELAY_SECRET', 'codehub_relay_secret', 'Codehub_Relay_Url', 'CODEHUB_RELAY_URL'];
  for (const n of names) process.env[n] = 'x';
  process.env.CODEHUB_RELAY_SECRETS_ARE_FINE = 'kept';
  t.after(() => { for (const n of [...names, 'CODEHUB_RELAY_SECRETS_ARE_FINE']) delete process.env[n]; });
  const env = childEnv({ PORT: '1234' });
  for (const n of names) assert.equal(n in env, false, n);
  assert.equal(env.CODEHUB_RELAY_SECRETS_ARE_FINE, 'kept');
  assert.equal(env.PORT, '1234');
  assert.equal(env.PATH, process.env.PATH);
});

// Invariant: every child code-hub spawns or execs gets the sanitised environment — no call site falls back to inheriting process.env.
test('every spawn/execFile/execFileSync in src/ passes env: childEnv(…)', () => {
  const dir = path.join(REPO_ROOT, 'src');
  let sites = 0;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const src = readFileSync(path.join(dir, file), 'utf8');
    for (const m of src.matchAll(/\b(?:spawn|execFile|execFileSync)\(/g)) {
      const line = src.slice(src.lastIndexOf('\n', m.index) + 1, m.index);
      if (/^\s*(\/\/|import\b)/.test(line)) continue;
      sites += 1;
      const call = src.slice(m.index, m.index + 400);
      assert.match(call, /env: childEnv\(/, `${file}: ${call.split('\n')[0]}`);
    }
  }
  assert.ok(sites >= 7, `found the call sites (${sites})`);
});
