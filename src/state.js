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

export async function save(state) {
  const dir = storeRoot();
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${process.pid}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(state, null, 2));
  await fs.rename(tmp, stateFile());
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
// clear tunnels whose pid is dead. Returns the pruned state (also saved).
export async function reconcile(state) {
  for (const [id, rec] of Object.entries(state.apps)) {
    if (!pidAlive(rec.pid)) {
      delete state.apps[id];
      continue;
    }
    if (rec.tunnel && !pidAlive(rec.tunnel.pid)) rec.tunnel = null;
  }
  await save(state);
  return state;
}
