import { promises as fs } from 'node:fs';
import path from 'node:path';
import { projectsRoot, storeRoot } from './projects.js';

// One-shot, idempotent move of the legacy store (`<projectsRoot>/.code-hub`)
// into the data dir (storeRoot()). This is the only code that names the legacy
// path. Any refusal throws ESTOREMIGRATE and leaves both trees untouched, so
// boot aborts rather than starting on an empty store beside the real one.
export const LEGACY_STORE_DIRNAME = '.code-hub';

let renameImpl = fs.rename;
// Test seam: the rename itself (null restores fs.rename).
export function _setRename(fn) { renameImpl = fn ?? fs.rename; }

const refuse = (msg, cause) => Object.assign(new Error(`[code-hub] store migration: ${msg}`, { cause }), { code: 'ESTOREMIGRATE' });

export async function migrateLegacyStore({ legacyDir, dataDir } = {}) {
  dataDir ??= storeRoot(); // first: an unset variable throws before anything is read
  legacyDir ??= path.join(projectsRoot(), LEGACY_STORE_DIRNAME);
  if (path.resolve(legacyDir) === path.resolve(dataDir)) return 'same';

  let legacy;
  try { legacy = await fs.lstat(legacyDir); } catch (e) {
    if (e.code === 'ENOENT') return 'absent';
    throw refuse(`cannot inspect ${legacyDir}: ${e.message}`, e);
  }
  if (!legacy.isDirectory()) {
    throw refuse(`${legacyDir} is not a directory; move or remove it, then restart code-hub`);
  }

  let target = null;
  try { target = await fs.lstat(dataDir); } catch (e) {
    if (e.code !== 'ENOENT') throw refuse(`cannot inspect ${dataDir}: ${e.message}`, e);
  }
  const exists = `${dataDir} (legacy store ${legacyDir}) already exists and is not empty — refusing to merge; `
    + 'keep one of the two, move or remove the other, then restart code-hub';
  if (target) {
    if (!target.isDirectory()) throw refuse(`${dataDir} exists and is not a directory; legacy store is ${legacyDir} — move or remove one, then restart code-hub`);
    if ((await fs.readdir(dataDir)).length > 0) throw refuse(exists);
    try { await fs.rmdir(dataDir); } catch (e) {
      if (e.code === 'ENOTEMPTY') throw refuse(exists, e);
      throw refuse(`cannot replace empty ${dataDir}: ${e.message}`, e);
    }
  }

  await fs.mkdir(path.dirname(dataDir), { recursive: true, mode: 0o755 });
  try { await renameImpl(legacyDir, dataDir); } catch (e) {
    const fix = e.code === 'EXDEV' ? `; run \`mv '${legacyDir}' '${dataDir}'\` and restart code-hub` : '';
    throw refuse(`cannot move ${legacyDir} to ${dataDir}: ${e.message}${fix}`, e);
  }
  console.log(`[code-hub] moved ${legacyDir} to ${dataDir}`);
  return 'moved';
}
