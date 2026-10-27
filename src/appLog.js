// Per-app output log files. A started app's stdout and stderr go straight into
// one O_APPEND file instead of pipes owned by the spawning code-hub process,
// so no hub process sits in the app's output path: a hub restart can't turn
// the app's next log write into EPIPE. The hub reads the file back for
// `readyWhen` and the crash tail, rotates it by size, and removes stale ones.
import fs, { promises as fsp, constants } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { storeRoot } from './projects.js';

export const LOGS_DIRNAME = 'logs';
export const LOG_CAP_BYTES = 1024 * 1024;     // rotate a live log above this size
export const LOG_SWEEP_MS = 10_000;
export const LOG_RETENTION_MS = 7 * 24 * 3600 * 1000; // non-running ids only

// The one id → filename mapping. encodeURIComponent keeps a worktree id
// (`a:b`) or any `/` a single, reversible path component.
export function logFile(id) {
  return path.join(storeRoot(), LOGS_DIRNAME, encodeURIComponent(id) + '.log');
}

// Every start begins a fresh log: truncate in place (same inode, so a
// straggler of the previous run still appends into the bounded live file) and
// drop the rotated generation. The caller owns — and must close — `fd`.
export function openForChild(id) {
  const file = logFile(id);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try { fs.rmSync(file + '.1', { force: true }); } catch (e) { throw new Error(`cannot reset ${file}.1: ${e.message}`); }
  try {
    const fd = fs.openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_APPEND, 0o600);
    return { fd, file };
  } catch (e) {
    throw new Error(`cannot open app log ${file}: ${e.message}`);
  }
}

// Files with a live tail are never rotated: readiness must not lose output.
const tailing = new Map(); // file → open tail count

// Bounded incremental reader. read() returns the text appended since the last
// call, at most `maxBytes` of it; when more arrived it skips ahead to the last
// `maxBytes` and reports how many bytes it skipped.
export function tail(file, maxBytes) {
  const fd = fs.openSync(file, 'r');
  tailing.set(file, (tailing.get(file) ?? 0) + 1);
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
      const n = (tailing.get(file) ?? 1) - 1;
      if (n <= 0) tailing.delete(file); else tailing.set(file, n);
    },
  };
}

// One pass: delete logs of non-running ids idle past retention; copy-truncate
// any other log over the cap. `now` and `capBytes` are test seams.
export async function sweep({ running, now = Date.now(), capBytes = LOG_CAP_BYTES }) {
  const live = new Set([...running].map(logFile));
  const dir = path.dirname(logFile('x'));
  let names;
  try { names = await fsp.readdir(dir); } catch (e) {
    if (e.code === 'ENOENT') return;
    throw e;
  }
  const stale = (st) => st.mtimeMs < now - LOG_RETENTION_MS;
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      if (name.endsWith('.log')) {
        const st = await fsp.stat(file);
        if (!live.has(file) && stale(st)) {
          await fsp.rm(file, { force: true });
          await fsp.rm(file + '.1', { force: true });
        } else if (st.size > capBytes && !tailing.has(file)) {
          // O_APPEND makes the child's next write land at the new end (0).
          await fsp.copyFile(file, file + '.1');
          await fsp.truncate(file, 0);
        }
      } else if (name.endsWith('.log.1')) {
        const orphan = !names.includes(name.slice(0, -2));
        if (orphan && stale(await fsp.stat(file))) await fsp.rm(file, { force: true });
      }
    } catch (e) {
      if (e.code !== 'ENOENT') console.error('[appLog]', file, e.message);
    }
  }
}

let timer = null;
// Idempotent: replaces any previous interval. Runs one sweep first, so a hub
// that was down catches up before it starts ticking.
export async function startSweep(getRunning) {
  if (timer) clearInterval(timer);
  timer = null;
  await sweep({ running: getRunning() });
  timer = setInterval(() => {
    sweep({ running: getRunning() }).catch((e) => console.error('[appLog] sweep failed:', e.message));
  }, LOG_SWEEP_MS);
  timer.unref();
}
