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
