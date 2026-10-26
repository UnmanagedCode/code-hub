import { expect, test } from 'vitest';
import {
  resolveOpenUrl, resolveQrSvg, mergeSharePatch, resolveFixedPortNotice, resolveCredNote,
  PASSWORD_MASK, credRowValues, pruneDrafts, credDraftFor, credPasswordPlaceholder, credPatchBody, credFieldsShown,
  resolveTlsReshareNote, sharePanelView, shareModes, shareChooserModes, tlsChanging, qrImageSrc, resolveLanReachNotice, qrUseful,
} from './shareState';
import type { App, FunnelPort, RelayInfo, ShareState, Tunnel } from './types';
import { app } from '@/test/fixtures';

// These cover the client behaviors the server tests can't: how the share panel
// resolves the Open link and QR between the in-memory share response (`s`, the
// UI's share state, wiped on a full UI refresh) and the persisted tunnelInfo
// (app.tunnel from list(), which carries authUrl + qrSvg). The panel reads
// `s` and `shared = app.tunnel || s`, then calls these.

test('resolveOpenUrl: s.authUrl shadows shared.authUrl shadows shared.url', () => {
  const shared = { url: 'https://h/', authUrl: 'https://h/?__hubauth=SHARED' };
  // s wins.
  expect(resolveOpenUrl({ authUrl: 'https://h/?__hubauth=S' }, shared)).toBe('https://h/?__hubauth=S');
  // s absent of authUrl → shared.authUrl (cold load after a UI refresh: s wiped).
  expect(resolveOpenUrl({}, shared)).toBe('https://h/?__hubauth=SHARED');
  expect(resolveOpenUrl(null, shared)).toBe('https://h/?__hubauth=SHARED');
});

test('resolveOpenUrl: cold load with s absent falls through to shared.*', () => {
  const shared = { url: 'https://h/', authUrl: 'https://h/?__hubauth=T' };
  expect(resolveOpenUrl(undefined, shared)).toBe('https://h/?__hubauth=T');
  // No magic-link anywhere (no-auth share) → plain url.
  const noAuth = { url: 'https://h/' };
  expect(resolveOpenUrl(undefined, noAuth)).toBe('https://h/');
  expect(resolveOpenUrl(null, noAuth)).toBe('https://h/');
  // Nothing to draw from.
  expect(resolveOpenUrl(undefined, null)).toBe(null);
});

test('resolveQrSvg: s.qrSvg shadows shared.qrSvg; falls through on cold load', () => {
  const shared = { qrSvg: '<svg>shared</svg>' };
  expect(resolveQrSvg({ qrSvg: '<svg>s</svg>' }, shared)).toBe('<svg>s</svg>');
  expect(resolveQrSvg({}, shared)).toBe('<svg>shared</svg>');
  expect(resolveQrSvg(null, shared)).toBe('<svg>shared</svg>');
  expect(resolveQrSvg(null, {})).toBe(null);
});

test('mergeSharePatch: overwrites s.qrSvg/creds so the stale shadow no longer wins', () => {
  const cur = { qrSvg: '<svg>old</svg>', username: 'hub', password: 'old', authUrl: 'https://h/?__hubauth=T' };
  mergeSharePatch(cur, { qrSvg: '<svg>new</svg>', username: 'alice', password: 'newpass' });
  expect(cur.qrSvg).toBe('<svg>new</svg>');
  expect(cur.username).toBe('alice');
  expect(cur.password).toBe('newpass');
  // A credentials PATCH does not touch authUrl.
  expect(cur.authUrl).toBe('https://h/?__hubauth=T');
});

test('mergeSharePatch: auth-off toggle clears s.authUrl so Open falls back to the clean url', () => {
  // The auth-off PATCH response is { id, auth:false, qrSvg } — no authUrl.
  const cur = { authUrl: 'https://h/?__hubauth=STALE', qrSvg: '<svg>cred</svg>' };
  const shared = { url: 'https://h/' }; // ungated tunnelInfo: no authUrl
  mergeSharePatch(cur, { auth: false, qrSvg: '<svg>plain</svg>' });
  expect(cur.authUrl, 'stale magic-link cleared').toBe(undefined);
  expect(cur.qrSvg).toBe('<svg>plain</svg>');
  // Now resolveOpenUrl falls past the wiped s.authUrl to the clean shared.url.
  expect(resolveOpenUrl(cur, shared)).toBe('https://h/');
});

