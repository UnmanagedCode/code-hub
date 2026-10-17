import test from 'node:test';
import assert from 'node:assert/strict';
import * as autoRun from '../src/autoRun.js';

// Unit tests over injected fakes: no processes, no sockets, no sleeps. Ids are
// unique per test, since the module's state is process-wide.
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const CFG = { mode: 'lan', auth: true, tls: false };
const quiet = (t) => {
  const real = console.error;
  console.error = () => {};
  t.after(() => { console.error = real; });
};

// Invariant: a start that becomes ready shares once, with the config read at
// that moment, and leaves nothing to report.
test('settled ready → share called once with the config → status cleared', async () => {
  const gen = autoRun.begin('ok', { autoShare: true });
  assert.equal(autoRun.view('ok').autoShareStatus, 'pending');
  const calls = [];
  await autoRun.run({ id: 'ok', gen, settled: Promise.resolve('ready'), isCurrent: () => true, readConfig: async () => CFG, share: async (c) => { calls.push(c); } });
  assert.deepEqual(calls, [CFG]);
  assert.deepEqual(autoRun.view('ok'), { autoShareStatus: null, autoShareError: null, autoStartError: null });
});

// Invariant: an app that never became ready is never shared, and says why.
test('settled crashed → no share → failed with the not-ready message', async () => {
  const gen = autoRun.begin('crash', { autoShare: true });
  let shared = false;
  await autoRun.run({ id: 'crash', gen, settled: Promise.resolve('crashed'), isCurrent: () => true, readConfig: async () => CFG, share: async () => { shared = true; } });
  assert.equal(shared, false);
  assert.deepEqual(autoRun.view('crash'), { autoShareStatus: 'failed', autoShareError: 'app did not become ready (crashed) — not shared', autoStartError: null });
});

// Invariant: a share refusal (the tailscale 409 included) is recorded with its
// message and never propagates to the start.
test('a rejecting share marks failed with its message, and run resolves', async (t) => {
  quiet(t);
  const gen = autoRun.begin('held', { autoShare: true });
  const msg = "'other' already has a tailscale share — Tailscale Funnel occupies port 443 machine-wide";
  const p = autoRun.run({ id: 'held', gen, settled: Promise.resolve('ready'), isCurrent: () => true, readConfig: async () => CFG, share: async () => { throw Object.assign(new Error(msg), { statusCode: 409 }); } });
  await assert.doesNotReject(p);
  assert.equal(autoRun.view('held').autoShareStatus, 'failed');
  assert.equal(autoRun.view('held').autoShareError, msg);
});

// Invariant: a run whose start is no longer current (stopped, replaced, or
// already shared by hand) shares nothing and reports nothing.
test('isCurrent() false → no share, no failure recorded', async () => {
  const gen = autoRun.begin('gone', { autoShare: true });
  let shared = false;
  await autoRun.run({ id: 'gone', gen, settled: Promise.resolve('ready'), isCurrent: () => false, readConfig: async () => CFG, share: async () => { shared = true; } });
  assert.equal(shared, false);
  assert.deepEqual(autoRun.view('gone'), { autoShareStatus: null, autoShareError: null, autoStartError: null });
  // Not current wins over not-ready too: a stopped app's crash is not a failure.
  const gen2 = autoRun.begin('gone', { autoShare: true });
  await autoRun.run({ id: 'gone', gen: gen2, settled: Promise.resolve('crashed'), isCurrent: () => false, readConfig: async () => CFG, share: async () => { shared = true; } });
  assert.equal(autoRun.view('gone').autoShareStatus, null);
});

// Invariant: unticking auto-share while the app is starting cancels it.
test('readConfig() null at ready time → no share, status cleared', async () => {
  const gen = autoRun.begin('untick', { autoShare: true });
  let shared = false;
  await autoRun.run({ id: 'untick', gen, settled: Promise.resolve('ready'), isCurrent: () => true, readConfig: async () => null, share: async () => { shared = true; } });
  assert.equal(shared, false);
  assert.equal(autoRun.view('untick').autoShareStatus, null);
});

