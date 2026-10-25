import { promises as fs, readFileSync, watch } from 'node:fs';
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
let hostPollMs = 1000;

// Test seam: how often watchHost() polls the relay file.
export function _setHostPollMs(ms) { hostPollMs = ms; }

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

// The shared secret, creating the hub file when it is missing or invalid and
// otherwise leaving it untouched. The directory is (re)made 0700 every time;
// a new file is written 0600 via a tmp file and a rename. Throws naming the path.
export async function ensureSecret() {
  const dir = relayDir();
  const file = hubFilePath();
  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.chmod(dir, 0o700);
    const raw = await fs.readFile(file, 'utf8').catch((e) => { if (e.code === 'ENOENT') return null; throw e; });
    if (raw !== null && validSecretFile(raw)) return JSON.parse(raw).secret;
    const secret = crypto.randomBytes(SECRET_BYTES).toString('base64url');
    const tmp = path.join(dir, `.${HUB_FILE}.${process.pid}.tmp`);
    await fs.writeFile(tmp, `${JSON.stringify({ protocolVersion: PROTOCOL.protocolVersion, secret })}\n`, { mode: 0o600 });
    await fs.chmod(tmp, 0o600);
    await fs.rename(tmp, file);
    return secret;
  } catch (e) {
    throw new Error(`cannot provision the host-relay secret in ${file}: ${e.message}`);
  }
}

// The relay file's content as a string, or null when there is none.
async function readHostRaw() {
  try {
    return await fs.readFile(hostFilePath(), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

// Where the relay listens: null when it has published nothing; `{ error }`
// when the file can't be read or used; `{ error, incompatible: true }` when it
// speaks another protocol version; else `{ listenHost, listenPort, pid, raw }`.
export async function readHost() {
  let raw;
  try {
    raw = await readHostRaw();
  } catch (e) {
    return { error: `cannot read ${hostFilePath()}: ${e.message}` };
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
  let last;
  try { last = readFileSync(hostFilePath(), 'utf8'); } catch { last = null; }
  let checking = false;
  let again = false;
  let stopped = false;
  const check = async () => {
    if (stopped) return;
    if (checking) { again = true; return; }
    checking = true;
    try {
      let now;
      try { now = await readHostRaw(); } catch { now = last; }
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
    watcher = watch(relayDir(), (_event, name) => { if (!name || name.toString() === RELAY_FILE) check(); });
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