test('mergeSharePatch: a from-the-start auth:false share is unaffected (no s.authUrl to clear)', () => {
  // Such a share's state.share never had authUrl; the auth-on PATCH restores it.
  const cur = { qrSvg: '<svg>plain</svg>' }; // no authUrl key at all
  mergeSharePatch(cur, { auth: true, qrSvg: '<svg>cred</svg>' });
  expect(cur.qrSvg).toBe('<svg>cred</svg>');
  expect(!('authUrl' in cur), 'auth:true PATCH does not synthesize an authUrl').toBeTruthy();
});

test('mergeSharePatch: no-op when no share state is on screen', () => {
  expect(() => mergeSharePatch(null, { auth: false, qrSvg: '<svg/>' })).not.toThrow();
  expect(() => mergeSharePatch(undefined, { auth: false })).not.toThrow();
  const cur = { qrSvg: '<svg/>' };
  mergeSharePatch(cur, { auth: true }); // auth:true is not the clear trigger
  expect(cur.qrSvg).toBe('<svg/>');
  expect(!('authUrl' in cur)).toBeTruthy();
});

// --- Fixed-port fallback notice ---
//
// The asymmetry between the three holder cases is the security-relevant part:
// only 'other' is an established all-clear, so only 'other' may stay quiet.

const LAN_APP = { port: 3000 };
const fallback = (fixedPortHolder: Tunnel['fixedPortHolder']): Partial<Tunnel> => ({ kind: 'lan', fixedPortFallback: true, proxyPort: 51234, fixedPortHolder });

test('resolveFixedPortNotice: an UNKNOWN holder still warns — not knowing must not mean silence', () => {
  // The regression this exists for: probeWildcardHold can't run at all on a
  // host with no loopback aliases (macOS/Windows), so it returns inconclusive
  // for every port. Treating that as an all-clear would silently drop the
  // warning for an app that genuinely is answering ungated on the LAN.
  const notice = resolveFixedPortNotice(LAN_APP, fallback('unknown'))!;
  expect(notice.level).toBe('warn');
  expect(notice.text).toMatch(/NO authentication/);
  expect(notice.text).toMatch(/3000/);
  expect(notice.text).toMatch(/51234/);
  // ...but it must not assert the app IS exposed — only what follows if it is.
  expect(notice.text).toMatch(/could not identify what holds it/);
  expect(notice.text).toMatch(/If this app binds all interfaces/);
});

test('resolveFixedPortNotice: an APP holder warns without overclaiming certainty', () => {
  const notice = resolveFixedPortNotice(LAN_APP, fallback('app'))!;
  expect(notice.level).toBe('warn');
  expect(notice.text).toMatch(/NO authentication/);
  // share() only knows the start command's wrapper is alive, not that the
  // app's own listener is still up, so this must read as near-certain rather
  // than as established fact.
  expect(notice.text).toMatch(/almost certainly/);
});

test('resolveFixedPortNotice: an OTHER holder is a neutral note making no claim about the app', () => {
  const notice = resolveFixedPortNotice(LAN_APP, fallback('other'))!;
  expect(notice.level).toBe('note');
  expect(notice.text).not.toMatch(/NO authentication/);
  expect(notice.text).toMatch(/not by this app/);
});

test('resolveFixedPortNotice: nothing to say without a LAN fixed-port fallback', () => {
  expect(resolveFixedPortNotice(LAN_APP, null)).toBe(null);
  expect(resolveFixedPortNotice(LAN_APP, { kind: 'lan', fixedPortFallback: false, fixedPortHolder: null })).toBe(null);
  // A tunnel share never has a fixed-port fallback to report.
  expect(resolveFixedPortNotice(LAN_APP, { kind: 'tunnel', fixedPortFallback: true, fixedPortHolder: 'app' })).toBe(null);
});

