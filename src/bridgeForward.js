import net from 'node:net';

// The no-relay fallback: each app's port, forwarded from the container's bridge
// address (`host`, see net.bridgeIPv4) to the app on 127.0.0.1, so a browser on
// a native-Linux Docker host can open the app with no host relay running. A
// plain in-process TCP forwarder — no TLS and no login, the same trust as the
// app's own port — bound on that one address only, never 0.0.0.0. The set is
// derived from appManager's store on every change (see syncExposures there);
// nothing is persisted, and the address shows up in the app's URLs live (see
// appUrls.js).
//
// A bind that fails is never retried while the entry's (port, host) stands:
// EADDRINUSE means the app itself holds that address (it bound 0.0.0.0 or the
// bridge address), so the address is shown as is (`direct`); any other error
// leaves the app on its localhost URL (`failed`). Only removing the entry and
// re-creating it binds again — so the forwarder can never take the address
// during the moment a reloading app has let go of it.
const UPSTREAM_HOST = '127.0.0.1';
const entries = new Map(); // app id → { port, host, state, server, pairs, closed }

// Make the forwarded set exactly `desired` ([{ id, port }]) on `host`; a null
// `host` forwards nothing. Idempotent and synchronous: a bind's outcome arrives
// later on its server's events, and nothing is ever thrown to the caller.
export function sync(desired, host) {
  const want = new Map(host ? desired.map((d) => [d.id, d.port]) : []);
  for (const [id, e] of entries) {
    if (want.get(id) === e.port && e.host === host) continue;
    close(e);
    entries.delete(id);
  }
  for (const [id, port] of want) {
    if (!entries.has(id)) entries.set(id, open(id, port, host));
  }
}

// The host app `id` is reachable at through this module right now — its own
// forwarder, or the app itself holding that address — else null.
export function urlHost(id) {
  const e = entries.get(id);
  return e && (e.state === 'bound' || e.state === 'direct') ? e.host : null;
}

// Test seam: drop every forwarder.
export function reset() {
  for (const e of entries.values()) close(e);
  entries.clear();
}

function open(id, port, host) {
  const entry = { port, host, state: 'binding', server: null, pairs: new Set(), closed: false };
  const server = net.createServer((client) => {
    if (entry.closed) { client.destroy(); return; }
    const upstream = net.connect(port, UPSTREAM_HOST);
    const pair = { client, upstream };
    entry.pairs.add(pair);
    // The two sides live and die together: either one closing or failing
    // (an upstream that refuses included) destroys both.
    const drop = () => {
      client.destroy();
      upstream.destroy();
      entry.pairs.delete(pair);
    };
    client.on('error', drop);
    upstream.on('error', drop);
    client.on('close', drop);
    upstream.on('close', drop);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  entry.server = server;
  server.on('listening', () => {
    // Closed while the bind was still pending: close() could not reach a
    // listener that didn't exist yet.
    if (entry.closed) { server.close(); return; }
    entry.state = 'bound';
  });
  server.on('error', (e) => {
    if (entry.closed) return;
    if (entry.state !== 'binding') {
      console.error(`[bridgeForward] ${id}: ${host}:${port} — ${e.message}`);
      return;
    }
    if (e.code === 'EADDRINUSE') {
      entry.state = 'direct';
      console.error(`[bridgeForward] ${id}: ${host}:${port} is already taken — presumably by the app itself; showing it directly`);
    } else {
      entry.state = 'failed';
      console.error(`[bridgeForward] ${id}: could not bind ${host}:${port} — ${e.message}; the Start URL stays on localhost`);
    }
  });
  server.listen(port, host);
  return entry;
}

// server.close() stops accepting but leaves accepted connections up, so every
// pair is destroyed here too.
function close(entry) {
  entry.closed = true;
  if (entry.server.listening) entry.server.close();
  for (const { client, upstream } of entry.pairs) {
    client.destroy();
    upstream.destroy();
  }
  entry.pairs.clear();
}
