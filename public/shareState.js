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