// --- resolveCredNote: the panel's "how is this reachable" line ---

// The regression this feature exists to avoid: before resolveCredNote, the
// panel branched on `kind !== 'lan'`, so a tailscale share rendered as a
// cloudflared tunnel — wrong about who terminates TLS and wrong about whether
// the URL survives a re-share.
test('resolveCredNote: a tailscale share names Tailscale, never "via public tunnel"', () => {
  const note = resolveCredNote({ kind: 'tailscale', url: 'https://node.tailnet.ts.net', auth: true });
  expect(note).not.toMatch(/public tunnel/);
  expect(note).toMatch(/Tailscale Funnel/);
});

// Invariant: a tailscale share's note names its Funnel port, so a share on 8443 isn't mistaken for the default.
test('resolveCredNote: a tailscale share with a funnelPort names the port', () => {
  expect(resolveCredNote({ kind: 'tailscale', url: 'https://node.tailnet.ts.net:8443', auth: true, funnelPort: 8443 })).toMatch(/port 8443/);
  expect(resolveCredNote({ kind: 'tailscale', url: 'https://node.tailnet.ts.net', auth: true, funnelPort: 443 })).toMatch(/port 443/);
});

test('resolveCredNote: a cloudflared tunnel share still reads "via public tunnel"', () => {
  expect(resolveCredNote({ kind: 'tunnel', url: 'https://x.trycloudflare.com', auth: true })).toBe('via public tunnel');
  // Kind absent (a pre-kind share response) keeps the historical default.
  expect(resolveCredNote({ url: 'https://x.trycloudflare.com' })).toBe('via public tunnel');
});

// The four LAN arms (auth x tls), pinned exactly as they read today: the
// no-auth ones must keep saying anyone on the network can reach the app, and
// the plain-HTTP one must keep saying credentials are not encrypted.
test('resolveCredNote: the four LAN arms are unchanged by the tailscale split', () => {
  expect(resolveCredNote({ kind: 'lan', url: 'https://192.0.2.1:5001', auth: true })).toBe('via LAN (HTTPS, self-signed — your browser warns on first visit)');
  expect(resolveCredNote({ kind: 'lan', url: 'http://192.0.2.1:5001', auth: true })).toBe('via LAN (plain HTTP — credentials are not encrypted in transit)');
  expect(resolveCredNote({ kind: 'lan', url: 'https://192.0.2.1:5001', auth: false })).toBe('via LAN (HTTPS, self-signed — your browser warns on first visit), no authentication — anyone on the network can reach this app');
  expect(resolveCredNote({ kind: 'lan', url: 'http://192.0.2.1:5001', auth: false })).toBe('via LAN, no authentication — anyone on the network can reach this app');
});

test('credRowValues: a default password is shown masked but Copy gets the real one; others are plaintext', () => {
  expect(PASSWORD_MASK).toBe('••••••••');
  expect(credRowValues({ password: 'real', passwordIsDefault: true })).toStrictEqual({ display: PASSWORD_MASK, copy: 'real' });
  expect(credRowValues({ password: 'gen', passwordIsDefault: false })).toStrictEqual({ display: 'gen', copy: 'gen' });
  expect(credRowValues({ password: 'gen' })).toStrictEqual({ display: 'gen', copy: 'gen' });
});

test('pruneDrafts: drops drafts for ids no longer listed, keeps the rest', () => {
  const drafts = { a: { username: 'x' }, gone: { username: 'y' }, 'p:wt': {} };
  pruneDrafts(drafts, [{ id: 'a' }, { id: 'b' }]);
  expect(drafts).toStrictEqual({ a: { username: 'x' } });
  const empty = {};
  pruneDrafts(empty, []);
  expect(empty).toStrictEqual({});
});

