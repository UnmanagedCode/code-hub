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
export const REGISTRY_FILENAME = 'registrations.json';

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
  return validateManifestObject(obj, file);
}

// Same schema as `.hub.json`, applied to an already-parsed object. Shared by
// `parseManifest` (file on disk) and the registrations.json overlay below, so
// the two never drift.
export function validateManifestObject(obj, file = MANIFEST_FILENAME) {
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
  let routes = null;
  if (obj.routes != null) {
    if (!Array.isArray(obj.routes) || obj.routes.length === 0) {
      throw new Error(`${file}: "routes" must be a non-empty array`);
    }
    routes = obj.routes.map((rt, i) => {
      if (!rt || typeof rt !== 'object' || Array.isArray(rt)) {
        throw new Error(`${file}: routes[${i}] must be an object`);
      }
      if (typeof rt.name !== 'string' || rt.name.trim() === '') {
        throw new Error(`${file}: routes[${i}].name is required and must be a non-empty string`);
      }
      if (typeof rt.path !== 'string' || !rt.path.startsWith('/')) {
        throw new Error(`${file}: routes[${i}].path is required and must start with "/"`);
      }
      return { name: rt.name, path: rt.path };
    });
  }
  return {
    start: obj.start,
    name: obj.name ?? null,
    healthPath: obj.healthPath ?? null,
    readyWhen: obj.readyWhen ?? null,
    routes,
  };
}

export function registryFile() {
  return path.join(storeRoot(), REGISTRY_FILENAME);
}

// Process-lifetime-only registrations (id -> manifest body), never persisted.
// Used to synthesize a manifest for a dir that has no `.hub.json` and no disk
// registration — currently just the host code-conductor when embedded (see
// appManager.js init()). Kept fully separate from readRegistry()/writeRegistry()
// so it can never leak into registrations.json.
const inMemoryRegistrations = new Map();

export function registerInMemory(id, body) {
  const manifest = validateManifestObject(body, `in-memory#${id}`);
  inMemoryRegistrations.set(id, body);
  return manifest;
}

export function unregisterInMemory(id) {
  inMemoryRegistrations.delete(id);
}

// Machine-local registrations: an id -> manifest-body map for sibling dirs
// that have no `.hub.json` of their own. Never overrides a real manifest —
// see discoverApps() below. Whole-file corruption warns and is treated as an
// empty registry, so it never hides the real .hub.json apps.
export async function readRegistry() {
  const file = registryFile();
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    console.warn(`[code-hub] ${file}: invalid JSON, ignoring registrations (${e.message})`);
    return {};
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    console.warn(`[code-hub] ${file}: must be a JSON object, ignoring registrations`);
    return {};
  }
  return obj;
}

export async function writeRegistry(obj) {
  const dir = storeRoot();
  await fs.mkdir(dir, { recursive: true });
  const file = registryFile();
  const tmp = path.join(dir, `.${process.pid}.registrations.tmp`);
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2));
  await fs.rename(tmp, file);
}

// Scan the projects root for servable apps. A directory is servable when it
// contains a `.hub.json`, has a machine-local entry in registrations.json, or
// has a process-lifetime in-memory registration (each only consulted when the
// dir has no `.hub.json` at all — a real manifest, even a broken one, always
// wins; in-memory wins over disk on id collision). Main checkouts and
// worktree dirs both surface; worktrees carry `{ isWorktree: true, project,
// branch }` so the UI can nest them under their parent. `id` is the directory
// basename (unique across the root). Dot-prefixed dirs (the store itself) are
// skipped. Each app carries `source: 'manifest' | 'registry' | 'memory'`.
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
  const registry = await readRegistry();
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const dir = path.join(root, e.name);
    let manifest;
    let source = 'manifest';
    try {
      manifest = await readManifest(dir);
    } catch (err) {
      // Surface the broken manifest as a non-startable app rather than
      // hiding the whole project — fail loudly, not silently.
      out.push({ id: e.name, project: e.name, path: dir, isWorktree: false, branch: null, manifest: null, manifestError: err.message, source });
      continue;
    }
    if (!manifest) {
      let regEntry, regFile;
      if (inMemoryRegistrations.has(e.name)) {
        regEntry = inMemoryRegistrations.get(e.name);
        source = 'memory';
        regFile = `in-memory#${e.name}`;
      } else if (registry[e.name]) {
        regEntry = registry[e.name];
        source = 'registry';
        regFile = `${REGISTRY_FILENAME}#${e.name}`;
      } else {
        continue;
      }
      try {
        manifest = validateManifestObject(regEntry, regFile);
      } catch (err) {
        out.push({ id: e.name, project: e.name, path: dir, isWorktree: false, branch: null, manifest: null, manifestError: err.message, source });
        continue;
      }
    }
    const wt = WORKTREE_RE.exec(e.name);
    // Only treat as a worktree when a matching parent project dir exists,
    // so a legitimately-named project isn't misclassified.
    if (wt && dirNames.has(wt[1])) {
      out.push({ id: e.name, project: wt[1], path: dir, isWorktree: true, branch: null, manifest, manifestError: null, source });
    } else {
      out.push({ id: e.name, project: e.name, path: dir, isWorktree: false, branch: null, manifest, manifestError: null, source });
    }
  }
  const regKeys = new Set([...Object.keys(registry), ...inMemoryRegistrations.keys()]);
  for (const key of regKeys) {
    if (!dirNames.has(key)) {
      console.warn(`[code-hub] ${REGISTRY_FILENAME}: '${key}' has no matching directory under the projects root, ignoring`);
    }
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}
