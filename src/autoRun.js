// In-memory automation state, per app id: the auto-share that follows a start
// (pending, failed, or nothing to report), a boot auto-start's failure, and
// the start transition a client's settle wait follows. Nothing here survives a
// code-hub restart. Its collaborators (start, share, the settings read) are
// injected by appManager, so this module imports nothing from it.

// Server cap on one settle wait: readiness (30s) + a tunnel/funnel coming up
// (30s) + waiting out an exiting funnel, with headroom.
export const SETTLE_WAIT_MS = 90_000;

// id → { gen, autoShareStatus, autoShareError, autoStartError }
const states = new Map();
// id → the promise of the latest tracked transition (resolves once it has
// finished and been removed from this map)
const transitions = new Map();
// A process-wide counter, not per id: forget() drops an id's entry, and a
// per-id count restarting from zero would let a stopped start's run pass the
// staleness check of the next one.
let lastGen = 0;

function entry(id) {
  let s = states.get(id);
  if (!s) {
    s = { gen: 0, autoShareStatus: null, autoShareError: null, autoStartError: null };
    states.set(id, s);
  }
  return s;
}

const current = (id, gen) => states.get(id)?.gen === gen;

// A new start of `id`: supersedes any run still in flight for it, clears the
// previous outcome and a recorded auto-start failure, and marks an auto-share
// pending when one will follow. Returns the generation its run must carry.
export function begin(id, { autoShare }) {
  const s = entry(id);
  s.gen = ++lastGen;
  s.autoStartError = null;
  s.autoShareStatus = autoShare ? 'pending' : null;
  s.autoShareError = null;
  return s.gen;
}

function finish(id, gen, error) {
  if (!current(id, gen)) return;
  const s = states.get(id);
  s.autoShareStatus = error ? 'failed' : null;
  s.autoShareError = error ?? null;
}

// The auto-share after a start: wait for readiness to settle, then share with
// the config as it stands at that moment. Never rejects, so a failure can
// never fail or roll back the start. Every write is dropped once a newer
// begin() (or forget()) has superseded `gen`.
//   settled    — the runner's promise of the status the child settled to
//   isCurrent  — false once the started record is gone or replaced, or the
//                app already has a share
//   readConfig — the stored auto-share config, or null if it was cleared
//   share      — shares the app with that config
export async function run({ id, gen, settled, isCurrent, readConfig, share }) {
  try {
    const status = await settled;
    const cfg = await readConfig();
    if (!cfg || !isCurrent()) return finish(id, gen, null);
    if (status !== 'ready') return finish(id, gen, `app did not become ready (${status}) — not shared`);
    if (!current(id, gen)) return;
    await share(cfg);
    finish(id, gen, null);
  } catch (e) {
    if (current(id, gen)) console.error(`[code-hub] auto-share of '${id}' failed: ${e.message}`);
    finish(id, gen, e.message);
  }
}

// Follow `promise` as `id`'s transition until it settles (either way).
export function track(id, promise) {
  const t = promise.then(() => {}, () => {}).then(() => {
    if (transitions.get(id) === t) transitions.delete(id);
  });
  transitions.set(id, t);
}

const CAP = Symbol('cap');

// Resolve once `id` has no tracked transition left — a transition tracked
// while waiting (a restart) is waited for too — or at `capMs`.
export async function awaitSettled(id, { capMs = SETTLE_WAIT_MS } = {}) {
  let timer;
  const cap = new Promise((resolve) => {
    timer = setTimeout(resolve, capMs, CAP);
    timer.unref?.();
  });
  try {
    for (let t = transitions.get(id); t; t = transitions.get(id)) {
      if ((await Promise.race([t, cap])) === CAP) return { id, settled: false };
    }
    return { id, settled: true };
  } finally {
    clearTimeout(timer);
  }
}

export function recordStartError(id, message) {
  entry(id).autoStartError = message;
}

// A successful share (manual or automatic) replaces any auto-share outcome.
export function clearShareOutcome(id) {
  const s = states.get(id);
  if (!s) return;
  s.autoShareStatus = null;
  s.autoShareError = null;
}

// The app was stopped: drop everything, superseding any run in flight.
export function forget(id) {
  states.delete(id);
}

export function view(id) {
  const s = states.get(id);
  return {
    autoShareStatus: s?.autoShareStatus ?? null,
    autoShareError: s?.autoShareError ?? null,
    autoStartError: s?.autoStartError ?? null,
  };
}

// Boot auto-start: one app at a time (no racing for ports or the funnel
// slot), each failure recorded against its app and logged, never stopping the
// rest.
export async function bootAutoStart(ids, start) {
  const started = [];
  const failed = [];
  for (const id of ids) {
    try {
      await start(id);
      started.push(id);
    } catch (e) {
      recordStartError(id, e.message);
      failed.push(id);
      console.error(`[code-hub] auto-start of '${id}' failed: ${e.message}`);
    }
  }
  return { started, failed };
}
