import net from 'node:net';
import { PROTOCOL } from './relayProtocol.js';
import * as relayStore from './relayStore.js';
import { openControl, openData, createLimiter, checkShape, isStr, isInt, isBool, isArr, ID_RE } from './relaySession.js';
import { runningInContainer, defaultGatewayIPv4 } from './net.js';

// The host relay manager. When code-hub runs in a container, it dials OUT to
// relay/relay.py on the Docker host — found through the rendezvous files (see
// relayStore.js) — and keeps one authenticated control session to it. Every
// exposure (a LAN share's proxy port, a running app's port) is a (port, scope)
// pair; the session always carries the full set, and the relay binds a host
// listener per pair for exactly as long as the session lives. A host client
// arrives as an `incoming` frame and is claimed with one fresh data
// connection, piped to the exposure's target here — the relay never learns it.
//
// State machine: off → (init in a container) absent ⇄ connecting → up, with
// retrying (an error and a backoff timer) after a failed attempt or a lost
// session. An unusable relay file waits for the file to change instead.
export const SCOPES = PROTOCOL.scopes;
const FRAMES = PROTOCOL.frames;
const SCOPE_VALUES = new Set(Object.values(SCOPES));
const ERROR_CODE_VALUES = new Set(Object.values(PROTOCOL.errorCodes));

const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 10000;
const STATUS_WAIT_MS = 2000;
const DEFAULT_LOOPBACK_DIAL_HOST = 'host.docker.internal';
let loopbackDialHost = DEFAULT_LOOPBACK_DIAL_HOST;

// Test seam: the name dialled for a relay listening on the host's loopback (null restores it).
export function _setLoopbackDialHost(host) { loopbackDialHost = host ?? DEFAULT_LOOPBACK_DIAL_HOST; }

let state = 'off';
let error = null;
let currentAddresses = [];
// Bumped by init() and stop(): async work begun under an older generation is dropped.
let gen = 0;
let stopWatch = null;
let retryTimer = null;
let attempts = 0;
let connecting = false;
let dirty = false;
let session = null; // { token, id, send, close, dial: { host, port }, secret }
const limiter = createLimiter(PROTOCOL.maxHubHandshakes);
// pair key → Set of handles, oldest first; the set's `since` is the number of
// the first ports frame of this session that carried the pair.
const exposures = new Map();
let statuses = new Map(); // pair key → the relay's status entry
// Ports frames sent and status frames received this session. The relay answers
// each ports frame with one status, in order, so status number n answers ports
// frame n — and a pair's entry counts only from the frame that carried it on,
// never from an answer about an earlier exposure of the same pair.
let portsSent = 0;
let statusesSeen = 0;
const pipes = new Set(); // data-connection closers of the current session
const statusWaiters = new Set();

const pairKey = (port, scope) => `${port}/${scope}`;

// Test seam: handshakes currently holding a limiter slot.
export function _handshakesInFlight() { return limiter.inFlight; }

// Where to dial a relay that listens on `listenHost`: a loopback listener is
// reached through the Docker Desktop host name; any other address as written,
// then the container's default gateway.
export function dialCandidates(listenHost, gateway, loopbackHost = loopbackDialHost) {
  if (net.isIPv4(listenHost) && listenHost.startsWith('127.')) return [loopbackHost];
  return [...new Set([listenHost, gateway].filter(Boolean))];
}

export async function init() {
  stop();
  const myGen = gen;
  try {
    await relayStore.ensureSecret();
  } catch (e) {
    console.error(`[hostRelay] ${e.message} — the host relay stays off`);
    return;
  }
  if (myGen !== gen || !runningInContainer()) return;
  state = 'absent';
  stopWatch = relayStore.watchHost(onHostChange);
  evaluate();
}

// Ends the session (the relay closes every host listener with it) and stops
// watching. Exposures stay registered, so a later init() carries them again.
export function stop() {
  gen += 1;
  stopWatch?.();
  stopWatch = null;
  clearTimeout(retryTimer);
  retryTimer = null;
  attempts = 0;
  connecting = false;
  dirty = false;
  const s = session;
  session = null;
  s?.close();
  dropSessionState();
  state = 'off';
  error = null;
  notifyAll();
}

export function status() {
  return { state, error, addresses: [...currentAddresses] };
}

// The relay's advertised LAN addresses while the session is up, else [].
export function addresses() {
  return state === 'up' ? [...currentAddresses] : [];
}

