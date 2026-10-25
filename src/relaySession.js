import net from 'node:net';
import crypto from 'node:crypto';
import { PROTOCOL } from './relayProtocol.js';

// The wire client for the host relay (relay/relay.py): newline-delimited JSON
// frames over raw TCP, a mutual HMAC challenge-response on every connection
// (the secret itself never crosses the wire), the long-lived control session,
// and the on-demand data connections that carry one host client each.
const { frames: FRAMES, roles: ROLES, macLabels: LABELS, errorCodes: ERROR_CODES } = PROTOCOL;

export const CONNECT_TIMEOUT_MS = 2000;
const DEFAULT_TIMINGS = Object.freeze({
  pingIntervalMs: PROTOCOL.pingIntervalMs,
  keepaliveTimeoutMs: PROTOCOL.keepaliveTimeoutMs,
  handshakeTimeoutMs: PROTOCOL.handshakeTimeoutMs,
});
let timings = DEFAULT_TIMINGS;

// Test seam: shorter ping / silence / handshake timings (null restores protocol.json's).
export function _setTimings(over) { timings = over ? { ...DEFAULT_TIMINGS, ...over } : DEFAULT_TIMINGS; }

const NONCE_RE = new RegExp(`^[A-Za-z0-9_-]{${Math.ceil((PROTOCOL.nonceBytes * 8) / 6)}}$`);
const MAC_RE = /^[0-9a-f]{64}$/;
export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const isStr = (v) => typeof v === 'string';
export const isInt = (v) => Number.isInteger(v);
export const isBool = (v) => typeof v === 'boolean';
export const isArr = (v) => Array.isArray(v);

const BARE_SHAPE = { t: isStr };
const HELLO_SHAPE = { t: isStr, v: isInt, nonce: isStr };
const ERROR_SHAPE = { t: isStr, code: isStr, message: isStr };
const WELCOME_SHAPES = {
  [ROLES.control]: { t: isStr, mac: isStr, session: isStr, addresses: isArr },
  [ROLES.data]: { t: isStr, mac: isStr },
};

export function relayError(message, code) {
  return Object.assign(new Error(message), { code });
}

const badFrame = (message) => relayError(message, ERROR_CODES.badFrame);

// Throws bad_frame unless `obj` has exactly the keys of `shape`, each passing
// its check.
export function checkShape(obj, shape, what) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw badFrame(`${what} is not an object`);
  const want = Object.keys(shape);
  const keys = Object.keys(obj);
  if (keys.length !== want.length || !keys.every((k) => Object.hasOwn(shape, k))) {
    throw badFrame(`${what} must have exactly the keys ${[...want].sort().join(', ')}`);
  }
  for (const k of want) if (!shape[k](obj[k])) throw badFrame(`${what}: ${k} is malformed`);
}

export function encodeFrame(frame) {
  return `${JSON.stringify(frame)}\n`;
}

function parseFrame(line) {
  let f;
  try { f = JSON.parse(line); } catch { throw badFrame('a frame from the relay is not JSON'); }
  if (!f || typeof f !== 'object' || Array.isArray(f) || typeof f.t !== 'string') throw badFrame('a frame from the relay is not an object with a string t');
  return f;
}

// Frames off `socket`, one at a time. Lines are cut lazily, only when asked
// for, so the bytes after the last frame read stay untouched: `detach()`
// stops reading and hands them back (a data connection's first client bytes).
export function lineReader(socket, maxBytes) {
  let buf = Buffer.alloc(0);
  let ended = false;
  let failure = null;
  let waiter = null;
  const wake = () => { const w = waiter; waiter = null; w?.(); };
  const onData = (chunk) => { buf = buf.length ? Buffer.concat([buf, chunk]) : chunk; wake(); };
  const onEnd = () => { ended = true; wake(); };
  const onError = (e) => { failure = e; wake(); };
  socket.on('data', onData);
  socket.on('end', onEnd);
  socket.on('close', onEnd);
  socket.on('error', onError);
  const take = () => {
    const i = buf.indexOf(10);
    if ((i === -1 ? buf.length : i + 1) > maxBytes) throw badFrame(`a frame from the relay is longer than ${maxBytes} bytes`);
    if (i === -1) return undefined;
    const line = buf.subarray(0, i).toString('utf8');
    buf = buf.subarray(i + 1);
    return parseFrame(line);
  };
  return {
    // The next frame, or null at EOF. Rejects on a socket error or a bad frame.
    async next() {
      for (;;) {
        const f = take();
        if (f !== undefined) return f;
        if (failure) throw failure;
        if (ended) return null;
        await new Promise((r) => { waiter = r; });
      }
    },
    detach() {
      socket.pause();
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('close', onEnd);
      socket.off('error', onError);
      const rest = buf;
      buf = Buffer.alloc(0);
      return rest;
    },
  };
}

