import test from 'node:test';
import assert from 'node:assert/strict';
import { appUrls } from '../src/appUrls.js';

// Invariant (S10): without a loopback mirror the primary URL is localhost at
// the app's own port; with one, it is the host's 127.0.0.1 at the mirror's
// host port, while LAN entries keep the app's port; a non-root route path is
// appended to every entry.
test('appUrls: the primary follows the mirror; LAN entries keep the app port; paths append', () => {
  assert.deepEqual(appUrls({ port: 5000, lanIps: ['10.0.0.5'] }), ['http://localhost:5000', 'http://10.0.0.5:5000']);
  assert.deepEqual(appUrls({ port: 5000, lanIps: ['10.0.0.5'], hostLoopbackPort: 41000 }), ['http://127.0.0.1:41000', 'http://10.0.0.5:5000']);
  assert.deepEqual(appUrls({ port: 5000, lanIps: [], hostLoopbackPort: null }), ['http://localhost:5000']);
  assert.deepEqual(appUrls({ port: 5000, routePath: '/edit.html', lanIps: ['10.0.0.5'], hostLoopbackPort: 41000 }),
    ['http://127.0.0.1:41000/edit.html', 'http://10.0.0.5:5000/edit.html']);
  assert.deepEqual(appUrls({ port: 5000, routePath: '/' }), ['http://localhost:5000']);
});

// Invariant (bridge fallback): precedence is mirror > bridge address > localhost,
// decided here alone; the bridge address is dropped from the LAN entries only
// when it is already the primary (a mirror keeps it there); a non-root route
// path is appended to the bridge primary too.
test('appUrls: the bridge address is the primary without a mirror, deduped from the LAN entries', () => {
  const lanIps = ['172.17.0.2', '10.0.0.5'];
  assert.deepEqual(appUrls({ port: 5000, lanIps, bridgeHost: '172.17.0.2' }), ['http://172.17.0.2:5000', 'http://10.0.0.5:5000']);
  assert.deepEqual(appUrls({ port: 5000, lanIps, bridgeHost: '172.17.0.2', hostLoopbackPort: 41000 }),
    ['http://127.0.0.1:41000', 'http://172.17.0.2:5000', 'http://10.0.0.5:5000']);
  assert.deepEqual(appUrls({ port: 5000, lanIps, bridgeHost: null }),
    ['http://localhost:5000', 'http://172.17.0.2:5000', 'http://10.0.0.5:5000']);
  assert.deepEqual(appUrls({ port: 5000, routePath: '/edit.html', lanIps, bridgeHost: '172.17.0.2' }),
    ['http://172.17.0.2:5000/edit.html', 'http://10.0.0.5:5000/edit.html']);
});
