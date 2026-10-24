import { RELAY_ENV } from './hostRelay.js';

// The environment every child code-hub spawns or execs runs with: code-hub's
// own minus the host-relay configuration, whose secret is a capability to
// listen on the host's LAN. Matched case-insensitively (Windows env names are).
const STRIPPED = new Set(Object.values(RELAY_ENV).map((name) => name.toUpperCase()));

export function childEnv(extra = {}) {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!STRIPPED.has(name.toUpperCase())) env[name] = value;
  }
  return { ...env, ...extra };
}

// Prefix for a `bash -lc` command: a login shell sources the user's profiles
// AFTER the environment above is handed over, and a profile may export the
// variables again, so they are unset once more right before the command runs.
export const UNSET_RELAY_ENV = `unset ${Object.values(RELAY_ENV).join(' ')}; `;
