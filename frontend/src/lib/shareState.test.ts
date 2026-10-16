import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveOpenUrl, resolveQrSvg, mergeSharePatch, resolveFixedPortNotice, resolveCredNote,
  PASSWORD_MASK, credRowValues, pruneDrafts, credDraftFor, credPasswordPlaceholder, credPatchBody, credFieldsShown,
  resolveTlsReshareNote,
} from '../public/shareState.js';

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

// --- Fixed-port fallback notice ---
//
// The asymmetry between the three holder cases is the security-relevant part:
// only 'other' is an established all-clear, so only 'other' may stay quiet.

const LAN_APP = { port: 3000 };
const fallback = (fixedPortHolder) => ({ kind: 'lan', fixedPortFallback: true, proxyPort: 51234, fixedPortHolder });

test('resolveFixedPortNotice: an UNKNOWN holder still warns — not knowing must not mean silence', () => {
  // The regression this exists for: probeWildcardHold can't run at all on a
  // host with no loopback aliases (macOS/Windows), so it returns inconclusive
  // for every port. Treating that as an all-clear would silently drop the
  // warning for an app that genuinely is answering ungated on the LAN.
  const notice = resolveFixedPortNotice(LAN_APP, fallback('unknown'));
  assert.equal(notice.level, 'warn');
  assert.match(notice.text, /NO authentication/);
  assert.match(notice.text, /3000/);
  assert.match(notice.text, /51234/);
  // ...but it must not assert the app IS exposed — only what follows if it is.
  assert.match(notice.text, /could not identify what holds it/);
  assert.match(notice.text, /If this app binds all interfaces/);
});

test('resolveFixedPortNotice: an APP holder warns without overclaiming certainty', () => {
  const notice = resolveFixedPortNotice(LAN_APP, fallback('app'));
  assert.equal(notice.level, 'warn');
  assert.match(notice.text, /NO authentication/);
  // share() only knows the start command's wrapper is alive, not that the
  // app's own listener is still up, so this must read as near-certain rather
  // than as established fact.
  assert.match(notice.text, /almost certainly/);
});

test('resolveFixedPortNotice: an OTHER holder is a neutral note making no claim about the app', () => {
  const notice = resolveFixedPortNotice(LAN_APP, fallback('other'));
  assert.equal(notice.level, 'note');
  assert.doesNotMatch(notice.text, /NO authentication/);
  assert.match(notice.text, /not by this app/);
});

test('resolveFixedPortNotice: nothing to say without a LAN fixed-port fallback', () => {
  assert.equal(resolveFixedPortNotice(LAN_APP, null), null);
  assert.equal(resolveFixedPortNotice(LAN_APP, { kind: 'lan', fixedPortFallback: false, fixedPortHolder: null }), null);
  // A tunnel share never has a fixed-port fallback to report.
  assert.equal(resolveFixedPortNotice(LAN_APP, { kind: 'tunnel', fixedPortFallback: true, fixedPortHolder: 'app' }), null);
});

// --- resolveCredNote: the panel's "how is this reachable" line ---

// The regression this feature exists to avoid: before resolveCredNote, the
// panel branched on `kind !== 'lan'`, so a tailscale share rendered as a
// cloudflared tunnel — wrong about who terminates TLS and wrong about whether
// the URL survives a re-share.
test('resolveCredNote: a tailscale share names Tailscale, never "via public tunnel"', () => {
  const note = resolveCredNote({ kind: 'tailscale', url: 'https://node.tailnet.ts.net', auth: true });
  assert.doesNotMatch(note, /public tunnel/);
  assert.match(note, /Tailscale Funnel/);
});

test('resolveCredNote: a cloudflared tunnel share still reads "via public tunnel"', () => {
  assert.equal(resolveCredNote({ kind: 'tunnel', url: 'https://x.trycloudflare.com', auth: true }), 'via public tunnel');
  // Kind absent (a pre-kind share response) keeps the historical default.
  assert.equal(resolveCredNote({ url: 'https://x.trycloudflare.com' }), 'via public tunnel');
});

// The four LAN arms (auth x tls), pinned exactly as they read today: the
// no-auth ones must keep saying anyone on the network can reach the app, and
// the plain-HTTP one must keep saying credentials are not encrypted.
test('resolveCredNote: the four LAN arms are unchanged by the tailscale split', () => {
  assert.equal(resolveCredNote({ kind: 'lan', url: 'https://192.0.2.1:5001', auth: true }),
    'via LAN (HTTPS, self-signed — your browser warns on first visit)');
  assert.equal(resolveCredNote({ kind: 'lan', url: 'http://192.0.2.1:5001', auth: true }),
    'via LAN (plain HTTP — credentials are not encrypted in transit)');
  assert.equal(resolveCredNote({ kind: 'lan', url: 'https://192.0.2.1:5001', auth: false }),
    'via LAN (HTTPS, self-signed — your browser warns on first visit), no authentication — anyone on the network can reach this app');
  assert.equal(resolveCredNote({ kind: 'lan', url: 'http://192.0.2.1:5001', auth: false }),
    'via LAN, no authentication — anyone on the network can reach this app');
});

test('credRowValues: a default password is shown masked but Copy gets the real one; others are plaintext', () => {
  assert.equal(PASSWORD_MASK, '••••••••');
  assert.deepEqual(credRowValues({ password: 'real', passwordIsDefault: true }), { display: PASSWORD_MASK, copy: 'real' });
  assert.deepEqual(credRowValues({ password: 'gen', passwordIsDefault: false }), { display: 'gen', copy: 'gen' });
  assert.deepEqual(credRowValues({ password: 'gen' }), { display: 'gen', copy: 'gen' });
});

