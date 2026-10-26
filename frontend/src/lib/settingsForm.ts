// The Settings dialog's draft and the PUT body it saves, as pure functions of
// the app and the draft.

import type { App, AutoShare, ShareKind } from './types';

/** The automation toggles the dialog offers an app; `null` when one is not offered at all. */
export interface AutomationView {
  /** A non-null `disabledReason` shows the toggle disabled, with that reason. */
  autoStart: { disabledReason: string | null } | null;
  autoShare: { label: string } | null;
}

/**
 * A worktree gets neither toggle. The always-on host conductor gets auto-share (at code-hub's boot) and auto-start
 * only disabled, since code-hub never starts it. Any other main checkout gets both.
 */
export function automationFor(app: Pick<App, 'isWorktree' | 'alwaysOn'>): AutomationView {
  if (app.isWorktree) return { autoStart: null, autoShare: null };
  if (app.alwaysOn) {
    return {
      autoStart: { disabledReason: 'Always on — code-conductor runs code-hub, so code-hub never starts it.' },
      autoShare: { label: 'Share automatically when code-hub starts' },
    };
  }
  return { autoStart: { disabledReason: null }, autoShare: { label: 'Share automatically when started' } };
}

/** The fixed port is offered only for a project's main checkout that code-hub can start (not a worktree, not the always-on conductor). */
export function mainCheckoutSettingsAllowed(app: Pick<App, 'isWorktree' | 'alwaysOn'>): boolean {
  return !app.isWorktree && !app.alwaysOn;
}

// The server's rule is `isValidFixedPort` in `src/projects.js`, which re-checks every save.
export const MIN_FIXED_PORT = 1024;
export const MAX_FIXED_PORT = 65535;

// The server's default is `DEFAULT_FUNNEL_PORT` in `src/shareOptions.js`; the list of Funnel ports comes from the
// listing (`funnelPorts`).
export const DEFAULT_FUNNEL_PORT = 443;

export interface SettingsDraft {
  username: string;
  /** Typed to replace the stored password; blank keeps it. */
  password: string;
  forgetPassword: boolean;
  autoStart: boolean;
  autoShare: boolean;
  mode: ShareKind;
  /** LAN only, like `tls`. */
  auth: boolean;
  tls: boolean;
  /** Tailscale only. */
  funnelPort: number;
  /** The fixed port as typed; blank clears it. */
  port: string;
}

export interface SettingsPatch {
  username?: string | null;
  password?: string | null;
  autoStart?: boolean;
  autoShare?: AutoShare | null;
  port?: number | null;
}

// The password field always starts blank: the stored one never enters the DOM.
export function settingsDraftFor(app: Pick<App, 'settings'>): SettingsDraft {
  const s = app.settings;
  return {
    username: s.username ?? '',
    password: '',
    forgetPassword: false,
    autoStart: s.autoStart,
    autoShare: !!s.autoShare,
    mode: s.autoShare?.mode ?? 'lan',
    auth: s.autoShare?.auth ?? true,
    tls: s.autoShare?.tls ?? true,
    funnelPort: s.autoShare?.funnelPort ?? DEFAULT_FUNNEL_PORT,
    port: s.port === null ? '' : String(s.port),
  };
}

/** The port error the dialog shows and Save honours; null when the app can't carry a port, so a stale stored one never blocks Save. */
export function portErrorFor(draft: Pick<SettingsDraft, 'port'>, app: Pick<App, 'isWorktree' | 'alwaysOn'>): string | null {
  return mainCheckoutSettingsAllowed(app) ? portError(draft.port) : null;
}

/** Why the typed port can't be saved, or null when it can; blank is valid (it clears the setting). */
export function portError(text: string): string | null {
  const t = text.trim();
  if (t === '') return null;
  const n = Number(t);
  if (!/^\d+$/.test(t) || n < MIN_FIXED_PORT || n > MAX_FIXED_PORT) {
    return `Port must be a whole number from ${MIN_FIXED_PORT} to ${MAX_FIXED_PORT}`;
  }
  return null;
}

