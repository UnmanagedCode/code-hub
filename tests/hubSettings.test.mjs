import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import * as hubSettings from '../src/hubSettings.js';
import { storeRoot } from '../src/projects.js';
import { mkRoot, rmRoot } from './helpers.mjs';

// A root with no hub-settings file at all.
async function freshRoot(t) {
  const root = await mkRoot({ bridgeFallback: true });
  t.after(() => rmRoot(root));
  return root;
}

const file = () => path.join(storeRoot(), hubSettings.HUB_SETTINGS_FILENAME);
const exists = (p) => fs.access(p).then(() => true, () => false);

// Re-read the file from disk: get() caches per path, so point it at another
// root and back.
async function reread(t, root) {
  const other = await mkRoot({ bridgeFallback: true });
  t.after(() => rmRoot(other));
  hubSettings.get();
  process.env.PROJECTS_ROOT = root;
  return hubSettings.get();
}

// Invariant: with no file, the fallback is on.
test('an absent file reads as the defaults', async (t) => {
  await freshRoot(t);
  assert.deepEqual(hubSettings.get(), { bridgeFallback: true });
  assert.equal(await exists(file()), false, 'reading writes nothing');
});

// Invariant: an update persists — a fresh read from disk returns it — and
// answers with the new settings.
test('an update round-trips through the file', async (t) => {
  const root = await freshRoot(t);
  assert.deepEqual(await hubSettings.update({ bridgeFallback: false }), { bridgeFallback: false });
  assert.deepEqual(hubSettings.get(), { bridgeFallback: false });
  assert.deepEqual(await reread(t, root), { bridgeFallback: false });
  assert.deepEqual(JSON.parse(await fs.readFile(file(), 'utf8')), { bridgeFallback: false });
});

// Invariant: anything but exactly { bridgeFallback: boolean } is refused with
// 400 and writes nothing.
test('an invalid body is a 400 and writes nothing', async (t) => {
  await freshRoot(t);
  for (const body of [{ bridgeFallback: 'no' }, {}, { bridgeFallback: true, extra: 1 }, null, [], 'off']) {
    await assert.rejects(hubSettings.update(body), (e) => e.statusCode === 400, JSON.stringify(body));
  }
  assert.equal(await exists(file()), false);
  assert.deepEqual(hubSettings.get(), { bridgeFallback: true });
});

// Invariant: a broken file never breaks code-hub — it reads as the defaults,
// with a warning naming the file.
test('an invalid file warns and reads as the defaults', async (t) => {
  const root = await freshRoot(t);
  const warn = t.mock.method(console, 'warn', () => {});
  await fs.mkdir(storeRoot(), { recursive: true });
  for (const raw of ['{ broken', '[]', '{"bridgeFallback":"off"}']) {
    await fs.writeFile(file(), raw);
    const before = warn.mock.callCount();
    assert.deepEqual(await reread(t, root), { bridgeFallback: true }, raw);
    assert.equal(warn.mock.callCount(), before + 1, raw);
    assert.ok(warn.mock.calls.at(-1).arguments[0].includes(file()), raw);
  }
});

// Invariant: concurrent updates land one at a time, in call order — the file
// and the cache both end on the last one.
test('concurrent updates land in order', async (t) => {
  const root = await freshRoot(t);
  const results = await Promise.all([
    hubSettings.update({ bridgeFallback: false }),
    hubSettings.update({ bridgeFallback: true }),
    hubSettings.update({ bridgeFallback: false }),
  ]);
  assert.deepEqual(results.map((r) => r.bridgeFallback), [false, true, false]);
  assert.deepEqual(hubSettings.get(), { bridgeFallback: false });
  assert.deepEqual(await reread(t, root), { bridgeFallback: false });
});