export function mac(secret, label, role, nonceRelay, nonceHub, session = '', conn = '') {
  return crypto.createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update([label, role, nonceRelay, nonceHub, session, conn].join('\n'), 'utf8')
    .digest('hex');
}

// Constant-time comparison of a MAC against the expected one.
export function verifyMac(expected, given) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Authenticate one connection as `role`. Resolves { welcome, head } once the
// relay has proven the secret (head: the bytes after the welcome, data role
// only). Rejects with `code`: the relay's error code, 'impostor', the
// version-mismatch code, the bad-frame code or 'closed'.
export async function handshake(socket, reader, { secret, role, session = '', conn = '', where }) {
  const hello = await reader.next();
  if (hello === null) throw relayError(`the relay at ${where} closed the connection before its hello`, 'closed');
  if (hello.t !== FRAMES.hello) throw badFrame(`the relay at ${where} sent ${JSON.stringify(hello.t)} instead of its hello`);
  if (Number.isInteger(hello.v) && hello.v !== PROTOCOL.protocolVersion) {
    throw relayError(`the relay at ${where} speaks protocol ${hello.v}, this code-hub speaks ${PROTOCOL.protocolVersion} — update the relay/ copy on the host`, ERROR_CODES.versionMismatch);
  }
  checkShape(hello, HELLO_SHAPE, 'the relay hello');
  if (!NONCE_RE.test(hello.nonce)) throw badFrame('the relay hello carries a malformed nonce');
  const nonceHub = crypto.randomBytes(PROTOCOL.nonceBytes).toString('base64url');
  socket.write(encodeFrame({
    t: FRAMES.auth, v: PROTOCOL.protocolVersion, role, nonce: nonceHub,
    mac: mac(secret, LABELS.hub, role, hello.nonce, nonceHub, session, conn),
    ...(role === ROLES.data ? { session, conn } : {}),
  }));
  const reply = await reader.next();
  if (reply === null) throw relayError(`the relay at ${where} closed the connection during the handshake`, 'closed');
  if (reply.t === FRAMES.error) {
    checkShape(reply, ERROR_SHAPE, 'the relay error');
    throw relayError(`the relay at ${where} refused the connection: ${reply.message}`, reply.code);
  }
  if (reply.t !== FRAMES.welcome) throw badFrame(`the relay at ${where} sent ${JSON.stringify(reply.t)} instead of its welcome`);
  checkShape(reply, WELCOME_SHAPES[role], 'the relay welcome');
  // Nothing from the welcome is used, data bytes included, before this check.
  if (!MAC_RE.test(reply.mac) || !verifyMac(mac(secret, LABELS.relay, role, hello.nonce, nonceHub, session, conn), reply.mac)) {
    throw relayError(`the relay at ${where} could not prove the secret`, 'impostor');
  }
  if (role === ROLES.control) {
    if (!ID_RE.test(reply.session)) throw badFrame('the relay welcome carries a malformed session id');
    if (reply.addresses.length > PROTOCOL.maxAddresses || !reply.addresses.every((a) => typeof a === 'string' && net.isIPv4(a))) {
      throw badFrame('the relay welcome carries malformed addresses');
    }
  }
  return { welcome: reply, head: role === ROLES.data ? reader.detach() : null };
}

function withTimeout(promise, ms, where) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(relayError(`the relay at ${where} did not complete the handshake within ${ms}ms`, 'timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// `allowHalfOpen`: a data connection carries one client's TCP stream, whose
// half-close (FIN after its last request byte) must not cut the reply.
function connect(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port, allowHalfOpen: true });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(relayError(`connecting to the relay at ${host}:${port} timed out after ${CONNECT_TIMEOUT_MS}ms`, 'timeout'));
    }, CONNECT_TIMEOUT_MS);
    const onError = (e) => { clearTimeout(timer); reject(e); };
    socket.once('error', onError);
    socket.once('connect', () => { clearTimeout(timer); socket.off('error', onError); resolve(socket); });
  });
}

// At most `max` jobs at once; the rest wait, first in first out. Every
// handshake runs inside one, from TCP connect until it settles, which is what
// keeps code-hub below the relay's cap on unauthenticated connections.
export function createLimiter(max) {
  let active = 0;
  const queue = [];
  const pump = () => {
    while (active < max && queue.length) {
      const job = queue.shift();
      active += 1;
      Promise.resolve().then(job.fn).then(job.resolve, job.reject).finally(() => { active -= 1; pump(); });
    }
  };
  return {
    get inFlight() { return active; },
    run(fn) {
      return new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); pump(); });
    },
  };
}

