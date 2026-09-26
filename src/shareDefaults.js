import { promises as fs } from 'node:fs';
import path from 'node:path';
import { storeRoot } from './projects.js';

// Per-app default share credentials: the username/password a NEW share of an
// app starts with (see appManager.share). Lives in code-hub's own dotfolder,
// never in a project tree. Shape, keyed by exact app id (a worktree does NOT
// inherit its parent project's entry):
//   { "<id>": { "username"?: string, "password"?: string } }
// Each field is independent; an entry with neither is deleted, never kept.
//
// The password is plaintext at rest, so the file is always (re)written 0600 —
// state.json and registrations.json go out with the process umask, which is
// too loose for a secret.
export const SHARE_DEFAULTS_FILENAME = 'share-defaults.json';

export function shareDefaultsFile() {
  return path.join(storeRoot(), SHARE_DEFAULTS_FILENAME);
}

// Read on every call (no cache), like readRegistry. Corrupt JSON is moved
// aside so it can't wedge every later write; a non-object is ignored.
// Returns a null-prototype object: ids are directory names, so `__proto__` or
// `constructor` must read and write as ordinary own keys.
export async function readAll() {
  const file = shareDefaultsFile();
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return Object.create(null);
    throw e;
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    // The moved-aside copy may still hold passwords, so it gets the same 0600.
    // The parse error isn't logged: its message can quote the input.
    await fs.rename(file, file + '.corrupt').then(() => fs.chmod(file + '.corrupt', 0o600)).catch(() => {});
    console.warn(`[code-hub] ${file}: invalid JSON, moved aside to ${file}.corrupt — no default share logins`);
    return Object.create(null);
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    console.warn(`[code-hub] ${file}: must be a JSON object, ignoring default share logins`);
    return Object.create(null);
  }
  return Object.assign(Object.create(null), obj);
}

async function write(obj) {
  const dir = storeRoot();
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${process.pid}.share-defaults.tmp`);
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  // `mode` only applies when writeFile creates the file (and is masked by the
  // umask), so pin it explicitly before the rename publishes it.
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, shareDefaultsFile());
}

// update/clear are read-modify-write on one file: run them one at a time, or
// two concurrent PUTs for different apps would each drop the other's entry.
let queue = Promise.resolve();
function serialised(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}

export async function get(id) {
  const entry = (await readAll())[id];
  return { username: entry?.username ?? null, password: entry?.password ?? null };
}

// The client-safe view of an entry: never carries the password itself.
export function describe(entry) {
  if (!entry) return null;
  return { username: entry.username ?? null, hasPassword: typeof entry.password === 'string' };
}

function badRequest(msg) {
  const e = new Error(msg); e.statusCode = 400; return e;
}

// Per field: key absent → keep; null → clear; non-empty string → set (trimmed);
// anything else → 400. Validates the whole body before touching the file.
export function update(id, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || (!('username' in body) && !('password' in body))) {
    return Promise.reject(badRequest('provide username and/or password (a non-empty string to set, or null to clear)'));
  }
  const changes = {};
  for (const key of ['username', 'password']) {
    if (!(key in body)) continue;
    const v = body[key];
    if (v === null) changes[key] = null;
    else if (typeof v === 'string' && v.trim()) changes[key] = v.trim();
    else return Promise.reject(badRequest(`'${key}' must be a non-empty string, or null to clear`));
  }
  return serialised(async () => {
    const all = await readAll();
    const entry = { ...all[id] };
    for (const [key, v] of Object.entries(changes)) {
      if (v === null) delete entry[key];
      else entry[key] = v;
    }
    if (entry.username === undefined && entry.password === undefined) delete all[id];
    else all[id] = entry;
    await write(all);
    return describe(all[id]);
  });
}

export function clear(id) {
  return serialised(async () => {
    const all = await readAll();
    if (!Object.hasOwn(all, id)) return;
    delete all[id];
    await write(all);
  });
}
