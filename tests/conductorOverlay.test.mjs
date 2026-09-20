import test from 'node:test';
import assert from 'node:assert/strict';
import * as conductorProjects from '../src/conductorProjects.js';

// The overlay's whole contract is "never let the conductor break the
// listing": every failure keeps the last good answer, every unusable row is
// dropped, and nothing ever throws at a caller. These drive the module
// directly through its fetch/clock seams — no socket, no sleep.

const ok = (rows) => ({ ok: true, status: 200, json: async () => rows });
const row = (name, dir, extra = {}) => ({ name, path: dir, workspace: null, system: 'local', remoteId: null, ...extra });

function embed() {
  process.env.CONDUCTOR_PLUGIN_ID = 'code-hub';
  process.env.CONDUCTOR_URL = 'http://127.0.0.1:1';
}

function cleanup() {
  conductorProjects._reset();
  delete process.env.CONDUCTOR_PLUGIN_ID;
  delete process.env.CONDUCTOR_URL;
  delete process.env.CONDUCTOR_PROJECT_DIR;
}

// Land a known-good snapshot, then make the next fetch fail the given way.
async function goodThen(failingImpl) {
  embed();
  conductorProjects._setFetchImpl(async () => ok([row('alpha', '/trees/alpha')]));
  await conductorProjects.refresh();
  assert.equal(conductorProjects.snapshot().get('alpha'), '/trees/alpha', 'setup: first fetch must land');
  conductorProjects._setFetchImpl(failingImpl);
  await conductorProjects.refresh();
}

test('a successful fetch maps each local project name to its recorded tree', async (t) => {
  t.after(cleanup);
  embed();
  conductorProjects._setFetchImpl(async () => ok([row('alpha', '/trees/alpha'), row('beta', '/elsewhere/beta')]));

  await conductorProjects.refresh();
  assert.deepEqual([...conductorProjects.snapshot()], [['alpha', '/trees/alpha'], ['beta', '/elsewhere/beta']]);
});

test('not embedded: no fetch is ever made and the snapshot stays empty', async (t) => {
  t.after(cleanup);
  delete process.env.CONDUCTOR_PLUGIN_ID;
  delete process.env.CONDUCTOR_URL;
  let calls = 0;
  conductorProjects._setFetchImpl(async () => { calls++; return ok([row('alpha', '/trees/alpha')]); });

  await conductorProjects.refresh();
  conductorProjects.snapshot();
  conductorProjects.snapshot();
  assert.equal(calls, 0);
  assert.equal(conductorProjects.snapshot().size, 0);
});

test('CONDUCTOR_URL alone (no plugin id) is not embedded — still no fetch', async (t) => {
  t.after(cleanup);
  delete process.env.CONDUCTOR_PLUGIN_ID;
  process.env.CONDUCTOR_URL = 'http://127.0.0.1:1';
  let calls = 0;
  conductorProjects._setFetchImpl(async () => { calls++; return ok([]); });

  await conductorProjects.refresh();
  assert.equal(calls, 0);
});

test('a non-2xx response keeps the last good snapshot', async (t) => {
  t.after(cleanup);
  await goodThen(async () => ({ ok: false, status: 503, json: async () => [] }));
  assert.equal(conductorProjects.snapshot().get('alpha'), '/trees/alpha');
});

test('a body that is not JSON keeps the last good snapshot', async (t) => {
  t.after(cleanup);
  await goodThen(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token c'); } }));
  assert.equal(conductorProjects.snapshot().get('alpha'), '/trees/alpha');
});

test('a JSON body that is not an array keeps the last good snapshot', async (t) => {
  t.after(cleanup);
  await goodThen(async () => ok({ projects: [row('beta', '/trees/beta')] }));
  assert.deepEqual([...conductorProjects.snapshot()], [['alpha', '/trees/alpha']]);
});

test('a refused connection keeps the last good snapshot', async (t) => {
  t.after(cleanup);
  await goodThen(async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); });
  assert.equal(conductorProjects.snapshot().get('alpha'), '/trees/alpha');
});

test('a timeout keeps the last good snapshot, and refresh() still resolves', async (t) => {
  t.after(cleanup);
  // What AbortSignal.timeout() produces when the budget runs out, raised
  // without waiting out a real 2s.
  await goodThen(async (_url, opts) => {
    assert.ok(opts.signal instanceof AbortSignal, 'the fetch must carry the timeout signal');
    throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  });
  assert.equal(conductorProjects.snapshot().get('alpha'), '/trees/alpha');
});

