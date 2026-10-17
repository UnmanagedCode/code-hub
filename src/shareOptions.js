// The options a share is made with, validated in one place for both surfaces
// that accept them: a live share (appManager.share) and a stored auto-share
// config (appSettings.update). Either refuses exactly the same shapes, with the
// same messages.

function badRequest(msg) {
  const e = new Error(msg); e.statusCode = 400; return e;
}

// Returns the normalised `{ mode, auth, tls? }` or throws a 400. `mode` is
// required here (share() applies its own 'tunnel' default first); `auth`
// defaults to true; `tls` is type-checked in every mode but kept only for
// 'lan', where it defaults to true.
export function validateShareOptions({ mode, auth = true, tls } = {}) {
  if (mode !== 'tunnel' && mode !== 'lan' && mode !== 'tailscale') {
    throw badRequest(`invalid share mode '${mode}' — must be 'tunnel', 'lan' or 'tailscale'`);
  }
  if (typeof auth !== 'boolean') throw badRequest("'auth' must be a boolean");
  if ((mode === 'tunnel' || mode === 'tailscale') && auth === false) {
    throw badRequest(`authentication cannot be disabled for ${mode} shares`);
  }
  if (tls !== undefined && typeof tls !== 'boolean') throw badRequest("'tls' must be a boolean");
  return mode === 'lan' ? { mode, auth, tls: tls ?? true } : { mode, auth };
}