test('credDraftFor: a default password starts blank (never in the DOM); LAN also carries auth/tls; save-as-default starts unticked', () => {
  expect(credDraftFor({ username: 'u', password: 'real', passwordIsDefault: true }, 'tunnel')).toStrictEqual({ username: 'u', password: '' });
  expect(credDraftFor({ username: 'u', password: 'gen' }, 'tailscale')).toStrictEqual({ username: 'u', password: 'gen' });
  expect(credDraftFor({ username: 'u', password: 'real', passwordIsDefault: true, auth: true, tls: false }, 'lan')).toStrictEqual({ auth: true, tls: false, username: 'u', password: '' });
  expect(credDraftFor({ username: null, password: null, auth: false }, 'lan')).toStrictEqual({ auth: false, tls: true, username: '', password: '' });
});

test('credFieldsShown: always for tunnel/tailscale; for LAN only while auth is on', () => {
  for (const kind of ['tunnel', 'tailscale'] as const) {
    expect(credFieldsShown({ auth: false }, kind)).toBe(true);
    expect(credFieldsShown({}, kind)).toBe(true);
  }
  expect(credFieldsShown({ auth: true }, 'lan')).toBe(true);
  expect(credFieldsShown({ auth: false }, 'lan')).toBe(false);
});

test('credPasswordPlaceholder: masked hint for a default, keep hint when blank, none once typed', () => {
  const masked = { passwordIsDefault: true };
  expect(credPasswordPlaceholder({ password: '' }, masked)).toBe('•••••••• (default — type to replace)');
  expect(credPasswordPlaceholder({ password: 'x' }, masked)).toBe('');
  expect(credPasswordPlaceholder({ password: '' }, {})).toBe('leave blank to keep current');
  expect(credPasswordPlaceholder({ password: 'x' }, {})).toBe('');
});

test('credPatchBody: omits blanks; onlyChanged omits unchanged; null when empty', () => {
  const shared = { username: 'u', password: 'p' };
  expect(credPatchBody({ username: 'u', password: '' }, shared, { onlyChanged: false })).toStrictEqual({ username: 'u' });
  expect(credPatchBody({ username: 'u', password: 'p' }, shared, { onlyChanged: true })).toStrictEqual(null);
  expect(credPatchBody({ username: 'v', password: 'p' }, shared, { onlyChanged: true })).toStrictEqual({ username: 'v' });
  expect(credPatchBody({ username: 'u', password: 'q' }, shared, { onlyChanged: true })).toStrictEqual({ password: 'q' });
  expect(credPatchBody({ username: '', password: '' }, shared, { onlyChanged: false })).toBe(null);
});

// Invariant: the live share's Edit never writes the stored login — no body carries saveAsDefault.
test('credPatchBody: never emits saveAsDefault', () => {
  const shared = { username: 'u', password: 'p' };
  for (const onlyChanged of [true, false]) {
    for (const body of [credPatchBody({ username: 'v', password: 'q' }, shared, { onlyChanged }), credPatchBody({ username: 'u', password: 'p' }, shared, { onlyChanged })]) {
      expect(body && 'saveAsDefault' in body).toBeFalsy();
    }
  }
});

test('resolveTlsReshareNote: the three wordings, keyed on a stored default password', () => {
  expect(resolveTlsReshareNote(false, { hasPassword: true })).toBe('Changing TLS re-shares the app — new link & QR.');
  expect(resolveTlsReshareNote(true, app({ settings: { username: null, hasPassword: true, autoStart: false, autoShare: null, port: null } }).settings)).toBe("Changing TLS re-shares the app — new link & QR, and the login resets to this app's default (type below to override).");
  expect(resolveTlsReshareNote(true, null)).toBe('Changing TLS re-shares the app — new link & QR, and the password resets (set one below to keep it).');
  // Keyed on a stored default PASSWORD: a username-only default still gets a random password on re-share.
  expect(resolveTlsReshareNote(true, { hasPassword: false })).toBe(resolveTlsReshareNote(true, null));
});

test('mergeSharePatch carries passwordIsDefault', () => {
  const cur = { password: 'real', passwordIsDefault: true };
  mergeSharePatch(cur, { password: 'edited', passwordIsDefault: false });
  expect(cur.passwordIsDefault).toBe(false);
  const cur2 = { passwordIsDefault: true };
  mergeSharePatch(cur2, { qrSvg: '<svg/>' }); // absent → untouched
  expect(cur2.passwordIsDefault).toBe(true);
});