test('unusable rows are dropped one by one; the usable ones in the same body survive', async (t) => {
  t.after(cleanup);
  embed();
  conductorProjects._setFetchImpl(async () => ok([
    null,
    'not-an-object',
    row('remote-tree', '/trees/remote', { system: 'docker' }),   // not on this machine
    row('degraded', ''),                                          // cc's unparseable-record row
    row('relative', 'trees/relative'),                            // not absolute
    row('.hidden', '/trees/hidden'),                              // dot-leading, like the root scan skips
    row('has:qualifier', '/trees/qualified'),                     // ':' is reserved for worktree ids
    row('nested/name', '/trees/nested'),                          // not a single path segment
    row('', '/trees/empty'),
    row(42, '/trees/number'),
    row('alpha', '/trees/alpha'),                                 // the one good row
  ]));

  await conductorProjects.refresh();
  assert.deepEqual([...conductorProjects.snapshot()], [['alpha', '/trees/alpha']]);
});

test('concurrent refreshes coalesce into a single conductor call', async (t) => {
  t.after(cleanup);
  embed();
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  conductorProjects._setFetchImpl(async () => { calls++; await gate; return ok([row('alpha', '/trees/alpha')]); });

  const a = conductorProjects.refresh();
  const b = conductorProjects.refresh();
  conductorProjects.snapshot(); // a read during the flight must not add a call
  release();
  await Promise.all([a, b]);
  assert.equal(calls, 1);
  assert.equal(conductorProjects.snapshot().get('alpha'), '/trees/alpha');
});

test('snapshot() refetches only once the TTL has elapsed since the last attempt', async (t) => {
  t.after(cleanup);
  embed();
  let clock = 1_000_000;
  conductorProjects._setClock(() => clock);
  let calls = 0;
  conductorProjects._setFetchImpl(async () => { calls++; return ok([row('alpha', `/trees/alpha${calls}`)]); });

  await conductorProjects.refresh();
  assert.equal(calls, 1);

  clock += 4999;
  conductorProjects.snapshot();
  conductorProjects.snapshot();
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 1, 'within the TTL the snapshot is served without touching the conductor');

  clock += 1;
  conductorProjects.snapshot();
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 2, 'past the TTL the next read fires a refresh');
  assert.equal(conductorProjects.snapshot().get('alpha'), '/trees/alpha2');
});

test('a failed attempt also re-arms the TTL, so a down conductor is polled at that cadence', async (t) => {
  t.after(cleanup);
  embed();
  let clock = 1_000_000;
  conductorProjects._setClock(() => clock);
  let calls = 0;
  conductorProjects._setFetchImpl(async () => { calls++; throw new Error('down'); });

  await conductorProjects.refresh();
  assert.equal(calls, 1);
  clock += 4999;
  conductorProjects.snapshot();
  conductorProjects.snapshot();
  conductorProjects.snapshot();
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 1);
});

test('snapshot() never throws and never blocks, even when the transport throws synchronously', async (t) => {
  t.after(cleanup);
  embed();
  conductorProjects._setFetchImpl(() => { throw new Error('synchronous transport explosion'); });

  assert.equal(conductorProjects.snapshot().size, 0);
  await conductorProjects.refresh();
  assert.equal(conductorProjects.snapshot().size, 0);
});

test('the injected CONDUCTOR_PROJECT_DIR overrides the conductor\'s record of its OWN project only', async (t) => {
  t.after(cleanup);
  embed();
  process.env.CONDUCTOR_PROJECT_DIR = '/running/code-conductor-worktree';
  conductorProjects._setFetchImpl(async () => ok([
    row('code-conductor', '/trees/code-conductor'),
    row('alpha', '/trees/alpha'),
  ]));

  await conductorProjects.refresh();
  assert.equal(conductorProjects.snapshot().get('code-conductor'), '/running/code-conductor-worktree');
  assert.equal(conductorProjects.snapshot().get('alpha'), '/trees/alpha');
});

test('with no CONDUCTOR_PROJECT_DIR the conductor\'s own recorded tree is used as-is', async (t) => {
  t.after(cleanup);
  embed();
  delete process.env.CONDUCTOR_PROJECT_DIR;
  conductorProjects._setFetchImpl(async () => ok([row('code-conductor', '/trees/code-conductor')]));

  await conductorProjects.refresh();
  assert.equal(conductorProjects.snapshot().get('code-conductor'), '/trees/code-conductor');
});

test('_reset() drops the cached snapshot', async (t) => {
  t.after(cleanup);
  embed();
  conductorProjects._setFetchImpl(async () => ok([row('alpha', '/trees/alpha')]));
  await conductorProjects.refresh();
  assert.equal(conductorProjects.snapshot().size, 1);

  conductorProjects._reset();
  // _reset() restores the real transport too, so re-arm the seam before any
  // read that could fire a refresh.
  conductorProjects._setFetchImpl(async () => { throw new Error('no conductor'); });
  assert.equal(conductorProjects.snapshot().size, 0);
});
