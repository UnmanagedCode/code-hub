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

// code-conductor nests every worktree under one root as
// `<worktrees root>/<project>/<key>`. For a project on its LOCAL system —
// the only kind code-hub scans — that root is always
// `<projectsRoot>/.worktrees`, whatever directory the project's own tree
// lives in (`LOCAL_WORKTREES_DIRNAME` in code-conductor's src/projects.ts is
// the owning definition; a project on a registered remote system gets a
// different root, which never lands under the scanned root). The
// intermediate directory name therefore IS the parent project by
// construction — nothing about `<key>` is inspected, and no sibling
// `<projectsRoot>/<project>` is required, which is what keeps an adopted /
// out-of-root project's worktrees discoverable.
export const WORKTREES_DIRNAME = '.worktrees';

export function projectsRoot() {
  return process.env.PROJECTS_ROOT ?? DEFAULT_PROJECTS_ROOT;
}

export function storeRoot() {
  return path.join(projectsRoot(), STORE_DIRNAME);
}

function worktreesRoot() {
  return path.join(projectsRoot(), WORKTREES_DIRNAME);
}

// `:` is code-hub's **reserved id qualifier**, and the reservation is what
// makes `worktreeId()` injective and the two id namespaces disjoint. Every
// directory name that feeds an id is refused if it contains one:
//   - a root directory (`a:b` — legal on Linux — would otherwise emit the
//     same id as worktree `a/b`), and
//   - a worktree's `<project>` or `<key>` (`a/b:c` and `a:b/c` would
//     otherwise both compose `a:b:c`: two checkouts under one id, with
//     readdir order deciding which one every action reaches).
// code-hub enforces this over its own id namespace. It does not assume
// code-conductor keeps `:` out of a project name or worktree key — it
// refuses to serve a directory that carries one, and says so whenever that
// refusal cost a servable app (see the warn sites below).
export const WORKTREE_ID_QUALIFIER = ':';

export function isWorktreeId(id) {
  return typeof id === 'string' && id.includes(WORKTREE_ID_QUALIFIER);
}

// THE one place a worktree's app id is composed, so discovery and appDir()
// can never drift on its shape. `<project>` and `<key>` are directory names
// verbatim, guaranteed qualifier-free by listWorktreeDirs() below — which is
// what makes this injective. The id is opaque and never split back apart:
// appDir() resolves one by enumerating directories and comparing composed
// ids.
export function worktreeId(project, key) {
  return `${project}${WORKTREE_ID_QUALIFIER}${key}`;
}

// Every worktree checkout under the local worktrees root, split into
// `{ worktrees, refused }` — both arrays of `{ project, key, dir }`. Skipped
// outright (in neither array): dot-prefixed `<project>` dirs, mirroring the
// root scan, and any entry that isn't a real directory (a symlink's Dirent
// reports isDirectory() === false, so a linked-in tree is not a checkout).
// `refused` holds entries whose `<project>` or `<key>` carries the reserved
// qualifier: they can never be served, since their composed id would not
// identify them uniquely. They are handed back rather than dropped so
// discoverApps() can say so when the refusal actually cost an app — the same
// scoping the root pass uses. Every other caller wants `worktrees` alone.
export async function listWorktreeDirs() {
  const root = worktreesRoot();
  let projects;
  try {
    projects = await fs.readdir(root, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return { worktrees: [], refused: [] };
    throw e;
  }
  const worktrees = [];
  const refused = [];
  for (const p of projects) {
    if (!p.isDirectory() || p.name.startsWith('.')) continue;
    const projectDir = path.join(root, p.name);
    let keys;
    try {
      keys = await fs.readdir(projectDir, { withFileTypes: true });
    } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') continue;
      throw e;
    }
    for (const k of keys) {
      if (!k.isDirectory()) continue;
      const entry = { project: p.name, key: k.name, dir: path.join(projectDir, k.name) };
      (isWorktreeId(p.name) || isWorktreeId(k.name) ? refused : worktrees).push(entry);
    }
  }
  return { worktrees, refused };
}