// Connect and authenticate, inside the limiter; the socket is destroyed on failure.
function dialAndAuth({ host, port, limiter, isCancelled = () => false, ...auth }) {
  const where = `${host}:${port}`;
  return limiter.run(async () => {
    if (isCancelled()) throw relayError('cancelled', 'cancelled');
    const socket = await connect(host, port);
    socket.setNoDelay(true);
    const reader = lineReader(socket, PROTOCOL.maxFrameBytes);
    try {
      if (isCancelled()) throw relayError('cancelled', 'cancelled');
      const { welcome, head } = await withTimeout(handshake(socket, reader, { ...auth, where }), timings.handshakeTimeoutMs, where);
      return { socket, reader, welcome, head };
    } catch (e) {
      socket.destroy();
      throw e;
    }
  });
}

// Open the control session. Resolves { id, addresses, send(frame), close() }
// once authenticated. Answers pings, pings every pingIntervalMs, and closes when
// nothing arrives for keepaliveTimeoutMs (both in relay/protocol.json). Frames
// other than ping/pong/error go to onFrame(frame), which throws to reject one;
// onClose(reason) fires exactly once, whatever closed the session.
export async function openControl({ host, port, secret, limiter, onFrame, onClose }) {
  const { socket, reader, welcome } = await dialAndAuth({ host, port, limiter, secret, role: ROLES.control });
  socket.setKeepAlive(true, PROTOCOL.pingIntervalMs);
  let closed = false;
  let silence = null;
  const send = (frame) => { if (!closed) socket.write(encodeFrame(frame)); };
  const close = (reason) => {
    if (closed) return;
    closed = true;
    clearTimeout(silence);
    clearInterval(pinger);
    socket.destroy();
    try { onClose(reason); } catch (e) { console.error(`[relaySession] onClose failed: ${e.message}`); }
  };
  const heard = () => {
    clearTimeout(silence);
    silence = setTimeout(() => close(`no frame from the relay for over ${timings.keepaliveTimeoutMs}ms`), timings.keepaliveTimeoutMs);
    silence.unref();
  };
  const pinger = setInterval(() => send({ t: FRAMES.ping }), timings.pingIntervalMs);
  pinger.unref();
  socket.on('error', () => {}); // the reader reports it
  heard();
  const loop = async () => {
    for (;;) {
      let f;
      try { f = await reader.next(); } catch (e) { close(e.message); return; }
      if (closed) return;
      if (f === null) { close('the relay closed the connection'); return; }
      heard();
      try {
        if (f.t === FRAMES.ping) { checkShape(f, BARE_SHAPE, 'a ping frame'); send({ t: FRAMES.pong }); }
        else if (f.t === FRAMES.pong) checkShape(f, BARE_SHAPE, 'a pong frame');
        else if (f.t === FRAMES.error) {
          checkShape(f, ERROR_SHAPE, 'an error frame');
          close(`the relay ended the session: ${f.message} (${f.code})`);
          return;
        } else onFrame(f);
      } catch (e) {
        close(`a bad frame from the relay: ${e.message}`);
        return;
      }
    }
  };
  // Started on the next turn, so the caller holds the session before any frame arrives.
  setImmediate(loop);
  return { id: welcome.session, addresses: welcome.addresses, send, close: () => close('closed by code-hub') };
}

// Claim host client `conn` of `session` with one fresh data connection, then
// pipe it to `target` ({ host, port }), the bytes after the welcome first.
// Returns a closer at once: close() destroys whatever exists (and cancels a
// handshake still queued); onClose() fires once when the pipe or the attempt ends.
export function openData({ host, port, secret, limiter, session, conn, target, onClose = () => {} }) {
  const sockets = new Set();
  let closed = false;
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    for (const s of sockets) s.destroy();
    sockets.clear();
    onClose();
  };
  const closer = { close() { closed = true; end(); } };
  dialAndAuth({ host, port, limiter, secret, role: ROLES.data, session, conn, isCancelled: () => closed }).then(({ socket, head }) => {
    if (closed) { socket.destroy(); return; }
    const up = net.connect({ port: target.port, host: target.host, allowHalfOpen: true });
    sockets.add(socket);
    sockets.add(up);
    for (const s of [socket, up]) { s.on('error', end); s.on('close', end); }
    if (head.length) up.write(head);
    socket.pipe(up);
    up.pipe(socket);
  }, (e) => {
    if (!closed) console.error(`[relaySession] data connection for ${conn} failed: ${e.message}`);
    end();
  });
  return closer;
}