function dropSessionState() {
  statuses = new Map();
  portsSent = 0;
  statusesSeen = 0;
  currentAddresses = [];
  for (const p of [...pipes]) p.close();
  pipes.clear();
  for (const w of [...statusWaiters]) w();
}

function setState(next, why) {
  if (why && why !== error) console.error(`[hostRelay] ${why}`);
  state = next;
  error = why;
  notifyAll();
}

function onHostChange() {
  if (state === 'off' || state === 'up') return;
  if (connecting) { dirty = true; return; }
  attempts = 0;
  evaluate();
}

function scheduleRetry(why) {
  const delay = Math.min(BACKOFF_BASE_MS * 2 ** attempts, BACKOFF_CAP_MS);
  attempts += 1;
  setState('retrying', why);
  retryTimer = setTimeout(evaluate, delay);
  retryTimer.unref();
}

async function evaluate() {
  const myGen = gen;
  clearTimeout(retryTimer);
  retryTimer = null;
  if (state === 'off' || state === 'up' || connecting) return;
  connecting = true;
  dirty = false;
  try {
    const host = await relayStore.readHost();
    if (myGen !== gen) return;
    if (!host) { setState('absent', null); return; }
    if (host.error) { setState('retrying', host.error); return; } // until the file changes
    setState('connecting', error);
    let secret;
    try { secret = await relayStore.ensureSecret(); } catch (e) { if (myGen === gen) scheduleRetry(e.message); return; }
    const token = {};
    let opened = null;
    let dial = null;
    let lastError = null;
    for (const candidate of dialCandidates(host.listenHost, defaultGatewayIPv4())) {
      try {
        opened = await openControl({
          host: candidate, port: host.listenPort, secret, limiter,
          onFrame: (f) => onFrame(token, f),
          onClose: (why) => onSessionClose(token, why),
        });
        dial = candidate;
        break;
      } catch (e) {
        lastError = e;
        if (myGen !== gen) return;
      }
    }
    if (myGen !== gen) { opened?.close(); return; }
    if (!opened) { scheduleRetry(lastError.message); return; }
    session = { ...opened, token, dial: { host: dial, port: host.listenPort }, secret };
    attempts = 0;
    currentAddresses = opened.addresses;
    for (const set of exposures.values()) set.since = 1;
    console.error(`[hostRelay] connected to the relay at ${dial}:${host.listenPort} (session ${opened.id})`);
    setState('up', null);
    sendPorts();
  } finally {
    if (myGen === gen) {
      connecting = false;
      if (dirty && state !== 'up') { dirty = false; attempts = 0; evaluate(); }
    }
  }
}

function onSessionClose(token, why) {
  if (!session || session.token !== token) return;
  session = null;
  dropSessionState();
  scheduleRetry(`connection to the relay lost: ${why}`);
}

const STATUS_SHAPE = { t: isStr, addresses: isArr, ports: isArr };
const INCOMING_SHAPE = { t: isStr, port: isInt, scope: isStr, conn: isStr };
const BOUND_SHAPE = { port: isInt, scope: isStr, hostPort: isInt, fallback: isBool };
const REFUSED_SHAPE = { port: isInt, scope: isStr, code: isStr, message: isStr };

// Whether the relay can expose container port `p` at all (relay/protocol.json's port range).
export const inPortRange = (p) => Number.isInteger(p) && p >= PROTOCOL.port.min && p <= PROTOCOL.port.max;

function onFrame(token, f) {
  if (!session || session.token !== token) return;
  if (f.t === FRAMES.status) applyStatus(f);
  else if (f.t === FRAMES.incoming) onIncoming(f);
  else throw new Error(`unexpected ${JSON.stringify(f.t)} frame`);
}

function applyStatus(f) {
  checkShape(f, STATUS_SHAPE, 'a status frame');
  if (f.addresses.length > PROTOCOL.maxAddresses || !f.addresses.every((a) => typeof a === 'string' && net.isIPv4(a))) {
    throw new Error('a status frame carries malformed addresses');
  }
  statusesSeen += 1;
  const next = new Map();
  for (const e of f.ports) {
    checkShape(e, e && typeof e === 'object' && 'code' in e ? REFUSED_SHAPE : BOUND_SHAPE, 'a status entry');
    if (!inPortRange(e.port) || !SCOPE_VALUES.has(e.scope)) throw new Error('a status entry names an invalid port or scope');
    if ('code' in e ? !ERROR_CODE_VALUES.has(e.code) : (e.hostPort < 1 || e.hostPort > 65535)) throw new Error('a status entry is malformed');
    const key = pairKey(e.port, e.scope);
    if (exposures.get(key)?.since <= statusesSeen) next.set(key, e);
  }
  statuses = next;
  currentAddresses = f.addresses;
  for (const w of [...statusWaiters]) w();
  notifyAll();
}