// Absolute directory an app id names, or null if it names none. The one
// id -> dir resolution that can't go through discoverApps() (registerApp
// targets a dir that isn't servable yet, so discovery never returns it).
export async function appDir(id) {
  if (typeof id !== 'string' || id.length === 0) return null;
  // A qualified id names a worktree by construction, so it is never resolved
  // against the root — that is what keeps this single-valued when a root dir
  // happens to share the name (see WORKTREE_ID_QUALIFIER).
  if (!isWorktreeId(id) && !id.startsWith('.') && path.basename(id) === id) {
    const dir = path.join(projectsRoot(), id);
    try {
      if ((await fs.stat(dir)).isDirectory()) return dir;
    } catch { /* not a main checkout; fall through to the worktrees */ }
  }
  const { worktrees } = await listWorktreeDirs();
  const wt = worktrees.find((w) => worktreeId(w.project, w.key) === id);
  return wt ? wt.dir : null;
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
  if (obj.port != null) {
    if (!Number.isInteger(obj.port) || obj.port < 1024 || obj.port > 65535) {
      throw new Error(`${file}: "port" must be an integer between 1024 and 65535 (got ${JSON.stringify(obj.port)})`);
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
    port: obj.port ?? null,
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

// Resolve one dir's manifest via the standard precedence: its own
// `.hub.json`, else its own in-memory registration, else its own disk
// registration. `name` is the registration lookup key (normally the dir's
// own basename; discoverApps() also calls this with a worktree's PARENT
// name/dir, so error labels correctly name the parent, not the worktree).
// Returns exactly one of:
//   { manifest, source, error: null }              found and valid
//   { manifest: null, source, error }               found but broken
//   { manifest: null, source: null, error: null }   nothing at this dir
async function resolveManifestSource(name, dir, registry) {
  try {
    const manifest = await readManifest(dir);
    if (manifest) return { manifest, source: 'manifest', error: null };
  } catch (error) {
    return { manifest: null, source: 'manifest', error };
  }
  if (inMemoryRegistrations.has(name)) {
    try {
      const manifest = validateManifestObject(inMemoryRegistrations.get(name), `in-memory#${name}`);
      return { manifest, source: 'memory', error: null };
    } catch (error) {
      return { manifest: null, source: 'memory', error };
    }
  }
  if (registry[name]) {
    try {
      const manifest = validateManifestObject(registry[name], `${REGISTRY_FILENAME}#${name}`);
      return { manifest, source: 'registry', error: null };
    } catch (error) {
      return { manifest: null, source: 'registry', error };
    }
  }
  return { manifest: null, source: null, error: null };
}

// Scan for servable apps in two passes over one shared registry.
//
// Root pass: every non-dot directory under the projects root is its own app
// (`id === project === basename`), servable when it has a `.hub.json`, a
// machine-local entry in registrations.json, or a process-lifetime in-memory
// registration (each only consulted when the dir has no `.hub.json` at all —
// a real manifest, even a broken one, always wins; in-memory wins over disk
// on id collision).
//
// Worktree pass: every `<root>/.worktrees/<project>/<key>` checkout, carrying
// `{ isWorktree: true, project, branch }` so the UI can nest it under its
// parent, and `id = worktreeId(project, key)`. Its own sources resolve under
// that same id; only when it has none of its own does it inherit its PARENT
// project's manifest/source instead of being hidden — needed for worktrees of
// a project whose manifest is only an in-memory or disk registration (e.g. the
// host code-conductor when embedded), since git carries a tracked `.hub.json`
// into every worktree checkout but a registration never does. The parent
// resolves by NAME, so an out-of-root parent can still donate a registration
// even though it has no directory under the root. A missing or broken parent
// manifest is never inherited and never surfaces as an error on the worktree —
// it's just skipped, same as having no manifest at all.
//
// Each app carries `source: 'manifest' | 'registry' | 'memory'`.
export async function discoverApps() {
  const root = projectsRoot();
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const registry = await readRegistry();

  // Memoizes each distinct project name's resolution at most once, whether
  // it's reached as its own row or as a worktree's parent fallback.
  const resolved = new Map();
  const resolve = async (name) => {
    if (!resolved.has(name)) {
      resolved.set(name, await resolveManifestSource(name, path.join(root, name), registry));
    }
    return resolved.get(name);
  };

  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const dir = path.join(root, e.name);

    const res = await resolve(e.name);
    if (isWorktreeId(e.name)) {
      // Reserved qualifier: this dir's basename would collide with a
      // worktree id. Silent for an unservable dir like any other, loud when
      // it cost the user a real app.
      if (res.manifest || res.error) {
        console.warn(`[code-hub] '${e.name}' is not servable: '${WORKTREE_ID_QUALIFIER}' is reserved for worktree ids, so a project directory cannot contain one`);
      }
      continue;
    }
    if (res.error) {
      // Surface the broken manifest/registration as a non-startable app
      // rather than hiding the whole project — fail loudly, not silently.
      out.push({ id: e.name, project: e.name, path: dir, isWorktree: false, branch: null, manifest: null, manifestError: res.error.message, source: res.source });
      continue;
    }
    if (!res.manifest) continue;
    out.push({ id: e.name, project: e.name, path: dir, isWorktree: false, branch: null, manifest: res.manifest, manifestError: null, source: res.source });
  }

  const { worktrees, refused } = await listWorktreeDirs();
  for (const { project, key, dir } of worktrees) {
    const id = worktreeId(project, key);
    // The registry lookup key for a worktree IS its app id, so a broken own
    // registration is labelled `registrations.json#<project>:<key>`.
    const own = await resolveManifestSource(id, dir, registry);
    if (own.error) {
      out.push({ id, project, path: dir, isWorktree: true, branch: null, manifest: null, manifestError: own.error.message, source: own.source });
      continue;
    }

    let manifest = own.manifest;
    let source = own.source;
    if (!manifest) {
      const parentRes = await resolve(project);
      if (parentRes.manifest) {
        manifest = parentRes.manifest;
        source = parentRes.source;
      }
    }
    if (!manifest) continue;

    // A fixed port is per-checkout: worktrees keep dynamic allocation and must
    // never inherit a pinned port — not via the parent fallback above, and not
    // via the `.hub.json` copy git carried into the worktree checkout (the
    // common case). Enforcing it here, at discovery, covers both routes at
    // once. Copy rather than mutate: `manifest` may be the memoized parent
    // object (see resolve()), and mutating it would strip the PARENT's own
    // fixed port too.
    const wtManifest = manifest.port == null ? manifest : { ...manifest, port: null };
    out.push({ id, project, path: dir, isWorktree: true, branch: null, manifest: wtManifest, manifestError: null, source });
  }

  // Same scoping as the root pass's refusal: a refused checkout that would
  // have served something gets said out loud, one that was never going to
  // serve anything is skipped in silence. Named by path, since the whole
  // point is that its id would be ambiguous.
  for (const { project, key, dir } of refused) {
    const own = await resolveManifestSource(worktreeId(project, key), dir, registry);
    // The parent arm applies to a refused `<project>` too: resolve() looks it
    // up BY NAME against the registries, which is independent of whether a
    // root directory of that name exists or is itself servable — the same
    // by-name route that lets an out-of-root parent donate a manifest. So a
    // registration keyed `a:b` really is an app this refusal costs.
    if (own.manifest || own.error || (await resolve(project)).manifest) {
      console.warn(`[code-hub] '${path.relative(root, dir)}' is not servable: '${WORKTREE_ID_QUALIFIER}' is reserved for worktree ids, so a worktree's project or key cannot contain one`);
    }
  }

  // A registration is legitimate when it names a discovered app, or a project
  // under `.worktrees/` whose own checkout lives outside the scanned root —
  // that second case is a registration only its worktrees consume.
  const appIds = new Set(out.map((a) => a.id));
  const wtProjects = new Set(worktrees.map((w) => w.project));
  const regKeys = new Set([...Object.keys(registry), ...inMemoryRegistrations.keys()]);
  for (const key of regKeys) {
    if (!appIds.has(key) && !wtProjects.has(key)) {
      console.warn(`[code-hub] ${REGISTRY_FILENAME}: '${key}' has no matching directory under the projects root, ignoring`);
    }
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}
