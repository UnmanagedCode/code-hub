import http from 'node:http';
import net from 'node:net';
import { readFileSync } from 'node:fs';

// Client for the host relay (relay/relay.py): when code-hub runs in a
// bridge-networked container, a LAN share is exposed on the HOST's LAN address
// through a relay forward instead of the container's unreachable bridge IP.
//
// code-hub dials out to the relay and parks upgraded HTTP connections on a
// forward; the relay splices each LAN connection onto one, and code-hub pipes it
// to the share's own auth proxy, which the relay never learns. The wire protocol
// is defined once, in relay/protocol.json, and read here — never restated.
const PROTOCOL = JSON.parse(readFileSync(new URL('../relay/protocol.json', import.meta.url), 'utf8'));
const PATHS = PROTOCOL.paths;

const ACCEPT_POOL = 4;
const REPARK_FLOOR_MS = 250;
const REPARK_BACKOFF_MS = 1000;
// Control answers are small JSON objects; anything bigger is refused unread.
const MAX_ANSWER_BYTES = 64 * 1024;
// setTimeout's ceiling: a longer delay fires after 1ms instead.
const MAX_TIMER_MS = 2 ** 31 - 1;
let requestTimeoutMs = 3000;

// Test seam: the per-request timeout of control calls (create, renew, delete).
export function _setRequestTimeoutMs(ms) { requestTimeoutMs = ms; }

const withId = (template, id) => template.replace('{id}', encodeURIComponent(id));

// The environment variables that configure the relay. The secret is a
// capability to listen on the host's LAN, so runner.js strips both from every
// app it spawns.
export const RELAY_ENV = Object.freeze({ url: 'CODEHUB_RELAY_URL', secret: 'CODEHUB_RELAY_SECRET' });

// The relay to use, read from the environment on every call (like
// PROJECTS_ROOT): null when CODEHUB_RELAY_URL is unset (the feature is off),
// else { url, host, port, secret, error } — `error` set when the config can't
// work, which fails the forward with that reason rather than the share.
export function relayConfig() {
  const url = process.env[RELAY_ENV.url];
  if (!url) return null;
  const secret = process.env[RELAY_ENV.secret]?.trim() ?? '';
  let parsed;
  try { parsed = new URL(url); } catch {
    return { url, error: `CODEHUB_RELAY_URL '${url}' is not a URL` };
  }
  if (parsed.protocol !== 'http:') return { url, error: `CODEHUB_RELAY_URL must be an http: URL, got '${url}'` };
  if (!secret) return { url, error: 'CODEHUB_RELAY_URL is set but CODEHUB_RELAY_SECRET is empty — set it to the contents of the relay\'s secret file' };
  return { url, host: parsed.hostname, port: Number(parsed.port) || 80, secret, error: null };
}

function relayError(message, extra = {}) {
  return Object.assign(new Error(message), extra);
}

// One control call: resolves { status, body } (body parsed as JSON when it is
// some), rejects on a network error or after requestTimeoutMs.
function call(cfg, method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: cfg.host, port: cfg.port, method, path, agent: false,
      headers: {
        Authorization: `Bearer ${cfg.secret}`,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_ANSWER_BYTES) req.destroy(relayError(`the relay's answer is malformed (larger than ${MAX_ANSWER_BYTES} bytes)`));
        else chunks.push(c);
      });
      res.on('end', () => {
        clearTimeout(timer);
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
        resolve({ status: res.statusCode, body: parsed });
      });
      res.on('error', reject);
    });
    const timer = setTimeout(() => req.destroy(relayError(`the relay at ${cfg.url} did not answer within ${requestTimeoutMs}ms`)), requestTimeoutMs);
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.end(payload ?? undefined);
  });
}

function describeFailure(cfg, status, body) {
  if (status === 401) return `the relay at ${cfg.url} refused CODEHUB_RELAY_SECRET (401)`;
  return `the relay answered ${status}${body?.error ? `: ${body.error}` : ''}`;
}

