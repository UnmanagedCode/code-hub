// The Settings dialog's draft and the PUT body it saves, as pure functions of
// the app and the draft.

import type { App, AutoShare, ShareKind } from './types';

/** Auto-start and auto-share are offered only for a project's main checkout that code-hub can start. */
export function automationAllowed(app: Pick<App, 'isWorktree' | 'alwaysOn'>): boolean {
  return !app.isWorktree && !app.alwaysOn;
}

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
}

export interface SettingsPatch {
  username?: string | null;
  password?: string | null;
  autoStart?: boolean;
  autoShare?: AutoShare | null;
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
  };
}

const sameAutoShare = (a: AutoShare, b: AutoShare | null) =>
  !!b && a.mode === b.mode && a.auth === b.auth && (a.tls ?? null) === (b.tls ?? null);

/**
 * The PUT body for what the draft changed, or null when nothing did. Both login fields are sent trimmed, as the server
 * stores them. A blanked username clears it; a typed password replaces the stored one, else "forget" clears it. The toggles are sent only for an app that may carry them.
 */
export function settingsPatch(draft: SettingsDraft, app: Pick<App, 'settings' | 'isWorktree' | 'alwaysOn'>): SettingsPatch | null {
  const s = app.settings;
  const body: SettingsPatch = {};
  const username = draft.username.trim();
  if (username !== (s.username ?? '')) body.username = username || null;
  const password = draft.password.trim();
  if (password) body.password = password;
  else if (draft.forgetPassword && s.hasPassword) body.password = null;
  if (automationAllowed(app)) {
    if (draft.autoStart !== s.autoStart) body.autoStart = draft.autoStart;
    if (draft.autoShare) {
      const lan = draft.mode === 'lan';
      const want: AutoShare = { mode: draft.mode, auth: lan ? draft.auth : true, ...(lan ? { tls: draft.tls } : {}) };
      if (!sameAutoShare(want, s.autoShare)) body.autoShare = want;
    } else if (s.autoShare) {
      body.autoShare = null;
    }
  }
  return Object.keys(body).length ? body : null;
}