/** What a blank port falls back to: the manifest's port and the file it came from, else a free port. */
export function portPlaceholder(app: Pick<App, 'manifestPort' | 'source'>): string {
  if (app.manifestPort === null) return 'free port';
  return `${app.manifestPort} (from ${app.source === 'registry' ? 'registrations.json' : '.hub.json'})`;
}

/** Said while the app is up: a changed port takes effect on the next start. */
export function portNote(app: Pick<App, 'status' | 'port'>): string | null {
  if (app.status !== 'starting' && app.status !== 'ready' && app.status !== 'running') return null;
  if (app.port === undefined) return 'Applies on the next start or restart.';
  return `Applies on the next start or restart — ${app.status === 'starting' ? 'starting' : 'running'} on :${app.port} now.`;
}

const sameAutoShare = (a: AutoShare, b: AutoShare | null) =>
  !!b && a.mode === b.mode && a.auth === b.auth && (a.tls ?? null) === (b.tls ?? null) && (a.funnelPort ?? null) === (b.funnelPort ?? null);

/**
 * The PUT body for what the draft changed, or null when nothing did. Both login fields are sent trimmed, as the server
 * stores them. A blanked username clears it; a typed password replaces the stored one, else "forget" clears it. Each toggle is sent only where `automationFor` offers it enabled; the port only where `mainCheckoutSettingsAllowed`, and an invalid port is left out.
 */
export function settingsPatch(draft: SettingsDraft, app: Pick<App, 'settings' | 'isWorktree' | 'alwaysOn'>): SettingsPatch | null {
  const s = app.settings;
  const body: SettingsPatch = {};
  const username = draft.username.trim();
  if (username !== (s.username ?? '')) body.username = username || null;
  const password = draft.password.trim();
  if (password) body.password = password;
  else if (draft.forgetPassword && s.hasPassword) body.password = null;
  if (mainCheckoutSettingsAllowed(app) && portError(draft.port) === null) {
    const t = draft.port.trim();
    const want = t === '' ? null : Number(t);
    if (want !== (s.port ?? null)) body.port = want;
  }
  const v = automationFor(app);
  if (v.autoStart && !v.autoStart.disabledReason && draft.autoStart !== s.autoStart) body.autoStart = draft.autoStart;
  if (v.autoShare) {
    if (draft.autoShare) {
      const lan = draft.mode === 'lan';
      const want: AutoShare = {
        mode: draft.mode,
        auth: lan ? draft.auth : true,
        ...(lan ? { tls: draft.tls } : {}),
        ...(draft.mode === 'tailscale' ? { funnelPort: draft.funnelPort } : {}),
      };
      if (!sameAutoShare(want, s.autoShare)) body.autoShare = want;
    } else if (s.autoShare) {
      body.autoShare = null;
    }
  }
  return Object.keys(body).length ? body : null;
}

/**
 * The warning shown while the draft auto-shares via tailscale on a Funnel port another app also auto-shares on, or
 * null. Only the first of them to start gets the port. Never blocks Save.
 */
export function autoShareClashWarning(
  draft: Pick<SettingsDraft, 'autoShare' | 'mode' | 'funnelPort'>,
  app: Pick<App, 'id'>,
  apps: Pick<App, 'id' | 'settings'>[],
): string | null {
  if (!draft.autoShare || draft.mode !== 'tailscale') return null;
  const clashing = apps
    .filter((a) => a.id !== app.id && a.settings.autoShare?.mode === 'tailscale' && a.settings.autoShare.funnelPort === draft.funnelPort)
    .map((a) => `'${a.id}'`);
  if (!clashing.length) return null;
  const who = clashing.join(', ');
  const verb = clashing.length === 1 ? 'also auto-shares' : 'also auto-share';
  return `${who} ${verb} on Funnel port ${draft.funnelPort} — only the first to start gets it; the other's auto-share will fail.`;
}
