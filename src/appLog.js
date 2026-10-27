// Per-app output log files. A started app's stdout and stderr go straight into
// one O_APPEND file instead of pipes owned by the spawning code-hub process,
// so no hub process sits in the app's output path: a hub restart can't turn
// the app's next log write into EPIPE. The hub reads the file back for
// `readyWhen` and the crash tail, rotates it by size, and removes stale ones.
import fs, { constants } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { storeRoot } from './projects.js';

export const LOGS_DIRNAME = 'logs';
export const LOG_CAP_BYTES = 1024 * 1024;     // the sweep rotates any log above this size
export const LOG_SWEEP_MS = 10_000;
export const LOG_RETENTION_MS = 7 * 24 * 3600 * 1000; // non-running ids only

// The one id → filename mapping. encodeURIComponent keeps a worktree id
// (`a:b`) or any `/` a single, reversible path component.
export function logFile(id) {
  return path.join(storeRoot(), LOGS_DIRNAME, encodeURIComponent(id) + '.log');
}

// A file is CLAIMED from before openForChild truncates it until its start
// settles (the runner calls the returned `release`). The sweep never rotates or
// deletes a claimed file, so the readiness tail can't lose output to rotation
// and a log that is still starting can't be unlinked under its child.
const claims = new Map(); // file → open claim count
const isClaimed = (file) => claims.has(file);
function claim(file) {
  claims.set(file, (claims.get(file) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = (claims.get(file) ?? 1) - 1;
    if (n <= 0) claims.delete(file); else claims.set(file, n);
  };
}

// Every start begins a fresh log: truncate in place (same inode, so a
// straggler of the previous run still appends into the bounded live file) and
// drop the rotated generation. The file is claimed first. The caller owns —
// and must close — `fd`, and must call `release` when the start settles (or
// fails before it gets there).
export function openForChild(id) {
  const file = logFile(id);
  const release = claim(file);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try { fs.rmSync(file + '.1', { force: true }); } catch (e) { throw new Error(`cannot reset ${file}.1: ${e.message}`); }
    const fd = fs.openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_APPEND, 0o600);
    return { fd, file, release };
  } catch (e) {
    release();
    throw e.message.startsWith('cannot ') ? e : new Error(`cannot open app log ${file}: ${e.message}`);
  }
}

// Bounded incremental reader. read() returns the text appended since the last
// call, at most `maxBytes` of it; when more arrived it skips ahead to the last
// `maxBytes` and reports how many bytes it skipped.
export function tail(file, maxBytes) {
  const fd = fs.openSync(file, 'r');
  let decoder = new StringDecoder('utf8');
  let pos = 0;
  let closed = false;
  return {
    read() {
      if (closed) return { text: '', skipped: 0 };
      const size = fs.fstatSync(fd).size;
      if (size < pos) pos = 0; // truncated externally
      let skipped = 0;
      if (size - pos > maxBytes) {
        skipped = size - maxBytes - pos;
        pos = size - maxBytes;
        decoder = new StringDecoder('utf8');
      }
      const len = size - pos;
      if (len <= 0) return { text: '', skipped };
      const buf = Buffer.alloc(len);
      const n = fs.readSync(fd, buf, 0, len, pos);
      pos += n;
      return { text: decoder.write(buf.subarray(0, n)), skipped };
    },
    close() {
      if (closed) return;
      closed = true;
      fs.closeSync(fd);
    },
  };
}

// Keep the last `capBytes` of `file` in `file.1` (older bytes are dropped; the
// cut is byte-based, so the kept text can begin mid-line or mid-character),
// then truncate it. O_APPEND makes the child's next write land at the new end (0).
function rotate(file, capBytes) {
  const fd = fs.openSync(file, 'r');
  let tailBytes;
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, capBytes);
    tailBytes = Buffer.alloc(len);
    const n = fs.readSync(fd, tailBytes, 0, len, size - len);
    tailBytes = tailBytes.subarray(0, n); // a short read must not pad .log.1 with NULs
  } finally {
    fs.closeSync(fd);
  }
  // `mode` only applies on creation, so an older, looser .log.1 is removed first.
  fs.rmSync(file + '.1', { force: true });
  fs.writeFileSync(file + '.1', tailBytes, { mode: 0o600 });
  fs.truncateSync(file, 0);
}

// One pass: delete logs of non-running ids idle past retention; rotate any
// other log over the cap by keeping only its last `capBytes` in `.log.1` and
// truncating it. Claimed files are never touched; running files are rotated
// (by design) but never deleted.
//
// Synchronous on purpose: each check-then-act runs in one tick, so no start
// (which claims synchronously in openForChild) can interleave between a check
// and the rm/rotate it guards, and two sweeps can never overlap. The cost is
// blocking the event loop per over-cap app per pass: at most `capBytes` read
// and written, plus the truncate, whose time grows with the size of the backlog
// it frees — including in the boot pass, which runs before the hub listens.
// `now` and `capBytes` are test seams.
export function sweep({ running, now = Date.now(), capBytes = LOG_CAP_BYTES }) {
  const live = new Set([...running].map(logFile));
  const protectedFile = (file) => live.has(file) || isClaimed(file);
  const dir = path.dirname(logFile('x'));
  let names;
  try { names = fs.readdirSync(dir); } catch (e) {
    if (e.code === 'ENOENT') return;
    throw e;
  }
  const stale = (st) => st.mtimeMs < now - LOG_RETENTION_MS;
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      if (name.endsWith('.log')) {
        const st = fs.statSync(file);
        if (isClaimed(file)) continue;
        if (!live.has(file) && stale(st)) {
          fs.rmSync(file, { force: true });
          fs.rmSync(file + '.1', { force: true });
        } else if (st.size > capBytes) {
          rotate(file, capBytes);
        }
      } else if (name.endsWith('.log.1')) {
        const base = file.slice(0, -2);
        if (!fs.existsSync(base) && !protectedFile(base) && stale(fs.statSync(file))) fs.rmSync(file, { force: true });
      }
    } catch (e) {
      if (e.code !== 'ENOENT') console.error('[appLog]', file, e.message);
    }
  }
}

let timer = null;
// Idempotent: replaces any previous interval, so repeated calls never leak
// one. Runs one sweep first, so a hub that was down catches up before it
// starts ticking. `intervalMs` and `capBytes` are test seams.
export function startSweep(getRunning, { intervalMs = LOG_SWEEP_MS, capBytes = LOG_CAP_BYTES } = {}) {
  stopSweep();
  const pass = () => {
    try { sweep({ running: getRunning(), capBytes }); } catch (e) { console.error('[appLog] sweep failed:', e.message); }
  };
  pass();
  timer = setInterval(pass, intervalMs);
  timer.unref();
}

export function stopSweep() {
  if (timer) clearInterval(timer);
  timer = null;
}
