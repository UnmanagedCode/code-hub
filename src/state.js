import { promises as fs } from 'node:fs';
import path from 'node:path';
import { storeRoot } from './projects.js';

// Running-app state lives in code-hub's OWN dotfolder at the projects root,
// deliberately outside every project dir — so a running server can still be
// stopped after its source/worktree has been deleted. Shape:
//   { apps: { <id>: RunningRecord } }
// RunningRecord = { id, project, path, isWorktree, branch, pid, pgid, port,
//                   urls, startedSha, startedAt, tunnel: {pid,url}|null }
const STATE_FILENAME = 'state.json';

function stateFile() {
  return path.join(storeRoot(), STATE_FILENAME);
}

export async function load() {
  try {
    const raw = await fs.readFile(stateFile(), 'utf8');
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' && obj.apps ? obj : { apps: {} };
  } catch (e) {
    if (e.code === 'ENOENT') return { apps: {} };
    // Corrupt state must not wedge startup: move it aside and start clean.
    if (e instanceof SyntaxError) {
      await fs.rename(stateFile(), stateFile() + '.corrupt').catch(() => {});
      return { apps: {} };
    }
    throw e;
  }
}

// Saves run one at a time: they share one tmp path, so two overlapping (a
// start persisting while its auto-share persists) could rename each other's
// file away, or publish an older snapshot last. Each serialises `state` when
// its turn comes, so the last save to land holds the latest state.
let queue = Promise.resolve();
export function save(state) {
  const run = queue.then(async () => {
    const dir = storeRoot();
    await fs.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.${process.pid}.tmp`);
    await fs.writeFile(tmp, JSON.stringify(state, null, 2));
    await fs.rename(tmp, stateFile());
  });
  queue = run.catch(() => {});
  return run;
}

// True if the process is still alive (signal 0 probes without killing).
export function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // exists but not ours to signal — still alive
  }
}

// Reconcile persisted records against reality: drop apps whose pid is dead,
// clear tunnels whose pid is dead. Saves, then returns
// `{ state, strandedShares }`.
//
// `strandedShares` is `[{ id, tunnel }]` for every share this drops or clears
// that still holds something live outside this process: a share child whose
// pid is ALIVE, or a host-relay forward (`tunnel.relay.forwardId` — a LAN
// share's tunnel has no pid, so it is always cleared here). The record was the
// only thing holding that pid or forward id, so after the delete nothing
// anywhere could ever release it — for a tailscale funnel that means a public
// URL left serving 443 in front of a proxy that no longer exists. This module
// can't release them itself (it doesn't know a share's kind, and must not grow
// a dependency on the integrations to find out), so it hands them back and the
// caller tears them down. The invariant callers must uphold: no path drops a
// record carrying a LIVE share pid or a relay forward id without first
// releasing it.
export async function reconcile(state) {
  const strandedShares = [];
  const holdsLive = (t) => pidAlive(t.pid) || !!t.relay?.forwardId;
  for (const [id, rec] of Object.entries(state.apps)) {
    if (!pidAlive(rec.pid)) {
      if (rec.tunnel && holdsLive(rec.tunnel)) strandedShares.push({ id, tunnel: rec.tunnel });
      delete state.apps[id];
      continue;
    }
    if (rec.tunnel && !pidAlive(rec.tunnel.pid)) {
      if (rec.tunnel.relay?.forwardId) strandedShares.push({ id, tunnel: rec.tunnel });
      rec.tunnel = null;
    }
  }
  await save(state);
  return { state, strandedShares };
}