// --- sharePanelView: what the panel shows, in the precedence the panel renders ---

const LIVE: Tunnel = { kind: 'tunnel', url: 'https://x.trycloudflare.com', auth: true, username: 'hub', password: 'pw', authUrl: 'https://x.trycloudflare.com/?__hubauth=T', qrSvg: '<svg>live</svg>' };
const appWith = (tunnel: Tunnel | null, port?: number, auto: Pick<App, 'autoShareStatus' | 'autoShareError'> = { autoShareStatus: null, autoShareError: null }) =>
  ({ tunnel, port, ...auto });

// Invariant: the picker beats everything, then a share in flight, then a failed share — even over a
// live app.tunnel, so the failure is seen — then nothing, and only then the live share.
test('sharePanelView: choosing > loading > error (over a live tunnel) > none > active', () => {
  expect(sharePanelView({ choosing: true }, appWith(LIVE), false)).toStrictEqual({ view: 'choosing', funnel: false });
  expect(sharePanelView('loading', appWith(LIVE), false)).toStrictEqual({ view: 'loading' });
  expect(sharePanelView({ error: 'boom' }, appWith(LIVE), false)).toStrictEqual({ view: 'error', error: 'boom' });
  expect(sharePanelView(undefined, appWith(null), false)).toStrictEqual({ view: 'none' });
  expect(sharePanelView(undefined, appWith(LIVE), false).view).toBe('active');
});

// Invariant: the panel shows an auto-share in flight or its failure only while nothing better applies — a live
// share wins over a failed auto-share, and a client-side share failure wins over a pending one.
test('sharePanelView: autoPending and autoFailed precedence', () => {
  const pending = { autoShareStatus: 'pending' as const, autoShareError: null };
  const failed = { autoShareStatus: 'failed' as const, autoShareError: 'funnel held' };
  expect(sharePanelView(undefined, appWith(null, undefined, pending), false)).toStrictEqual({ view: 'autoPending' });
  expect(sharePanelView(undefined, appWith(null, undefined, failed), false)).toStrictEqual({ view: 'autoFailed', error: 'funnel held' });
  expect(sharePanelView(undefined, appWith(LIVE, undefined, failed), false).view).toBe('active');
  expect(sharePanelView({ error: 'boom' }, appWith(null, undefined, pending), false)).toStrictEqual({ view: 'error', error: 'boom' });
  expect(sharePanelView('loading', appWith(null, undefined, failed), false)).toStrictEqual({ view: 'loading' });
  expect(sharePanelView({ choosing: true }, appWith(null, undefined, pending), false)).toStrictEqual({ view: 'choosing', funnel: false });
});

// Invariant: the share response alone (no app.tunnel yet) is enough to show the live share, and its
// one-time authUrl/qrSvg win over the listing's.
test('sharePanelView: the share response stands in for app.tunnel, and its authUrl/qrSvg win', () => {
  const s: ShareState = { ...LIVE, authUrl: 'https://x.trycloudflare.com/?__hubauth=S', qrSvg: '<svg>s</svg>' };
  const v = sharePanelView(s, appWith(null), false);
  if (v.view !== 'active') throw new Error(v.view);
  expect(v.shared).toBe(s);
  expect(v.openUrl).toBe('https://x.trycloudflare.com/?__hubauth=S');
  expect(v.qrSvg).toBe('<svg>s</svg>');
  const over = sharePanelView(s, appWith(LIVE), false);
  if (over.view !== 'active') throw new Error(over.view);
  expect(over.shared).toBe(LIVE);
  expect(over.openUrl).toBe('https://x.trycloudflare.com/?__hubauth=S');
  expect(over.credNote).toBe('via public tunnel');
});

