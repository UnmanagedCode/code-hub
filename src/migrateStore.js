import { promises as fs } from 'node:fs';
import path from 'node:path';
import { projectsRoot, storeRoot } from './projects.js';

// One-shot, idempotent move of the legacy store (`<projectsRoot>/.code-hub`)
// into the data dir (storeRoot()). This is the only code naming the legacy
// path. Every refusal throws ESTOREMIGRATE naming both paths and the fix, and
// leaves the filesystem as it found it: a failure after this call created the
// target's parent dirs or removed an empty target undoes exactly that. Boot
// aborts rather than starting on an empty store beside the real one.
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
  let emptyTargetMode = null; // set once this call has removed an empty target
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
    emptyTargetMode = target.mode & 0o7777;
  }

  // Undo: the dirs this call created, deepest first, and the empty target it removed.
  let createdTop;
  const undo = async () => {
    for (let d = path.dirname(dataDir); createdTop && (d === createdTop || d.startsWith(createdTop + path.sep)); d = path.dirname(d)) {
      await fs.rmdir(d).catch(() => {});
      if (d === createdTop) break;
    }
    if (emptyTargetMode !== null) await fs.mkdir(dataDir, { mode: emptyTargetMode }).then(() => fs.chmod(dataDir, emptyTargetMode)).catch(() => {});
  };

  try {
    createdTop = await fs.mkdir(path.dirname(dataDir), { recursive: true, mode: 0o755 });
  } catch (e) {
    await undo();
    throw refuse(`cannot create ${path.dirname(dataDir)}: ${e.message}`, `create it or fix its permissions, ${RESTART}`, e);
  }
  try { await renameImpl(legacyDir, dataDir); } catch (e) {
    await undo();
    const fix = e.code === 'EXDEV'
      ? `run \`mv '${legacyDir}' '${dataDir}'\` and restart code-hub`
      : `move it to the data dir yourself, ${RESTART}`;
    throw refuse(`cannot move the legacy store: ${e.message}`, fix, e);
  }
  console.log(`[code-hub] moved ${legacyDir} to ${dataDir}`);
  return 'moved';
}