// Invariant: a newer start supersedes an older run — its outcome is dropped,
// and it does not share.
test('a second begin() before the first run finishes → the first run is ignored', async (t) => {
  quiet(t);
  const first = deferred();
  const gen1 = autoRun.begin('regen', { autoShare: true });
  let shares = 0;
  const run1 = autoRun.run({ id: 'regen', gen: gen1, settled: first.promise, isCurrent: () => true, readConfig: async () => CFG, share: async () => { shares++; throw new Error('first'); } });
  autoRun.begin('regen', { autoShare: true });
  first.resolve('crashed');
  await run1;
  assert.equal(shares, 0);
  assert.deepEqual(autoRun.view('regen'), { autoShareStatus: 'pending', autoShareError: null, autoStartError: null });
  // forget() then begin() again: the stopped start's run is still stale.
  const stale = deferred();
  const gen3 = autoRun.begin('regen2', { autoShare: true });
  const run3 = autoRun.run({ id: 'regen2', gen: gen3, settled: stale.promise, isCurrent: () => true, readConfig: async () => CFG, share: async () => { throw new Error('stale'); } });
  autoRun.forget('regen2');
  autoRun.begin('regen2', { autoShare: true });
  stale.resolve('ready');
  await run3;
  assert.equal(autoRun.view('regen2').autoShareStatus, 'pending');
});

// Invariant: the settle wait is bounded: immediate with nothing tracked, ends
// with its transition, follows a transition tracked meanwhile (a restart), and
// gives up at the cap with settled:false.
test('awaitSettled: untracked → at once; tracked → on resolution; re-tracked → the newer one; cap → settled:false', async () => {
  assert.deepEqual(await autoRun.awaitSettled('idle'), { id: 'idle', settled: true });

  const a = deferred();
  autoRun.track('busy', a.promise);
  let done = false;
  const w = autoRun.awaitSettled('busy').then((r) => { done = true; return r; });
  await new Promise((r) => setImmediate(r));
  assert.equal(done, false);
  const b = deferred();
  autoRun.track('busy', b.promise); // restarted while waiting
  a.reject(new Error('killed'));
  await new Promise((r) => setImmediate(r));
  assert.equal(done, false);
  b.resolve('ready');
  assert.deepEqual(await w, { id: 'busy', settled: true });
  assert.deepEqual(await autoRun.awaitSettled('busy'), { id: 'busy', settled: true });

  autoRun.track('stuck', new Promise(() => {}));
  assert.deepEqual(await autoRun.awaitSettled('stuck', { capMs: 5 }), { id: 'stuck', settled: false });
});

// Invariant: one failing boot start neither stops the others nor goes unseen.
test('bootAutoStart: a start that rejects for B still starts A and C, and records B\'s error', async (t) => {
  quiet(t);
  const order = [];
  const res = await autoRun.bootAutoStart(['bootA', 'bootB', 'bootC'], async (id) => {
    order.push(id);
    if (id === 'bootB') throw new Error('manifest broken');
  });
  assert.deepEqual(order, ['bootA', 'bootB', 'bootC']);
  assert.deepEqual(res, { started: ['bootA', 'bootC'], failed: ['bootB'] });
  assert.equal(autoRun.view('bootB').autoStartError, 'manifest broken');
  assert.equal(autoRun.view('bootA').autoStartError, null);
  // The app's next start clears it.
  autoRun.begin('bootB', { autoShare: false });
  assert.equal(autoRun.view('bootB').autoStartError, null);
});

// Invariant: a share that fails because the app got shared by someone else
// meanwhile (the per-app 409) leaves no failure behind — the app is shared.
test('a share rejecting after the start stopped being current records no failure', async () => {
  const gen = autoRun.begin('raced', { autoShare: true });
  let shared = false;
  await autoRun.run({
    id: 'raced', gen, settled: Promise.resolve('ready'), isCurrent: () => !shared, readConfig: async () => CFG,
    share: async () => { shared = true; throw Object.assign(new Error("'raced' already has a share starting"), { statusCode: 409 }); },
  });
  assert.deepEqual(autoRun.view('raced'), { autoShareStatus: null, autoShareError: null, autoStartError: null });
});
