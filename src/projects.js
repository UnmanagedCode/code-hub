import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Default projects root = parent directory of the code-hub repo, resolved
// once at module load. Layout: <parent>/code-hub/src/projects.js →
// <parent>/. Matches code-conductor's convention: the orchestrators and
// all sibling projects live under one workspace dir (~/cc-projects/ by
// default). Override with PROJECTS_ROOT.
const DEFAULT_PROJECTS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..',
);

export const MANIFEST_FILENAME = '.hub.json';
export const STORE_DIRNAME = '.code-hub';

// A worktree dir is a sibling named `<project>_worktree_<hexid>` — the
// layout code-conductor creates (see ../code-conductor/src/worktrees.js).
const WORKTREE_RE = /^(.+)_worktree_([0-9a-f]+)$/;

export function projectsRoot() {
  return process.env.PROJECTS_ROOT ?? DEFAULT_PROJECTS_ROOT;
}

export function storeRoot() {
  return path.join(projectsRoot(), STORE_DIRNAME);
}

// Read + validate a project's `.hub.json`. Throws with the offending path
// on missing/empty `start`, wrong field types, or malformed JSON. Returns
// null if the file simply doesn't exist (dir isn't servable).
export async function readManifest(dir) {
  const file = path.join(dir, MANIFEST_FILENAME);
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
    throw e;
  }
  return parseManifest(raw, file);
}

export function parseManifest(raw, file = MANIFEST_FILENAME) {
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${file}: invalid JSON (${e.message})`);
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error(`${file}: must be a JSON object`);
  }
  if (typeof obj.start !== 'string' || obj.start.trim() === '') {
    throw new Error(`${file}: "start" is required and must be a non-empty string`);
  }
  for (const key of ['name', 'healthPath', 'readyWhen']) {
    if (obj[key] != null && typeof obj[key] !== 'string') {
      throw new Error(`${file}: "${key}" must be a string`);
    }
  }
  return {
    start: obj.start,
    name: obj.name ?? null,
    healthPath: obj.healthPath ?? null,
    readyWhen: obj.readyWhen ?? null,
  };
}

// Scan the projects root for servable apps. A directory is servable when it
// contains a `.hub.json`. Main checkouts and worktree dirs both surface;
// worktrees carry `{ isWorktree: true, project, branch }` so the UI can nest
// them under their parent. `id` is the directory basename (unique across the
// root). Dot-prefixed dirs (the store itself) are skipped.
export async function discoverApps() {
  const root = projectsRoot();
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const dirNames = new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name));
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const dir = path.join(root, e.name);
    let manifest;
    try {
      manifest = await readManifest(dir);
    } catch (err) {
      // Surface the broken manifest as a non-startable app rather than
      // hiding the whole project — fail loudly, not silently.
      out.push({ id: e.name, project: e.name, path: dir, isWorktree: false, branch: null, manifest: null, manifestError: err.message });
      continue;
    }
    if (!manifest) continue;
    const wt = WORKTREE_RE.exec(e.name);
    // Only treat as a worktree when a matching parent project dir exists,
    // so a legitimately-named project isn't misclassified.
    if (wt && dirNames.has(wt[1])) {
      out.push({ id: e.name, project: wt[1], path: dir, isWorktree: true, branch: null, manifest, manifestError: null });
    } else {
      out.push({ id: e.name, project: e.name, path: dir, isWorktree: false, branch: null, manifest, manifestError: null });
    }
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}