function onIncoming(f) {
  checkShape(f, INCOMING_SHAPE, 'an incoming frame');
  if (!inPortRange(f.port) || !SCOPE_VALUES.has(f.scope) || !ID_RE.test(f.conn)) throw new Error('an incoming frame is malformed');
  const handles = exposures.get(pairKey(f.port, f.scope));
  if (!handles?.size) return; // unexposed meanwhile: the relay drops the client after --accept-wait-ms
  const target = [...handles].at(-1).target;
  const s = session;
  const closer = openData({
    host: s.dial.host, port: s.dial.port, secret: s.secret, limiter,
    session: s.id, conn: f.conn, target,
    onClose: () => pipes.delete(closer),
  });
  pipes.add(closer);
}

function sendPorts() {
  if (state !== 'up' || !session) return;
  portsSent += 1;
  const ports = [...exposures.values()].map((set) => {
    const { port, scope } = set.values().next().value;
    return { port, scope };
  });
  session.send({ t: FRAMES.ports, ports });
}

function infoFor(h) {
  if (state === 'off' || state === 'absent') return null;
  const down = (why) => ({ state: 'down', error: why, port: null, requestedPort: h.port, portFallback: false });
  if (state !== 'up') return down(error);
  const s = statuses.get(h.key);
  if (!s) return down('waiting for the relay to bind the port');
  if ('code' in s) return { state: 'failed', error: s.message, port: null, requestedPort: h.port, portFallback: false };
  return { state: 'up', error: null, port: s.hostPort, requestedPort: h.port, portFallback: s.fallback };
}

// What a handle's owner sees: its info, plus the addresses for a LAN pair
// (they are part of its URLs).
const snapshot = (h) => JSON.stringify([infoFor(h), h.scope === SCOPES.lan ? addresses() : null]);

function notifyAll() {
  for (const set of exposures.values()) {
    for (const h of set) {
      const snap = snapshot(h);
      if (snap === h.last) continue;
      h.last = snap;
      try { h.onChange(); } catch (e) { console.error(`[hostRelay] a change handler for port ${h.port} failed: ${e.message}`); }
    }
  }
}

function waitStatus(key) {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); statusWaiters.delete(check); resolve(); };
    const check = () => { if (state !== 'up' || statuses.has(key)) done(); };
    const timer = setTimeout(done, STATUS_WAIT_MS);
    timer.unref();
    statusWaiters.add(check);
  });
}

// Expose container `port` in `scope` (a value of SCOPES): host clients reach
// `target` ({ host, port }) through the relay while a session is up.
// onChange() fires whenever info() — or, for a LAN pair, the advertised
// addresses — changes. `ready` resolves once the relay reported on this pair,
// after STATUS_WAIT_MS, or at once when no session is up. close() is idempotent.
export function expose(port, scope, target, onChange = () => {}) {
  if (!SCOPE_VALUES.has(scope)) throw new Error(`unknown relay scope ${JSON.stringify(scope)}`);
  if (!inPortRange(port)) throw new Error(`port ${port} is outside the relay's port range`);
  const key = pairKey(port, scope);
  const h = { key, port, scope, target, onChange, last: null };
  const isNew = !exposures.has(key);
  if (isNew) exposures.set(key, Object.assign(new Set(), { since: portsSent + 1 }));
  exposures.get(key).add(h);
  h.last = snapshot(h);
  if (isNew) sendPorts();
  const ready = state !== 'up' || statuses.has(key) ? Promise.resolve() : waitStatus(key);
  let closed = false;
  return {
    ready,
    info: () => (closed ? null : infoFor(h)),
    hostPort: () => {
      const info = closed ? null : infoFor(h);
      return info?.state === 'up' ? info.port : null;
    },
    close() {
      if (closed) return;
      closed = true;
      const set = exposures.get(key);
      if (!set?.delete(h) || set.size) return;
      exposures.delete(key);
      statuses.delete(key);
      sendPorts();
    },
  };
}