// Invariant: Edit is offered on every LAN share (it is the only way back to auth on), and elsewhere only
// with creds; the creds area shows while editing, or when the share has creds to show.
test('sharePanelView: canEdit for LAN even with auth off; showCreds follows creds or an open form', () => {
  const lanOff: Tunnel = { kind: 'lan', url: 'http://192.0.2.1:5001', auth: false, username: 'hub', password: 'pw' };
  const off = sharePanelView(undefined, appWith(lanOff), false);
  if (off.view !== 'active') throw new Error(off.view);
  expect(off.canEdit).toBe(true);
  expect(off.showCreds).toBe(false);
  const editing = sharePanelView(undefined, appWith(lanOff), true);
  if (editing.view !== 'active') throw new Error(editing.view);
  expect(editing.showCreds).toBe(true);

  const live = sharePanelView(undefined, appWith(LIVE), false);
  if (live.view !== 'active') throw new Error(live.view);
  expect(live.canEdit).toBe(true);
  expect(live.showCreds).toBe(true);
  const noCreds = sharePanelView(undefined, appWith({ ...LIVE, password: null }), false);
  if (noCreds.view !== 'active') throw new Error(noCreds.view);
  expect(noCreds.canEdit).toBe(false);
  expect(noCreds.showCreds).toBe(false);
});

// Invariant: the further LAN URLs are the ones past the first; the fixed-port notice reads the app's port.
test('sharePanelView: extraUrls and the fixed-port notice', () => {
  const lan: Tunnel = { kind: 'lan', url: 'https://192.0.2.1:5001', urls: ['https://192.0.2.1:5001', 'https://198.51.100.2:5001'], auth: true, fixedPortFallback: true, fixedPortHolder: 'other', proxyPort: 5001 };
  const v = sharePanelView(undefined, appWith(lan, 3000), false);
  if (v.view !== 'active') throw new Error(v.view);
  expect(v.kind).toBe('lan');
  expect(v.extraUrls).toStrictEqual(['https://198.51.100.2:5001']);
  expect(v.fixedPortNotice?.level).toBe('note');
  expect(v.fixedPortNotice?.text).toMatch(/3000/);
  const single = sharePanelView(undefined, appWith({ ...lan, urls: [lan.url] }), false);
  if (single.view !== 'active') throw new Error(single.view);
  expect(single.extraUrls).toStrictEqual([]);
});

// Invariant: LAN is always pickable; cloudflared and tailscale say why when they aren't.
test('shareModes: order, and a reason exactly when a mode is unavailable', () => {
  expect(shareModes(true, true).map((m) => [m.mode, m.label, m.disabledReason])).toStrictEqual([
    ['lan', 'LAN', null], ['tunnel', 'cloudflared', null], ['tailscale', 'tailscale', null],
  ]);
  expect(shareModes(false, false).map((m) => m.disabledReason)).toStrictEqual([null, 'cloudflared not installed', 'tailscale not available']);
});

// Invariant: only a LAN draft whose TLS differs from the live share's (absent = on) is a TLS change.
test('tlsChanging: a LAN draft differing from the live TLS; never a draft without tls', () => {
  const draft = (tls?: boolean) => ({ username: '', password: '', ...(tls === undefined ? {} : { auth: true, tls }) });
  expect(tlsChanging(draft(true), { tls: true })).toBe(false);
  expect(tlsChanging(draft(false), { tls: true })).toBe(true);
  expect(tlsChanging(draft(true), { tls: false })).toBe(true);
  expect(tlsChanging(draft(true), {})).toBe(false);
  expect(tlsChanging(draft(false), {})).toBe(true);
  expect(tlsChanging(draft(), { tls: false })).toBe(false);
});

// Invariant: the QR reaches the page only as a data: image of an SVG document, never as markup.
test('qrImageSrc: an SVG becomes a data: URL; anything else is null', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>';
  const src = qrImageSrc(svg);
  expect(src).toBe(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
  expect(decodeURIComponent(String(src).slice('data:image/svg+xml;charset=utf-8,'.length))).toBe(svg);
  expect(qrImageSrc('  \n<svg/>')).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
  expect(qrImageSrc('<img src=x onerror=alert(1)>')).toBe(null);
  expect(qrImageSrc('<html><svg/></html>')).toBe(null);
  expect(qrImageSrc('')).toBe(null);
  expect(qrImageSrc(null)).toBe(null);
  expect(qrImageSrc(42)).toBe(null);
});

