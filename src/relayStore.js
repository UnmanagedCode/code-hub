import { promises as fs, constants, openSync, fstatSync, readSync, closeSync, watch } from 'node:fs';
import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { storeRoot } from './projects.js';
import { PROTOCOL } from './relayProtocol.js';

// The host relay's rendezvous directory, <projectsRoot>/.code-hub/relay/: two
// files, each with a single writer. code-hub writes the shared secret (the
// hub file); the relay writes where it listens (the relay file). The relay
// finds this directory by walking up from its own script, so neither side
// needs configuring.
const { dir: DIR, hubFile: HUB_FILE, relayFile: RELAY_FILE } = PROTOCOL.rendezvous;
const SECRET_BYTES = 32;
// How often watchHost() polls the relay file's content.
const HOST_POLL_MS = 1000;
let hostPollMs = HOST_POLL_MS;
let watchImpl = watch;

// Test seams: the poll interval, and fs.watch itself (null restores each).
export function _setHostPollMs(ms) { hostPollMs = ms ?? HOST_POLL_MS; }
export function _setWatch(fn) { watchImpl = fn ?? watch; }

// Opened non-blocking and checked on the open descriptor before any read, so a
// FIFO planted in the rendezvous dir can't block a read (a device is opened
// non-blocking and refused unread) and a huge file can't bloat it.
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

function unusable(file, why) {
  return Object.assign(new Error(`${file} ${why}`), { code: 'EUNUSABLE' });
}

// The text of `file` if it is a regular file of at most maxRendezvousBytes;
// null when it doesn't exist. Throws (`code: 'EUNUSABLE'`) naming why it can't be used.
async function readSmall(file) {
  let handle;
  try {
    handle = await fs.open(file, OPEN_FLAGS);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw unusable(file, 'is not a regular file');
    if (info.size > PROTOCOL.maxRendezvousBytes) throw unusable(file, `is larger than ${PROTOCOL.maxRendezvousBytes} bytes`);
    // A read may return less than asked: read on until EOF or one byte past the bound.
    const buf = Buffer.alloc(PROTOCOL.maxRendezvousBytes + 1);
    let total = 0;
    while (total < buf.length) {
      const { bytesRead } = await handle.read(buf, total, buf.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > PROTOCOL.maxRendezvousBytes) throw unusable(file, `is larger than ${PROTOCOL.maxRendezvousBytes} bytes`);
    return buf.subarray(0, total).toString('utf8');
  } finally {
    await handle.close();
  }
}

// readSmall, synchronously, for watchHost's baseline; anything unusable reads as null.
function readSmallSync(file) {
  let fd;
  try { fd = openSync(file, OPEN_FLAGS); } catch { return null; }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > PROTOCOL.maxRendezvousBytes) return null;
    const buf = Buffer.alloc(PROTOCOL.maxRendezvousBytes + 1);
    let total = 0;
    while (total < buf.length) {
      const n = readSync(fd, buf, total, buf.length - total, total);
      if (!n) break;
      total += n;
    }
    return total > PROTOCOL.maxRendezvousBytes ? null : buf.subarray(0, total).toString('utf8');
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

export function relayDir() {
  return path.join(storeRoot(), DIR);
}

const hubFilePath = () => path.join(relayDir(), HUB_FILE);
const hostFilePath = () => path.join(relayDir(), RELAY_FILE);

function validSecretFile(raw) {
  try {
    const obj = JSON.parse(raw);
    return !!obj && typeof obj === 'object' && !Array.isArray(obj)
      && typeof obj.secret === 'string' && obj.secret.length >= PROTOCOL.minSecretLength;
  } catch {
    return false;
  }
}

// The shared secret, creating the hub file when it is missing or invalid (an
// unusable file — not regular, too large — included) and otherwise leaving it
// untouched. The directory is (re)made 0700 every time; a new file is written
// 0600 via a tmp file created exclusively (a symlink planted at the tmp path is
// removed, never followed) and a rename. Throws naming the path.
export async function ensureSecret() {
  const dir = relayDir();
  const file = hubFilePath();
  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.chmod(dir, 0o700);
    const raw = await readSmall(file).catch((e) => { if (e.code === 'EUNUSABLE') return null; throw e; });
    if (raw !== null && validSecretFile(raw)) return JSON.parse(raw).secret;
    const secret = crypto.randomBytes(SECRET_BYTES).toString('base64url');
    const tmp = path.join(dir, `.${HUB_FILE}.${process.pid}.tmp`);
    await fs.rm(tmp, { force: true });
    // Created exclusively, then set to 0600 on the open handle: the create mode
    // is narrowed by the umask, and a restrictive one would leave the file
    // unreadable to code-hub itself.
    const handle = await fs.open(tmp, 'wx', 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(`${JSON.stringify({ protocolVersion: PROTOCOL.protocolVersion, secret })}\n`);
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, file);
    return secret;
  } catch (e) {
    throw new Error(`cannot provision the host-relay secret in ${file}: ${e.message}`);
  }
}