test('pruneDrafts: drops drafts for ids no longer listed, keeps the rest', () => {
  const drafts = { a: { username: 'x' }, gone: { username: 'y' }, 'p:wt': {} };
  pruneDrafts(drafts, [{ id: 'a' }, { id: 'b' }]);
  assert.deepEqual(drafts, { a: { username: 'x' } });
  const empty = {};
  pruneDrafts(empty, []);
  assert.deepEqual(empty, {});
});

test('credDraftFor: a default password starts blank (never in the DOM); LAN also carries auth/tls; save-as-default starts unticked', () => {
  assert.deepEqual(credDraftFor({ username: 'u', password: 'real', passwordIsDefault: true }, 'tunnel'), { username: 'u', password: '', saveAsDefault: false });
  assert.deepEqual(credDraftFor({ username: 'u', password: 'gen' }, 'tailscale'), { username: 'u', password: 'gen', saveAsDefault: false });
  assert.deepEqual(credDraftFor({ username: 'u', password: 'real', passwordIsDefault: true, auth: true, tls: false }, 'lan'),
    { auth: true, tls: false, username: 'u', password: '', saveAsDefault: false });
  assert.deepEqual(credDraftFor({ username: null, password: null, auth: false }, 'lan'), { auth: false, tls: true, username: '', password: '', saveAsDefault: false });
});

test('credFieldsShown: always for tunnel/tailscale; for LAN only while auth is on', () => {
  for (const kind of ['tunnel', 'tailscale']) {
    assert.equal(credFieldsShown({ auth: false }, kind), true);
    assert.equal(credFieldsShown({}, kind), true);
  }
  assert.equal(credFieldsShown({ auth: true }, 'lan'), true);
  assert.equal(credFieldsShown({ auth: false }, 'lan'), false);
});

test('credPasswordPlaceholder: masked hint for a default, keep hint when blank, none once typed', () => {
  const masked = { passwordIsDefault: true };
  assert.equal(credPasswordPlaceholder({ password: '' }, masked), '•••••••• (default — type to replace)');
  assert.equal(credPasswordPlaceholder({ password: 'x' }, masked), '');
  assert.equal(credPasswordPlaceholder({ password: '' }, {}), 'leave blank to keep current');
  assert.equal(credPasswordPlaceholder({ password: 'x' }, {}), '');
});

test('credPatchBody: omits blanks; onlyChanged omits unchanged; null when empty', () => {
  const shared = { username: 'u', password: 'p' };
  assert.deepEqual(credPatchBody({ username: 'u', password: '', saveAsDefault: false }, shared, { onlyChanged: false }), { username: 'u' });
  assert.deepEqual(credPatchBody({ username: 'u', password: 'p', saveAsDefault: false }, shared, { onlyChanged: true }), null);
  assert.deepEqual(credPatchBody({ username: 'v', password: 'p', saveAsDefault: false }, shared, { onlyChanged: true }), { username: 'v' });
  assert.deepEqual(credPatchBody({ username: 'u', password: 'q', saveAsDefault: false }, shared, { onlyChanged: true }), { password: 'q' });
  assert.equal(credPatchBody({ username: '', password: '', saveAsDefault: false }, shared, { onlyChanged: false }), null);
});

test('credPatchBody: a ticked save-as-default always yields a body carrying the flag', () => {
  const shared = { username: 'u', password: 'p' };
  assert.deepEqual(credPatchBody({ username: 'u', password: 'p', saveAsDefault: true }, shared, { onlyChanged: true }), { saveAsDefault: true });
  assert.deepEqual(credPatchBody({ username: '', password: '', saveAsDefault: true }, shared, { onlyChanged: false }), { saveAsDefault: true });
  assert.deepEqual(credPatchBody({ username: 'v', password: 'p', saveAsDefault: true }, shared, { onlyChanged: true }), { username: 'v', saveAsDefault: true });
  assert.deepEqual(credPatchBody({ username: 'u', password: 'p', saveAsDefault: true }, shared, { onlyChanged: false }),
    { username: 'u', password: 'p', saveAsDefault: true });
});

test('resolveTlsReshareNote: the three wordings, keyed on a stored default password', () => {
  assert.equal(resolveTlsReshareNote(false, { username: null, hasPassword: true }), 'Changing TLS re-shares the app — new link & QR.');
  assert.equal(resolveTlsReshareNote(true, { username: null, hasPassword: true }), "Changing TLS re-shares the app — new link & QR, and the login resets to this app's default (type below to override).");
  assert.equal(resolveTlsReshareNote(true, null), 'Changing TLS re-shares the app — new link & QR, and the password resets (set one below to keep it).');
  // Keyed on a stored default PASSWORD: a username-only default still gets a random password on re-share.
  assert.equal(resolveTlsReshareNote(true, { username: 'u', hasPassword: false }), resolveTlsReshareNote(true, null));
});

test('mergeSharePatch carries passwordIsDefault', () => {
  const cur = { password: 'real', passwordIsDefault: true };
  mergeSharePatch(cur, { password: 'edited', passwordIsDefault: false });
  assert.equal(cur.passwordIsDefault, false);
  const cur2 = { passwordIsDefault: true };
  mergeSharePatch(cur2, { qrSvg: '<svg/>' }); // absent → untouched
  assert.equal(cur2.passwordIsDefault, true);
});