// --- LAN reach from a container: the host relay and the container-internal flag ---

const relay = (over: Partial<RelayInfo> = {}): RelayInfo => ({ state: 'up', error: null, port: 7100, requestedPort: null, portFallback: false, ...over });
const lanShare = (over: Partial<Tunnel> = {}): Tunnel => ({ kind: 'lan', url: 'https://192.168.1.20:7100', auth: true, qrSvg: '<svg>qr</svg>', ...over });

// Invariant: each relay state maps to its notice level and says what the user needs — host exposure with the
// port fallback when it happened, a retrying outage with its reason when there is one (and no empty parenthesis
// when there isn't) — a retry promised only while one is coming (recovery 'retrying'), else the wait for the
// relay's host.json to change or for the port to be bound — the failure reason (plus the container sentence when the
// addresses are container-internal), the container warning with no relay, and nothing otherwise.
test('resolveLanReachNotice: one row per relay state', () => {
  const up = resolveLanReachNotice(lanShare({ relay: relay() }));
  expect(up?.level).toBe('note');
  expect(up?.text).toMatch(/host's LAN through the code-hub relay/);
  expect(up?.text).not.toMatch(/busy/);
  const fallback = resolveLanReachNotice(lanShare({ relay: relay({ requestedPort: 8080, port: 41000, portFallback: true }) }));
  expect(fallback?.level).toBe('note');
  expect(fallback?.text).toMatch(/Port 8080 was busy on the host, so it is on port 41000/);

  const down = resolveLanReachNotice(lanShare({ relay: relay({ state: 'down', error: 'connect ECONNREFUSED 10.0.0.1:7077' }) }));
  expect(down?.level).toBe('warn');
  expect(down?.text).toMatch(/host relay isn't connected \(connect ECONNREFUSED 10\.0\.0\.1:7077\); code-hub keeps retrying/);
  const downNoReason = resolveLanReachNotice(lanShare({ relay: relay({ state: 'down', error: null }) }));
  expect(downNoReason?.text).toMatch(/host relay isn't connected; code-hub keeps retrying/);
  expect(downNoReason?.text).not.toMatch(/\(/);

  // Only a retrying state promises a retry: an unusable host.json waits for the
  // file to change, and a connected relay that hasn't bound the port yet says so.
  const waitingFile = resolveLanReachNotice(lanShare({ relay: relay({ state: 'down', error: 'the relay on the host speaks protocol 1', recovery: 'relay-file' }) }));
  expect(waitingFile?.level).toBe('warn');
  expect(waitingFile?.text).toMatch(/host relay can't be used \(the relay on the host speaks protocol 1\); code-hub waits for the relay's host\.json to change/);
  expect(waitingFile?.text).not.toMatch(/retrying/);
  const binding = resolveLanReachNotice(lanShare({ relay: relay({ state: 'down', error: 'waiting for the relay to bind the port', recovery: 'binding' }) }));
  expect(binding?.text).toMatch(/hasn't confirmed this share's port yet/);
  expect(binding?.text).not.toMatch(/retrying|isn't connected/);
  const retrying = resolveLanReachNotice(lanShare({ relay: relay({ state: 'down', error: 'connect ECONNREFUSED', recovery: 'retrying' }) }));
  expect(retrying?.text).toMatch(/isn't connected \(connect ECONNREFUSED\); code-hub keeps retrying/);

  const failed = resolveLanReachNotice(lanShare({ relay: relay({ state: 'failed', error: 'connect ECONNREFUSED' }) }));
  expect(failed?.level).toBe('warn');
  expect(failed?.text).toMatch(/Host exposure failed: connect ECONNREFUSED/);
  expect(failed?.text).not.toMatch(/internal to code-hub's container/);
  const failedInContainer = resolveLanReachNotice(lanShare({ relay: relay({ state: 'failed', error: 'x' }), containerInternal: true }));
  expect(failedInContainer?.text).toMatch(/Host exposure failed: x.*internal to code-hub's container/);

  const bare = resolveLanReachNotice(lanShare({ relay: null, containerInternal: true }));
  expect(bare?.level).toBe('warn');
  expect(bare?.text).toMatch(/internal to code-hub's container.*host relay.*cloudflared or tailscale/);

  expect(resolveLanReachNotice(lanShare({ relay: null, containerInternal: false }))).toBe(null);
  expect(resolveLanReachNotice({ kind: 'tunnel', url: 'https://x', relay: relay({ state: 'failed', error: 'x' }), containerInternal: true })).toBe(null);
  expect(resolveLanReachNotice(null)).toBe(null);
});

// Invariant: the QR is useless only while the addresses are container-internal and the relay isn't carrying them.
test('qrUseful: false only for a container-internal share without a relay that is up', () => {
  expect(qrUseful(lanShare({ containerInternal: true, relay: null }))).toBe(false);
  expect(qrUseful(lanShare({ containerInternal: true, relay: relay({ state: 'down' }) }))).toBe(false);
  expect(qrUseful(lanShare({ containerInternal: true, relay: relay({ state: 'failed', error: 'x' }) }))).toBe(false);
  expect(qrUseful(lanShare({ containerInternal: true, relay: relay() }))).toBe(true);
  expect(qrUseful(lanShare({ containerInternal: false, relay: null }))).toBe(true);
  expect(qrUseful(lanShare())).toBe(true);
});

// Invariant: the panel drops the QR (but keeps the Open link) when it isn't useful, and carries the reach notice.
test('sharePanelView: nulls qrSvg for a container-internal share and carries the reach notice', () => {
  const internal = sharePanelView(undefined, appWith(lanShare({ containerInternal: true, relay: null })), false);
  expect(internal.view).toBe('active');
  if (internal.view !== 'active') return;
  expect(internal.qrSvg).toBe(null);
  expect(internal.openUrl).toBe('https://192.168.1.20:7100');
  expect(internal.reachNotice?.level).toBe('warn');
  const relayed = sharePanelView(undefined, appWith(lanShare({ containerInternal: false, relay: relay() })), false);
  if (relayed.view !== 'active') throw new Error('not active');
  expect(relayed.qrSvg).toBe('<svg>qr</svg>');
  expect(relayed.reachNotice?.level).toBe('note');
});


// Invariant: the picker disables tailscale exactly when every Funnel port is held by ANOTHER app — a port this app
// holds stays a choice (a re-share) — and an unavailable tailscale keeps its own reason.
test('shareChooserModes: tailscale is disabled only when every Funnel port is held by another app', () => {
  const held = (holders: (string | null)[]): FunnelPort[] => [443, 8443, 10000].map((port, i) => ({ port, holder: holders[i] }));
  const tailscale = (ports: FunnelPort[], available = true) => shareChooserModes(true, available, ports, 'me').find((m) => m.mode === 'tailscale')!.disabledReason;
  expect(tailscale(held(['a', 'b', 'c']))).toBe('all Funnel ports in use');
  expect(tailscale(held(['a', 'b', 'me']))).toBe(null);
  expect(tailscale(held(['a', null, 'c']))).toBe(null);
  expect(tailscale(held(['a', 'b', 'c']), false)).toBe('tailscale not available');
  expect(shareChooserModes(true, true, held(['a', 'b', 'c']), 'me').filter((m) => m.mode !== 'tailscale')).toStrictEqual(shareModes(true, true).filter((m) => m.mode !== 'tailscale'));
});

// Invariant: the picker state carries whether its Funnel port row is open.
test('sharePanelView: choosing reports whether the Funnel port row is open', () => {
  expect(sharePanelView({ choosing: true, funnel: true }, appWith(null), false)).toStrictEqual({ view: 'choosing', funnel: true });
  expect(sharePanelView({ choosing: true }, appWith(null), false)).toStrictEqual({ view: 'choosing', funnel: false });
});