// The relay file's content as a string, or null when there is none.
function readHostRaw() {
  return readSmall(hostFilePath());
}

// Where the relay listens: null when it has published nothing; `{ error,
// readError: true }` when reading it failed (an fs error, possibly passing);
// `{ error }` when its content can't be used (not a regular small file,
// invalid); `{ error, incompatible: true }` when it speaks another protocol
// version; else `{ listenHost, listenPort, pid, raw }`.
export async function readHost() {
  let raw;
  try {
    raw = await readHostRaw();
  } catch (e) {
    if (e.code === 'EUNUSABLE') return { error: e.message };
    return { error: `cannot read ${hostFilePath()}: ${e.message}`, readError: true };
  }
  return raw === null ? null : parseHost(raw, hostFilePath());
}

export function parseHost(raw, file) {
  let obj;
  try { obj = JSON.parse(raw); } catch { return { error: `${file} is not valid JSON` }; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { error: `${file} is not a JSON object` };
  if (obj.protocolVersion !== PROTOCOL.protocolVersion) {
    return {
      error: `the relay on the host speaks protocol ${JSON.stringify(obj.protocolVersion)}, this code-hub speaks ${PROTOCOL.protocolVersion} — update the relay/ copy on the host`,
      incompatible: true,
    };
  }
  const m = typeof obj.listen === 'string' ? /^(.+):(\d{1,5})$/.exec(obj.listen) : null;
  const listenPort = m ? Number(m[2]) : NaN;
  if (!m || !net.isIPv4(m[1]) || listenPort < 1 || listenPort > 65535) return { error: `${file}: listen ${JSON.stringify(obj.listen)} is not <ipv4>:<port>` };
  if (!Number.isInteger(obj.pid) || obj.pid <= 0) return { error: `${file}: pid ${JSON.stringify(obj.pid)} is not a positive integer` };
  return { listenHost: m[1], listenPort, pid: obj.pid, raw };
}

// Call onChange() whenever the relay file's content changes, its removal
// included. fs.watch on the directory gives a prompt signal where the
// filesystem delivers events; the content poll is what makes it work where it
// doesn't (Docker Desktop bind mounts often drop host-side writes). Returns stop().
export function watchHost(onChange) {
  let last = readSmallSync(hostFilePath());
  let checking = false;
  let again = false;
  let stopped = false;
  const check = async () => {
    if (stopped) return;
    if (checking) { again = true; return; }
    checking = true;
    try {
      let now;
      try { now = await readHostRaw(); } catch (e) { now = `unusable: ${e.message}`; }
      if (!stopped && now !== last) {
        last = now;
        try { onChange(); } catch (e) { console.error(`[relayStore] host-file change handler failed: ${e.message}`); }
      }
    } finally {
      checking = false;
      if (again) { again = false; check(); }
    }
  };
  let watcher = null;
  try {
    watcher = watchImpl(relayDir(), (_event, name) => { if (!name || name.toString() === RELAY_FILE) check(); });
    watcher.on('error', (e) => {
      console.error(`[relayStore] watching ${relayDir()} failed (${e.message}); polling continues`);
      watcher.close();
    });
    watcher.unref();
  } catch (e) {
    console.error(`[relayStore] cannot watch ${relayDir()} (${e.message}); polling instead`);
  }
  const timer = setInterval(check, hostPollMs);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
    watcher?.close();
  };
}
