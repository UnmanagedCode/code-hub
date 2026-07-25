import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveOpenUrl, resolveQrSvg, mergeSharePatch } from '../public/shareState.js';

// These cover the client behaviors the server tests can't: how sharePanel
// resolves the Open link and QR between the in-memory share response (state.
// share, wiped on a full UI refresh) and the persisted tunnelInfo (app.tunnel
// from list(), which 7568ddc made carry authUrl + qrSvg). The render reads
// `s = state.share[id]` and `shared = app.tunnel || s`, then calls these.

test('resolveOpenUrl: s.authUrl shadows shared.authUrl shadows shared.url', () => {
  const shared = { url: 'https://h/', authUrl: 'https://h/?__hubauth=SHARED' };
  // s wins.
  assert.equal(resolveOpenUrl({ authUrl: 'https://h/?__hubauth=S' }, shared), 'https://h/?__hubauth=S');
  // s absent of authUrl → shared.authUrl (cold load after a UI refresh: s wiped).
  assert.equal(resolveOpenUrl({}, shared), 'https://h/?__hubauth=SHARED');
  assert.equal(resolveOpenUrl(null, shared), 'https://h/?__hubauth=SHARED');
});

test('resolveOpenUrl: cold load with s absent falls through to shared.*', () => {
  const shared = { url: 'https://h/', authUrl: 'https://h/?__hubauth=T' };
  assert.equal(resolveOpenUrl(undefined, shared), 'https://h/?__hubauth=T');
  // No magic-link anywhere (no-auth share) → plain url.
  const noAuth = { url: 'https://h/' };
  assert.equal(resolveOpenUrl(undefined, noAuth), 'https://h/');
  assert.equal(resolveOpenUrl(null, noAuth), 'https://h/');
  // Nothing to draw from.
  assert.equal(resolveOpenUrl(undefined, null), null);
});

test('resolveQrSvg: s.qrSvg shadows shared.qrSvg; falls through on cold load', () => {
  const shared = { qrSvg: '<svg>shared</svg>' };
  assert.equal(resolveQrSvg({ qrSvg: '<svg>s</svg>' }, shared), '<svg>s</svg>');
  assert.equal(resolveQrSvg({}, shared), '<svg>shared</svg>');
  assert.equal(resolveQrSvg(null, shared), '<svg>shared</svg>');
  assert.equal(resolveQrSvg(null, {}), null);
});

test('mergeSharePatch: overwrites s.qrSvg/creds so the stale shadow no longer wins', () => {
  const cur = { qrSvg: '<svg>old</svg>', username: 'hub', password: 'old', authUrl: 'https://h/?__hubauth=T' };
  mergeSharePatch(cur, { qrSvg: '<svg>new</svg>', username: 'alice', password: 'newpass' });
  assert.equal(cur.qrSvg, '<svg>new</svg>');
  assert.equal(cur.username, 'alice');
  assert.equal(cur.password, 'newpass');
  // A credentials PATCH does not touch authUrl.
  assert.equal(cur.authUrl, 'https://h/?__hubauth=T');
});

test('mergeSharePatch: auth-off toggle clears s.authUrl so Open falls back to the clean url', () => {
  // The auth-off PATCH response is { id, auth:false, qrSvg } — no authUrl.
  const cur = { authUrl: 'https://h/?__hubauth=STALE', qrSvg: '<svg>cred</svg>' };
  const shared = { url: 'https://h/' }; // ungated tunnelInfo: no authUrl
  mergeSharePatch(cur, { auth: false, qrSvg: '<svg>plain</svg>' });
  assert.equal(cur.authUrl, undefined, 'stale magic-link cleared');
  assert.equal(cur.qrSvg, '<svg>plain</svg>');
  // Now resolveOpenUrl falls past the wiped s.authUrl to the clean shared.url.
  assert.equal(resolveOpenUrl(cur, shared), 'https://h/');
});

test('mergeSharePatch: a from-the-start auth:false share is unaffected (no s.authUrl to clear)', () => {
  // Such a share's state.share never had authUrl; the auth-on PATCH restores it.
  const cur = { qrSvg: '<svg>plain</svg>' }; // no authUrl key at all
  mergeSharePatch(cur, { auth: true, qrSvg: '<svg>cred</svg>' });
  assert.equal(cur.qrSvg, '<svg>cred</svg>');
  assert.ok(!('authUrl' in cur), 'auth:true PATCH does not synthesize an authUrl');
});

test('mergeSharePatch: no-op when no share state is on screen', () => {
  assert.doesNotThrow(() => mergeSharePatch(null, { auth: false, qrSvg: '<svg/>' }));
  assert.doesNotThrow(() => mergeSharePatch(undefined, { auth: false }));
  const cur = { qrSvg: '<svg/>' };
  mergeSharePatch(cur, { auth: true }); // auth:true is not the clear trigger
  assert.equal(cur.qrSvg, '<svg/>');
  assert.ok(!('authUrl' in cur));
});