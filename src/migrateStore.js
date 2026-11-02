import { promises as fs } from 'node:fs';
import path from 'node:path';
import { projectsRoot, storeRoot } from './projects.js';

// One-shot, idempotent move of the legacy store (`<projectsRoot>/.code-hub`)
// into the data dir (storeRoot()). This is the only code naming the legacy
// path. Every refusal throws ESTOREMIGRATE naming both paths and the fix, and
// aborts boot rather than starting on an empty store beside the real one.
// A refusal never moves or modifies the store's data: the legacy dir's data
// stays intact and no data lands in the target. Once it has removed an empty
// target or started creating the parent dirs, a refusal may leave the empty
// dirs it created (an emptied target stays removed). Both are harmless: a
// re-run after fixing the cause succeeds.
export const LEGACY_STORE_DIRNAME = '.code-hub';

let renameImpl = fs.rename;
// Test seam: the rename itself (null restores fs.rename).
export function _setRename(fn) { renameImpl = fn ?? fs.rename; }

export async function migrateLegacyStore({ legacyDir, dataDir } = {}) {
  dataDir ??= storeRoot(); // first: an unset variable throws before anything is read
  legacyDir ??= path.join(projectsRoot(), LEGACY_STORE_DIRNAME);
  if (path.resolve(legacyDir) === path.resolve(dataDir)) return 'same';

  const refuse = (what, fix, cause) => Object.assign(
    new Error(`[code-hub] store migration: ${what} (legacy store ${legacyDir}, data dir ${dataDir}) — ${fix}`, { cause }),
    { code: 'ESTOREMIGRATE' });
  const RESTART = 'then restart code-hub';

  let legacy;
  try { legacy = await fs.lstat(legacyDir); } catch (e) {
    if (e.code === 'ENOENT') return 'absent';
    throw refuse(`cannot inspect the legacy store: ${e.message}`, `fix its permissions or move it to the data dir yourself, ${RESTART}`, e);
  }
  if (!legacy.isDirectory()) {
    throw refuse('the legacy store is not a real directory', `move or remove it, ${RESTART}`);
  }

  let target = null;
  try { target = await fs.lstat(dataDir); } catch (e) {
    if (e.code !== 'ENOENT') throw refuse(`cannot inspect the data dir: ${e.message}`, `fix its permissions, ${RESTART}`, e);
  }
  const notEmpty = ['the data dir already exists and is not empty', `refusing to merge; keep one of the two, move or remove the other, ${RESTART}`];
  if (target) {
    if (!target.isDirectory()) throw refuse('the data dir exists and is not a directory', `move or remove one of the two, ${RESTART}`);
    let entries;
    try { entries = await fs.readdir(dataDir); } catch (e) {
      throw refuse(`cannot read the data dir: ${e.message}`, `fix its permissions, ${RESTART}`, e);
    }
    if (entries.length > 0) throw refuse(...notEmpty);
    try { await fs.rmdir(dataDir); } catch (e) {
      if (e.code === 'ENOTEMPTY') throw refuse(...notEmpty, e);
      throw refuse(`cannot replace the empty data dir: ${e.message}`, `fix its permissions, ${RESTART}`, e);
    }
  }

  try {
    await fs.mkdir(path.dirname(dataDir), { recursive: true, mode: 0o755 });
  } catch (e) {
    throw refuse(`cannot create ${path.dirname(dataDir)}: ${e.message}`, `create it or fix its permissions, ${RESTART}`, e);
  }
  try { await renameImpl(legacyDir, dataDir); } catch (e) {
    const fix = e.code === 'EXDEV'
      ? `run \`mv '${legacyDir}' '${dataDir}'\` and restart code-hub`
      : `move it to the data dir yourself, ${RESTART}`;
    throw refuse(`cannot move the legacy store: ${e.message}`, fix, e);
  }
  console.log(`[code-hub] moved ${legacyDir} to ${dataDir}`);
  return 'moved';
}
