// Pure helpers for the share panel's state resolution — extracted from render
// in app.js so the fallback ordering and the auth-off merge are unit-testable
// without a DOM. No dependencies, no DOM access.

// The panel draws from two sources: `s` = state.share[id] (the one-time share()
// response, in-memory only — wiped on a full UI refresh) and `shared` =
// app.tunnel (the persisted tunnelInfo from list(), rebuilt live from the
// proxy). Right after sharing or a PATCH, `s` is the freshest; after a full UI
// refresh `s` is gone and `shared` carries the QR + magic-link instead.

// Resolve the Open link URL. Prefer the in-memory magic-link, then the
// persisted one, then the plain share URL. A no-auth share has no authUrl
// anywhere, so it lands on the plain URL. Returns null only if shared is null.
export function resolveOpenUrl(s, shared) {
  return (s && s.authUrl) || (shared && shared.authUrl) || (shared && shared.url) || null;
}

// Resolve the QR SVG. Prefer the in-memory copy (freshest right after a share
// or a PATCH merged in), then the persisted tunnelInfo's (served by list(),
// which survives a full UI refresh). Returns null if neither has one.
export function resolveQrSvg(s, shared) {
  return (s && s.qrSvg) || (shared && shared.qrSvg) || null;
}

// Fold a credentials/auth PATCH response into the in-memory share state so the
// rendered QR/creds track the edit instead of the stale pre-edit share
// response — whose s.qrSvg/s.authUrl would otherwise shadow the fresh values
// list() serves (see resolveQrSvg/resolveOpenUrl's `s`-first ordering).
//
// Also drop s.authUrl when the gate turned off: the auth PATCH response
// carries no authUrl, so without this the stale magic-link keeps winning at
// resolveOpenUrl, leaking the ?__hubauth token into upstream request URLs once
// the proxy is ungated (it forwards req.url verbatim) and re-minting it as a
// live credential on a later re-gate. A from-the-start auth:false share has no
// s.authUrl to delete, so it's unaffected.
//
// `cur` is state.share[id] — may be null/undefined if nothing's on screen.
export function mergeSharePatch(cur, patched) {
  if (!cur || typeof cur !== 'object') return;
  if ('qrSvg' in patched) cur.qrSvg = patched.qrSvg;
  if ('username' in patched) cur.username = patched.username;
  if ('password' in patched) cur.password = patched.password;
  if ('passwordIsDefault' in patched) cur.passwordIsDefault = patched.passwordIsDefault;
  if (patched.auth === false) delete cur.authUrl;
}

// Resolve the fixed-port fallback notice for a LAN share, or null when there's
// nothing to say. Returns { level, text }: `level` is 'warn' whenever the app
// might be reachable on the LAN with no gate, and 'note' only when code-hub
// established it isn't.
//
// The three holder cases are deliberately NOT symmetric:
//   'app'     a wildcard hold was measured. Almost certainly this app — but
//             `share()` only knows the start command's wrapper process is
//             alive, not that the app's own listener is still up, so a
//             reloader's restart window could let something else hold the
//             wildcard. Warn loudly, phrased so it doesn't overclaim.
//   'unknown' the probe could not run (hosts without loopback aliases — macOS,
//             Windows — fail it for every port). This MUST warn: staying quiet
//             here would hide a real ungated exposure, which is the worse
//             direction to be wrong in. It still doesn't assert the app IS
//             exposed, only what follows if it binds all interfaces.
//   'other'   the port is positively not wildcard-held, so this app is not
//             what answers on the LAN there. Nothing to warn about.
export function resolveFixedPortNotice(app, shared) {
  if (!shared || shared.kind !== 'lan' || !shared.fixedPortFallback) return null;
  const fixed = app && app.port;
  const actual = shared.proxyPort;
  const exposure = `it is already reachable on the LAN at port ${fixed} with NO authentication.`;
  if (shared.fixedPortHolder === 'other') {
    return {
      level: 'note',
      text: `Fixed port ${fixed} is held on the LAN by another process, not by this app, so this gated share is on port ${actual}.`,
    };
  }
  if (shared.fixedPortHolder === 'app') {
    return {
      level: 'warn',
      text: `⚠ Fixed port ${fixed} is held on every interface, so this gated share is on port ${actual} instead. That is almost certainly this app — in which case ${exposure}`,
    };
  }
  return {
    level: 'warn',
    text: `⚠ Fixed port ${fixed} could not be bound on the LAN and code-hub could not identify what holds it, so this gated share is on port ${actual}. If this app binds all interfaces, ${exposure}`,
  };
}

