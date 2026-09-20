// Detects whether code-hub is running embedded as a code-conductor plugin
// (the conductor injects CONDUCTOR_PLUGIN_ID + CONDUCTOR_URL into the child
// process only in that case) and identifies the one discovered app that IS
// that host conductor, so appManager can treat it as always-on instead of
// an ordinary startable/stoppable app.
const HOST_CONDUCTOR_ID = 'code-conductor';

export function isEmbedded() {
  return Boolean(process.env.CONDUCTOR_PLUGIN_ID && process.env.CONDUCTOR_URL);
}

// Port the host conductor's own server listens on, derived from the URL the
// conductor injected — null if not embedded or the URL doesn't parse.
export function hostConductorPort() {
  if (!isEmbedded()) return null;
  try {
    const u = new URL(process.env.CONDUCTOR_URL);
    const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
    return Number.isFinite(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

// The conductor's own checkout directory (absolute), injected by the conductor
// when embedded. May live OUTSIDE the projects root (a conductor with a custom
// PROJECTS_ROOT keeps its own checkout elsewhere). null when unset (an older
// conductor that doesn't inject it) or not embedded.
export function hostConductorDir() {
  if (!isEmbedded()) return null;
  return process.env.CONDUCTOR_PROJECT_DIR || null;
}

// True only for the main code-conductor checkout while embedded — never for
// a worktree (a worktree id always carries a `:<key>` suffix, so this can
// never misfire on one).
export function isHostConductorId(id) {
  return isEmbedded() && id === HOST_CONDUCTOR_ID;
}

export { HOST_CONDUCTOR_ID };
