import test from 'node:test';
import assert from 'node:assert/strict';
import { isEmbedded, hostConductorPort, isHostConductorId } from '../src/hostConductor.js';

function withEnv(vars, fn) {
  return async (t) => {
    for (const [k, v] of Object.entries(vars)) process.env[k] = v;
    t.after(() => { for (const k of Object.keys(vars)) delete process.env[k]; });
    await fn(t);
  };
}

test('isEmbedded: false when neither env var is set', () => {
  delete process.env.CONDUCTOR_PLUGIN_ID;
  delete process.env.CONDUCTOR_URL;
  assert.equal(isEmbedded(), false);
});

test('isEmbedded: false when only one env var is set', withEnv({ CONDUCTOR_PLUGIN_ID: 'code-hub' }, () => {
  delete process.env.CONDUCTOR_URL;
  assert.equal(isEmbedded(), false);
}));

test('isEmbedded: true when both env vars are set', withEnv({ CONDUCTOR_PLUGIN_ID: 'code-hub', CONDUCTOR_URL: 'http://127.0.0.1:5000' }, () => {
  assert.equal(isEmbedded(), true);
}));

test('hostConductorPort: null when not embedded', () => {
  delete process.env.CONDUCTOR_PLUGIN_ID;
  delete process.env.CONDUCTOR_URL;
  assert.equal(hostConductorPort(), null);
});

test('hostConductorPort: parses the explicit port', withEnv({ CONDUCTOR_PLUGIN_ID: 'code-hub', CONDUCTOR_URL: 'http://127.0.0.1:41234' }, () => {
  assert.equal(hostConductorPort(), 41234);
}));

test('hostConductorPort: defaults to 443 for https with no explicit port', withEnv({ CONDUCTOR_PLUGIN_ID: 'code-hub', CONDUCTOR_URL: 'https://127.0.0.1' }, () => {
  assert.equal(hostConductorPort(), 443);
}));

test('hostConductorPort: defaults to 80 for http with no explicit port', withEnv({ CONDUCTOR_PLUGIN_ID: 'code-hub', CONDUCTOR_URL: 'http://127.0.0.1' }, () => {
  assert.equal(hostConductorPort(), 80);
}));

test('hostConductorPort: null for a malformed URL', withEnv({ CONDUCTOR_PLUGIN_ID: 'code-hub', CONDUCTOR_URL: 'not a url' }, () => {
  assert.equal(hostConductorPort(), null);
}));

test('isHostConductorId: only matches "code-conductor" while embedded', withEnv({ CONDUCTOR_PLUGIN_ID: 'code-hub', CONDUCTOR_URL: 'http://127.0.0.1:5000' }, () => {
  assert.equal(isHostConductorId('code-conductor'), true);
  assert.equal(isHostConductorId('code-conductor:ab12cd'), false);
  assert.equal(isHostConductorId('some-other-app'), false);
}));

test('isHostConductorId: false for "code-conductor" when not embedded', () => {
  delete process.env.CONDUCTOR_PLUGIN_ID;
  delete process.env.CONDUCTOR_URL;
  assert.equal(isHostConductorId('code-conductor'), false);
});
