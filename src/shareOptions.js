// The options a share is made with, validated in one place for both surfaces
// that accept them: a live share (appManager.share) and a stored auto-share
// config (appSettings.update). Either refuses exactly the same shapes, with the
// same messages.

// The public ports Tailscale Funnel accepts. Each tailscale share runs on one,
// and one share per port (see appManager's funnelSlots). The UI reads this list
// from the listing (`funnelPorts`), never from a copy of its own.
export const FUNNEL_PORTS = [443, 8443, 10000];
export const DEFAULT_FUNNEL_PORT = 443;

function badRequest(msg) {
  const e = new Error(msg); e.statusCode = 400; return e;
}

// A tailscale share's `funnelPort` defaults to DEFAULT_FUNNEL_PORT — at share
// time (validateShareOptions) and when describing a stored auto-share
// (appSettings.describe) alike, so the API always reports the port a tailscale
// share runs on. Other modes are returned unchanged.
export function withFunnelPortDefault(opts) {
  return opts.mode === 'tailscale' ? { ...opts, funnelPort: opts.funnelPort ?? DEFAULT_FUNNEL_PORT } : opts;
}

// Returns the normalised `{ mode, auth, tls?, funnelPort? }` or throws a 400.
// `mode` is required here (share() applies its own 'tunnel' default first);
// `auth` defaults to true. `tls` and `funnelPort` are checked in every mode but
// kept only where they apply: `tls` for 'lan' (default true), `funnelPort` for
// 'tailscale' (default DEFAULT_FUNNEL_PORT).
export function validateShareOptions({ mode, auth = true, tls, funnelPort } = {}) {
  if (mode !== 'tunnel' && mode !== 'lan' && mode !== 'tailscale') {
    throw badRequest(`invalid share mode '${mode}' — must be 'tunnel', 'lan' or 'tailscale'`);
  }
  if (typeof auth !== 'boolean') throw badRequest("'auth' must be a boolean");
  if ((mode === 'tunnel' || mode === 'tailscale') && auth === false) {
    throw badRequest(`authentication cannot be disabled for ${mode} shares`);
  }
  if (tls !== undefined && typeof tls !== 'boolean') throw badRequest("'tls' must be a boolean");
  if (funnelPort !== undefined && !FUNNEL_PORTS.includes(funnelPort)) {
    throw badRequest(`'funnelPort' must be one of ${FUNNEL_PORTS.join(', ')}`);
  }
  if (mode === 'lan') return { mode, auth, tls: tls ?? true };
  if (mode === 'tailscale') return withFunnelPortDefault({ mode, auth, funnelPort });
  return { mode, auth };
}
