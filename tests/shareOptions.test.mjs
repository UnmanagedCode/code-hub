import test from 'node:test';
import assert from 'node:assert/strict';
import { validateShareOptions, withFunnelPortDefault, FUNNEL_PORTS, DEFAULT_FUNNEL_PORT } from '../src/shareOptions.js';

const status = (fn) => { try { fn(); return null; } catch (e) { return e.statusCode; } };

// The one validation both the share route and a stored auto-share go through:
// a tailscale share always ends up with a Funnel port, and only an allowed one.
test('validateShareOptions: tailscale defaults funnelPort to 443 and keeps an allowed one', () => {
  assert.equal(DEFAULT_FUNNEL_PORT, 443);
  assert.deepEqual(validateShareOptions({ mode: 'tailscale' }), { mode: 'tailscale', auth: true, funnelPort: 443 });
  for (const funnelPort of FUNNEL_PORTS) {
    assert.deepEqual(validateShareOptions({ mode: 'tailscale', funnelPort }), { mode: 'tailscale', auth: true, funnelPort });
  }
});

test('validateShareOptions: a funnelPort outside FUNNEL_PORTS is a 400 in every mode', () => {
  for (const mode of ['tailscale', 'lan', 'tunnel']) {
    for (const funnelPort of [80, '443', null, 8443.5]) {
      assert.equal(status(() => validateShareOptions({ mode, funnelPort })), 400, `${mode} funnelPort=${JSON.stringify(funnelPort)}`);
    }
  }
  assert.throws(() => validateShareOptions({ mode: 'tailscale', funnelPort: 80 }), /'funnelPort' must be one of 443, 8443, 10000/);
});

test('validateShareOptions: lan and tunnel drop a valid funnelPort', () => {
  assert.deepEqual(validateShareOptions({ mode: 'lan', funnelPort: 8443 }), { mode: 'lan', auth: true, tls: true });
  assert.deepEqual(validateShareOptions({ mode: 'tunnel', funnelPort: 8443 }), { mode: 'tunnel', auth: true });
});

test('withFunnelPortDefault fills only a tailscale config, and keeps a stored port', () => {
  assert.deepEqual(withFunnelPortDefault({ mode: 'tailscale', auth: true }), { mode: 'tailscale', auth: true, funnelPort: 443 });
  assert.deepEqual(withFunnelPortDefault({ mode: 'tailscale', auth: true, funnelPort: 10000 }), { mode: 'tailscale', auth: true, funnelPort: 10000 });
  const lan = { mode: 'lan', auth: false, tls: true };
  assert.equal(withFunnelPortDefault(lan), lan);
  const tunnel = { mode: 'tunnel', auth: true };
  assert.equal(withFunnelPortDefault(tunnel), tunnel);
});
