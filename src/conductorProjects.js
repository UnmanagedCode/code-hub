// The host code-conductor's project catalog, as an OVERLAY on code-hub's
// filesystem scan: fetch, cache, degrade. Nothing else in code-hub talks to
// the conductor's HTTP API, so every timeout, validation and
// failure-containment decision for it lives here; `src/projects.js` only ever
// sees a plain `Map<name, absoluteDir>`.
//
// Why an overlay exists at all: cc nests EVERY local-system project's
// worktrees at `<projectsRoot>/.worktrees/<project>/<key>`, whatever directory
// the project's own tree lives in. A project the root scan produces no
// directory for (its tree is elsewhere, or is nested under a dot-dir the scan
// skips) therefore still has its worktrees discovered, with no parent row to
// nest them under. The conductor knows where that tree actually is.
import path from 'node:path';
import { isEmbedded, hostConductorDir, HOST_CONDUCTOR_ID } from './hostConductor.js';
import { isWorktreeId } from './projects.js';

// cc's `LOCAL_SYSTEM_ID` (its src/systems/localSystem.ts): the project's tree
// is on THIS machine. A project on a registered remote system has neither its
// tree nor its worktrees under the scanned root — code-hub can serve neither,
// so those rows are dropped here rather than producing a card for a directory
// that does not exist locally.
const LOCAL_SYSTEM = 'local';

// Loopback fetch of a listing the conductor serves behind its own cache. If it
// can't answer in 2s it is wedged, and a wedged conductor must not hold up a
// listing that is otherwise entirely filesystem-derived. The signal is passed
// to `fetch`, so it bounds body consumption too — a conductor that accepts the
// connection and then streams forever is still bounded.
const FETCH_TIMEOUT_MS = 2000;

// At most one conductor call per 5s however many UI clients poll at 2s. The
// window is counted from the end of the previous ATTEMPT, success or not (see
// `lastAttemptAt`), which is what holds a down conductor to this cadence — a
// window counted from the last SUCCESS would retry on every request.
const OVERLAY_TTL_MS = 5000;

// Last good answer. Replaced atomically on success and RETAINED on every
// failure, so no failure can empty code-hub's listing. A successful answer
// always wins, empty included: "the conductor knows of no project here" is an
// answer, and holding a departed project's tree would keep a card for it.
let cache = new Map();
let lastAttemptAt = 0;
let inFlight = null;

let fetchImpl = (...args) => fetch(...args);
let now = () => Date.now();

// Seams for tests: swap the transport / the clock so the overlay never touches
// the network and the TTL is exercised without a real sleep. Pass null to
// restore the default.
export function _setFetchImpl(fn) { fetchImpl = fn ?? ((...args) => fetch(...args)); }
export function _setClock(fn) { now = fn ?? (() => Date.now()); }

export function _reset() {
  cache = new Map();
  lastAttemptAt = 0;
  inFlight = null;
  fetchImpl = (...args) => fetch(...args);
  now = () => Date.now();
}

// The overlay, as a `Map<projectName, absoluteDir>`. Synchronous, never
// throws, never blocks: it hands back the last good answer and — once the TTL
// has passed since the last ATTEMPT finished — fires a refresh it does NOT
// await, so no request path ever waits on the conductor. Empty until the
// first successful fetch lands; standalone it stays empty for the process's
// life, so the listing there is exactly the filesystem scan's answer.
export function snapshot() {
  if (isEmbedded() && !inFlight && now() - lastAttemptAt >= OVERLAY_TTL_MS) void refresh();
  return cache;
}

// Fetch the catalog and replace the snapshot. Never rejects; single-flight, so
// concurrent callers share one conductor call. `appManager.init()` awaits this
// once, off the request path, so the very first `GET /api/apps` already has an
// overlay.
export async function refresh() {
  if (!isEmbedded()) return;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const res = await fetchImpl(`${process.env.CONDUCTOR_URL}/api/projects`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return;
      const rows = await res.json();
      if (!Array.isArray(rows)) return;
      cache = buildSnapshot(rows);
    } catch {
      // Conductor down, restarting on another port, timed out, non-JSON body:
      // every one of these keeps the last good answer. Silent by design — the
      // conductor is optional context, and a warning on a 2s poll loop would
      // be noise, not a signal.
    } finally {
      lastAttemptAt = now();
      inFlight = null;
    }
  })();
  return inFlight;
}

// One `ProjectInfo` row is usable only if it names a local directory code-hub
// could serve under an id it is allowed to mint. Every drop is silent. For a
// refused NAME that is because the same rules already make its worktrees
// invisible (`listWorktreeDirs()` skips a dot-prefixed `<project>` and routes
// a `:`-bearing one into `refused`), so nothing is lost; the other two guards
// carry their own reasons below.
function buildSnapshot(rows) {
  // The conductor's record of its OWN project names its main checkout, while
  // the conductor process code-hub is embedded in may be running from a
  // worktree of it. `CONDUCTOR_PROJECT_DIR` is that running checkout, and it
  // is the authority for this one id everywhere else in code-hub — so the
  // overlay adopts it here, at the single point the snapshot is built, rather
  // than letting the catalog contradict `appManager`'s always-on record.
  const injected = hostConductorDir();
  const map = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const { name, path: dir, system } = row;
    if (system !== LOCAL_SYSTEM) continue;
    // Also what drops a degraded row — the conductor emits `path: ''` for a
    // project whose record it could not parse, to keep it visible (and
    // deletable) in its own UI. Its reason differs from the name guards
    // above: such a project's worktrees ARE enumerated and DO render. The
    // conductor is saying it does not know where the tree is, so there is no
    // directory to serve, and the worktrees keep the "no main checkout" card
    // — the honest rendering of exactly that.
    if (typeof dir !== 'string' || dir === '' || !path.isAbsolute(dir)) continue;
    if (typeof name !== 'string' || name === '' || name.startsWith('.') || path.basename(name) !== name) continue;
    if (isWorktreeId(name)) continue;
    map.set(name, name === HOST_CONDUCTOR_ID && injected ? injected : dir);
  }
  return map;
}
