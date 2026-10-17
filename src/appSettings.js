import { promises as fs } from 'node:fs';
import path from 'node:path';
import { storeRoot } from './projects.js';
import { validateShareOptions } from './shareOptions.js';

// Per-app settings: the default login a NEW share of an app starts with (see
// appManager.share), whether code-hub starts the app when it boots
// (appManager.autoStartAll), and how it shares the app once a start reaches
// ready (appManager.start → autoRun). Lives in code-hub's own dotfolder, never
// in a project tree. Shape, keyed by exact app id (a worktree does NOT inherit
// its parent project's entry):
//   { "<id>": { "username"?: string, "password"?: string,
//               "autoStart"?: true, "autoShare"?: { mode, auth, tls? } } }
// Each field is independent; `autoStart` is stored only when true, and an
// entry with none of the four keys is deleted, never kept. Whether the two
// toggles may be set for an id (main checkouts only) is appManager's call.
//
// The password is plaintext at rest, so the file is always (re)written 0600 —
// state.json and registrations.json go out with the process umask, which is
// too loose for a secret.
export const APP_SETTINGS_FILENAME = 'app-settings.json';
export const LEGACY_SHARE_DEFAULTS_FILENAME = 'share-defaults.json';

export function appSettingsFile() {
  return path.join(storeRoot(), APP_SETTINGS_FILENAME);
}

export function legacyShareDefaultsFile() {
  return path.join(storeRoot(), LEGACY_SHARE_DEFAULTS_FILENAME);
}

// Read on every call (no cache), like readRegistry. Corrupt JSON is moved
// aside so it can't wedge every later write; a non-object is ignored.
// Returns a null-prototype object: ids are directory names, so `__proto__` or
// `constructor` must read and write as ordinary own keys.
export async function readAll() {
  const file = appSettingsFile();
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
    console.warn(`[code-hub] ${file}: invalid JSON, moved aside to ${file}.corrupt — no app settings`);
    return Object.create(null);
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    console.warn(`[code-hub] ${file}: must be a JSON object, ignoring app settings`);
    return Object.create(null);
  }
  return Object.assign(Object.create(null), obj);
}

async function write(obj) {
  const dir = storeRoot();
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${process.pid}.app-settings.tmp`);
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  // `mode` only applies when writeFile creates the file (and is masked by the
  // umask), so pin it explicitly before the rename publishes it.
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, appSettingsFile());
}

// update/clear are read-modify-write on one file: run them one at a time, or
// two concurrent PUTs for different apps would each drop the other's entry.
let queue = Promise.resolve();
function serialised(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

// One-shot startup migration from the file's previous name, whose entries
// (username/password only) are already valid entries of this shape. Idempotent:
// once renamed there is nothing left to migrate. When both files exist it
// touches neither — the new file wins, and the old one is never destroyed.
export function migrateLegacyFile() {
  return serialised(async () => {
    const legacy = legacyShareDefaultsFile();
    const current = appSettingsFile();
    if (!(await exists(legacy))) return;
    if (await exists(current)) {
      console.warn(`[code-hub] both ${legacy} and ${current} exist — using ${current}; ${legacy} is left untouched`);
      return;
    }
    await fs.rename(legacy, current);
    await fs.chmod(current, 0o600);
  });
}

export async function get(id) {
  const entry = (await readAll())[id];
  return {
    username: entry?.username ?? null,
    password: entry?.password ?? null,
    autoStart: entry?.autoStart === true,
    autoShare: entry?.autoShare ?? null,
  };
}

// The client-safe view of an entry (none at all included): never carries the
// password itself.
export function describe(entry) {
  return {
    username: entry?.username ?? null,
    hasPassword: typeof entry?.password === 'string',
    autoStart: entry?.autoStart === true,
    autoShare: entry?.autoShare ?? null,
  };
}

function badRequest(msg) {
  const e = new Error(msg); e.statusCode = 400; return e;
}

const KEYS = ['username', 'password', 'autoStart', 'autoShare'];

// Per field: key absent → keep. username/password: null → clear, non-empty
// string → set (trimmed). autoStart: a boolean (false clears). autoShare: null
// → clear, else share options (validateShareOptions, mode required) stored
// normalised. Anything else → 400. Validates the whole body before touching
// the file.
function parseChanges(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !KEYS.some((k) => k in body)) {
    throw badRequest('provide at least one of username, password, autoStart, autoShare');
  }
  const changes = {};
  for (const key of ['username', 'password']) {
    if (!(key in body)) continue;
    const v = body[key];
    if (v === null) changes[key] = null;
    else if (typeof v === 'string' && v.trim()) changes[key] = v.trim();
    else throw badRequest(`'${key}' must be a non-empty string, or null to clear`);
  }
  if ('autoStart' in body) {
    if (typeof body.autoStart !== 'boolean') throw badRequest("'autoStart' must be a boolean");
    changes.autoStart = body.autoStart || null;
  }
  if ('autoShare' in body) {
    const v = body.autoShare;
    if (v === null) changes.autoShare = null;
    else if (typeof v === 'object' && !Array.isArray(v)) changes.autoShare = validateShareOptions(v);
    else throw badRequest("'autoShare' must be { mode, auth?, tls? }, or null to clear");
  }
  return changes;
}

export function update(id, body) {
  let changes;
  try { changes = parseChanges(body); } catch (e) { return Promise.reject(e); }
  return serialised(async () => {
    const all = await readAll();
    const entry = { ...all[id] };
    for (const [key, v] of Object.entries(changes)) {
      if (v === null) delete entry[key];
      else entry[key] = v;
    }
    if (KEYS.every((k) => entry[k] === undefined)) delete all[id];
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
