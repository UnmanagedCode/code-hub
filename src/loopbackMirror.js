import * as hostRelay from './hostRelay.js';

// Every running app's port, mirrored onto the Docker host's 127.0.0.1 through
// the host relay (loopback scope: the relay binds it on loopback only, no TLS
// and no login — the same trust as an ordinary local dev server). The set is
// derived from appManager's store on every change; nothing is persisted, and
// the host port shows up in the app's URLs live (see appUrls.js).
const LOCAL_HOST = '127.0.0.1';
const mirrors = new Map(); // app id → { port, handle }

// Make the mirrored set exactly `desired` ([{ id, port }]), less any port the
// relay can't expose. Idempotent.
export function sync(desired) {
  const want = new Map(desired.filter((d) => hostRelay.inPortRange(d.port)).map((d) => [d.id, d.port]));
  for (const [id, m] of mirrors) {
    if (want.get(id) === m.port) continue;
    m.handle.close();
    mirrors.delete(id);
  }
  for (const [id, port] of want) {
    if (mirrors.has(id)) continue;
    mirrors.set(id, { port, handle: hostRelay.expose(port, hostRelay.SCOPES.loopback, { host: LOCAL_HOST, port }) });
  }
}

// The host loopback port app `id` is mirrored on right now, or null.
export function hostPort(id) {
  return mirrors.get(id)?.handle.hostPort() ?? null;
}

// Test seam: drop every mirror.
export function reset() {
  for (const m of mirrors.values()) m.handle.close();
  mirrors.clear();
}