// Resolve the share panel's mode/credentials note — the one line under the URL
// saying how this share is reachable. Extracted from app.js's render so the
// wording is unit-testable without a DOM (there are no DOM tests).
//
// `kind` drives the split, NOT "is it LAN": a tailscale share is public like a
// tunnel but is NOT a cloudflared tunnel, and calling it one would misdescribe
// where TLS terminates and how stable the URL is. Anything unrecognised falls
// through to the tunnel wording, which is the pre-existing default.
export function resolveCredNote(shared) {
  const kind = (shared && shared.kind) || 'tunnel';
  if (kind === 'tailscale') return 'via Tailscale Funnel — public URL';
  if (kind !== 'lan') return 'via public tunnel';
  const authEnabled = shared.auth !== false;
  const lanTls = String(shared.url).startsWith('https:');
  if (!authEnabled && lanTls) return 'via LAN (HTTPS, self-signed — your browser warns on first visit), no authentication — anyone on the network can reach this app';
  if (!authEnabled) return 'via LAN, no authentication — anyone on the network can reach this app';
  if (lanTls) return 'via LAN (HTTPS, self-signed — your browser warns on first visit)';
  return 'via LAN (plain HTTP — credentials are not encrypted in transit)';
}

// Masking an app's DEFAULT share password. `passwordIsDefault` (from the server)
// marks a live share still holding the password it was seeded with from the
// app's stored default; generated and share-time-edited passwords stay
// plaintext. The mask is a fixed width so it doesn't reveal the length. The
// real value stays in `shared.password` for Copy, but is never put into an
// <input> — the edit drafts below start blank instead, and blank means keep.
export const PASSWORD_MASK = '••••••••';

export function resolvePasswordDisplay(shared) {
  return shared.passwordIsDefault ? PASSWORD_MASK : shared.password;
}

// The Edit form's initial draft for a live share. `kind` 'lan' also carries the
// auth/TLS toggles, which only a LAN share has.
export function credDraftFor(shared, kind) {
  const creds = {
    username: shared.username ?? '',
    password: shared.passwordIsDefault ? '' : (shared.password ?? ''),
  };
  return kind === 'lan' ? { auth: shared.auth !== false, tls: shared.tls !== false, ...creds } : creds;
}

export function credPasswordPlaceholder(editing, shared) {
  if (shared.passwordIsDefault && !editing.password) return `${PASSWORD_MASK} (default — type to replace)`;
  return editing.password ? '' : 'leave blank to keep current';
}

// A credentials PATCH body from an Edit draft, or null when there's nothing to
// send. Blank fields mean "keep"; `onlyChanged` also drops a field equal to
// the live value (an in-place edit), whereas a fresh re-share sends every
// typed field.
export function credPatchBody(editing, shared, { onlyChanged }) {
  const body = {};
  for (const key of ['username', 'password']) {
    const v = editing[key];
    if (!v) continue;
    if (onlyChanged && v === (shared[key] ?? '')) continue;
    body[key] = v;
  }
  return Object.keys(body).length ? body : null;
}

// The card-level "Share login" form: an app's stored default login for new
// shares. `defaults` is app.shareDefaults ({ username, hasPassword } | null) —
// the server never sends the stored password, so the draft never holds it.
export function defaultsDraftFor(app) {
  return { username: app.shareDefaults?.username ?? '', password: '', clearPassword: false };
}

export function defaultsPasswordPlaceholder(draft, defaults) {
  if (draft.clearPassword) return 'will be removed — random per share';
  if (defaults?.hasPassword) return `${PASSWORD_MASK} (set — type to replace)`;
  return 'none — random per share';
}

// The PUT /share/defaults body for a draft, or null when nothing changed.
// username: set when changed, null when emptied; password: set when typed,
// null when "Forget password" was pressed, else omitted (keep).
export function buildDefaultsPatch(draft, defaults) {
  const body = {};
  const username = draft.username.trim();
  if (username && username !== defaults?.username) body.username = username;
  else if (!username && defaults?.username) body.username = null;
  if (draft.password) body.password = draft.password;
  else if (draft.clearPassword) body.password = null;
  return Object.keys(body).length ? body : null;
}

// The Edit form's note when a LAN share's TLS toggle is about to change: that
// re-shares, and a re-share starts from the app's default login if it has one.
export function resolveTlsReshareNote(auth, hasDefaultLogin) {
  if (!auth) return 'Changing TLS re-shares the app — new link & QR.';
  if (hasDefaultLogin) return "Changing TLS re-shares the app — new link & QR, and the login resets to this app's default (type below to override).";
  return 'Changing TLS re-shares the app — new link & QR, and the password resets (set one below to keep it).';
}