// POST a forward, falling back to a free port when the requested one is busy.
// Resolves { id, port, addresses, leaseMs, portFallback }.
async function createForward(cfg, port) {
  let res = await call(cfg, 'POST', PATHS.forwards, port ? { port } : {});
  let portFallback = false;
  if (port && res.status === 409 && res.body?.code === PROTOCOL.errorCodes.portInUse) {
    res = await call(cfg, 'POST', PATHS.forwards, {});
    portFallback = true;
  }
  if (res.status !== 201) throw relayError(describeFailure(cfg, res.status, res.body), { status: res.status, code: res.body?.code });
  const body = res.body;
  const id = body && typeof body === 'object' ? body.id : undefined;
  const discard = () => { if (typeof id === 'string' && id) call(cfg, 'DELETE', withId(PATHS.forward, id)).catch(() => {}); };
  // Malformed before mismatched: a garbled answer must be named as such, not
  // read as a version it never stated.
  const malformed = createdProblem(body);
  if (malformed) {
    discard();
    throw relayError(`the relay's create response is malformed (${malformed})`);
  }
  if (body.protocol !== PROTOCOL.protocolVersion) {
    discard();
    throw relayError(`relay speaks protocol ${body.protocol}, this code-hub speaks ${PROTOCOL.protocolVersion} — update the relay/ copy on the host`);
  }
  return { id, port: body.port, addresses: body.addresses, leaseMs: body.leaseMs, portFallback };
}

// Why a 201 create body can't be used, or null. Checked here, at the boundary,
// so nothing downstream ever builds URLs or timers from a half-formed forward.
function createdProblem(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'not a JSON object';
  const { protocol, id, port, addresses, leaseMs } = body;
  if (!Number.isInteger(protocol)) return `protocol ${JSON.stringify(protocol)}`;
  if (typeof id !== 'string' || !id) return 'no forward id';
  if (!Number.isInteger(port) || port < PROTOCOL.port.min || port > PROTOCOL.port.max) return `port ${JSON.stringify(port)}`;
  if (!Array.isArray(addresses) || !addresses.length || !addresses.every((a) => typeof a === 'string' && net.isIPv4(a))) return 'addresses is not a non-empty list of IPv4 addresses';
  if (addresses.length > PROTOCOL.maxAddresses) return `${addresses.length} addresses, more than ${PROTOCOL.maxAddresses}`;
  if (!Number.isInteger(leaseMs) || leaseMs <= 0 || leaseMs > PROTOCOL.maxLeaseMs) return `leaseMs ${JSON.stringify(leaseMs)}`;
  return null;
}

// Live handles by their current forward id, so release() can close the one
// that owns an id.
const handles = new Map();

// Open a forward on the relay, at `port` when given (falling back to a free one
// if the host's port is busy — `portFallback`). Rejects with the reason when
// the relay is misconfigured, unreachable, refuses, or speaks another protocol.
//
// The handle renews the lease every leaseMs/3. A lost forward (404, or the
// relay unreachable) goes `down`, and each later tick re-creates it on the same
// port; every state change calls `onChange({ prevId })`. `attach({ host, port })`
// starts parking accepts that are piped to that local target. `close()` stops
// everything, cuts live connections and deletes the forward (best effort).
export async function openForward({ port, onChange = () => {} } = {}) {
  const cfg = relayConfig();
  if (!cfg) throw relayError('the host relay is not configured (CODEHUB_RELAY_URL is unset)');
  if (cfg.error) throw relayError(cfg.error);
  const fwd = await createForward(cfg, port);
  return makeHandle(cfg, fwd, { requestedPort: port ?? null, onChange });
}

