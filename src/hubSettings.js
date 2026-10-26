import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { storeRoot } from './projects.js';

// Hub-wide settings, as opposed to an app's own (appSettings.js). Shape:
//   { "bridgeFallback": boolean }
// `bridgeFallback` turns the no-relay bridge-address forwarders on or off (see
// bridgeForward.js); default on. Nothing secret, so the file is world-readable.
//
// get() is synchronous (appManager reads it on every store change), so the file
// is read once per path and cached: a hand edit takes effect on the next
// code-hub start, and update() keeps the cache current.
export const HUB_SETTINGS_FILENAME = 'hub-settings.json';
const DEFAULTS = Object.freeze({ bridgeFallback: true });

export function hubSettingsFile() {
  return path.join(storeRoot(), HUB_SETTINGS_FILENAME);
}

let cache = null; // { file, settings }

// An absent file is the defaults; an unreadable or invalid one is the defaults
// too, with a warning. The parse error isn't logged: its message can quote the input.
function read(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { ...DEFAULTS };
    console.warn(`[code-hub] ${file}: unreadable (${e.code ?? e.message}) — using the default hub settings`);
    return { ...DEFAULTS };
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    console.warn(`[code-hub] ${file}: invalid JSON — using the default hub settings`);
    return { ...DEFAULTS };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    console.warn(`[code-hub] ${file}: must be a JSON object — using the default hub settings`);
    return { ...DEFAULTS };
  }
  if (obj.bridgeFallback !== undefined && typeof obj.bridgeFallback !== 'boolean') {
    console.warn(`[code-hub] ${file}: 'bridgeFallback' must be a boolean — using the default hub settings`);
    return { ...DEFAULTS };
  }
  return { ...DEFAULTS, ...(obj.bridgeFallback !== undefined ? { bridgeFallback: obj.bridgeFallback } : {}) };
}

export function get() {
  const file = hubSettingsFile();
  if (cache?.file !== file) cache = { file, settings: read(file) };
  return { ...cache.settings };
}

// Test seam: drop the cache, so the next get() reads the file.
export function _reset() { cache = null; }

function invalid(message) {
  const e = new Error(message);
  e.statusCode = 400;
  return e;
}

// Writes run one at a time, so the file and the cache end on the last call.
let queue = Promise.resolve();

// `body` must be exactly { bridgeFallback: boolean }; anything else is refused
// with 400 and writes nothing.
export async function update(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('hub settings must be a JSON object');
  const extra = Object.keys(body).filter((k) => k !== 'bridgeFallback');
  if (extra.length) throw invalid(`unknown hub setting${extra.length > 1 ? 's' : ''}: ${extra.join(', ')}`);
  if (typeof body.bridgeFallback !== 'boolean') throw invalid("'bridgeFallback' must be a boolean");
  const settings = { bridgeFallback: body.bridgeFallback };
  const run = queue.then(async () => {
    const dir = storeRoot();
    const file = hubSettingsFile();
    await fs.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.${process.pid}.hub-settings.tmp`);
    await fs.writeFile(tmp, JSON.stringify(settings, null, 2), { mode: 0o644 });
    await fs.chmod(tmp, 0o644);
    await fs.rename(tmp, file);
    cache = { file, settings };
    return { ...settings };
  });
  queue = run.catch(() => {});
  return run;
}