function makeHandle(cfg, fwd, { requestedPort, onChange }) {
  let { id, port: boundPort, addresses, leaseMs, portFallback } = fwd;
  let state = 'up';
  let error = null;
  let closed = false;
  let target = null;
  let ticking = false;
  const parks = new Set(); // pending accept requests
  const pipes = new Set(); // live spliced sockets
  const timers = new Set(); // lease ticks
  const parkTimers = new Set(); // slots waiting to re-park
  // The pool is ACCEPT_POOL slots, each a loop of park → (splice) → re-park.
  // A drain bumps `poolGen` and forgets every slot at once, so a callback of a
  // drained slot (a destroyed request's error, a pending re-park) is a no-op and
  // the next fill starts exactly ACCEPT_POOL fresh ones.
  let poolGen = 0;
  let slots = 0;

  const later = (fn, ms, set = timers) => {
    const t = setTimeout(() => { set.delete(t); fn(); }, ms);
    t.unref();
    set.add(t);
  };

  // --- accept pool --------------------------------------------------------
  const runSlot = (gen) => {
    if (gen !== poolGen) return;
    if (closed || state !== 'up' || !target) { slots -= 1; return; }
    const startedAt = Date.now();
    const forwardId = id;
    const again = (minDelay) => {
      if (gen !== poolGen) return;
      later(() => runSlot(gen), Math.max(minDelay, REPARK_FLOOR_MS - (Date.now() - startedAt)), parkTimers);
    };
    const req = http.request({
      host: cfg.host, port: cfg.port, method: 'GET', path: withId(PATHS.accept, forwardId), agent: false,
      headers: { Authorization: `Bearer ${cfg.secret}`, Connection: 'Upgrade', Upgrade: PROTOCOL.upgradeToken },
    });
    parks.add(req);
    let settled = false;
    const settle = () => { if (settled) return false; settled = true; parks.delete(req); return true; };
    req.on('socket', (s) => s.setKeepAlive(true, 15000));
    req.on('upgrade', (_res, socket, head) => {
      if (!settle()) { socket.destroy(); return; }
      if (closed) { socket.destroy(); return; }
      pipe(socket, head);
      again(0);
    });
    req.on('response', (res) => {
      res.resume();
      if (!settle()) return;
      if (res.statusCode === 404 && forwardId === id && gen === poolGen) markDown(`the relay no longer knows forward ${forwardId}`);
      else again(REPARK_BACKOFF_MS);
    });
    req.on('error', () => { if (settle()) again(REPARK_BACKOFF_MS); });
    req.end();
  };

  const pipe = (socket, head) => {
    const up = net.connect(target.port, target.host);
    pipes.add(socket); pipes.add(up);
    if (head?.length) up.write(head);
    socket.pipe(up);
    up.pipe(socket);
    const done = () => { socket.destroy(); up.destroy(); pipes.delete(socket); pipes.delete(up); };
    socket.on('error', done); up.on('error', done);
    socket.on('close', done); up.on('close', done);
  };

  const fillPool = () => {
    if (closed || state !== 'up' || !target) return;
    while (slots < ACCEPT_POOL) { slots += 1; runSlot(poolGen); }
  };
  const drainPool = () => {
    poolGen += 1;
    slots = 0;
    for (const t of parkTimers) clearTimeout(t);
    parkTimers.clear();
    for (const req of parks) req.destroy();
    parks.clear();
  };

  // --- lease ---------------------------------------------------------------
  const emit = (prevId) => { try { onChange({ prevId }); } catch (e) { console.error(`[hostRelay] onChange failed: ${e.message}`); } };

  const markDown = (why) => {
    if (closed || state !== 'up') return;
    state = 'down'; error = why;
    drainPool();
    console.error(`[hostRelay] forward ${id} is down (${why}) — retrying`);
    emit(id);
  };

  const tick = async () => {
    if (closed || ticking) return;
    ticking = true;
    try {
      if (state === 'up') {
        const res = await call(cfg, 'POST', withId(PATHS.renew, id)).catch((e) => ({ status: 0, error: e }));
        if (closed) return;
        if (res.status === 200) return;
        markDown(res.status ? describeFailure(cfg, res.status, res.body) : `the relay at ${cfg.url} is unreachable: ${res.error.message}`);
      } else {
        let next;
        try { next = await createForward(cfg, boundPort); } catch (e) { error = e.message; return; }
        if (closed) { call(cfg, 'DELETE', withId(PATHS.forward, next.id)).catch(() => {}); return; }
        const prevId = id;
        handles.delete(prevId);
        ({ id, port: boundPort, addresses, leaseMs } = next);
        portFallback = portFallback || next.portFallback;
        handles.set(id, handle);
        state = 'up'; error = null;
        console.error(`[hostRelay] forward re-created as ${id} on port ${boundPort}`);
        emit(prevId);
        fillPool();
      }
    } finally {
      ticking = false;
      scheduleTick();
    }
  };
  const scheduleTick = () => { if (!closed) later(tick, Math.min(MAX_TIMER_MS, Math.max(50, Math.floor(leaseMs / 3)))); };

  const handle = {
    get id() { return id; },
    get port() { return boundPort; },
    get addresses() { return addresses; },
    get state() { return state; },
    get error() { return error; },
    get portFallback() { return portFallback; },
    requestedPort,
    attach(t) {
      if (closed || target) return;
      target = t;
      fillPool();
    },
    // Idempotent. Resolves once the relay answered the DELETE (or it failed).
    close() {
      if (closed) return Promise.resolve();
      closed = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      drainPool();
      for (const s of pipes) s.destroy();
      pipes.clear();
      handles.delete(id);
      return state === 'up' ? call(cfg, 'DELETE', withId(PATHS.forward, id)).then(() => {}, () => {}) : Promise.resolve();
    },
  };
  handles.set(id, handle);
  scheduleTick();
  return handle;
}

// Release forward `forwardId`: close the live handle that owns it, else send a
// best-effort DELETE (a forward left by an earlier code-hub process). Never
// throws; idempotent. The lease is the backstop when the relay can't be reached.
export function release(forwardId) {
  if (!forwardId) return Promise.resolve();
  const live = handles.get(forwardId);
  if (live) return live.close();
  const cfg = relayConfig();
  if (!cfg || cfg.error) return Promise.resolve();
  return call(cfg, 'DELETE', withId(PATHS.forward, forwardId)).then(() => {}, () => {});
}
