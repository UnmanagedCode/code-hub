import { expect, test } from 'vitest';
import { automationAllowed, settingsDraftFor, settingsPatch, type SettingsDraft } from './settingsForm';
import type { AppSettings } from './types';
import { app } from '@/test/fixtures';

const withSettings = (s: Partial<AppSettings>, over = {}) =>
  app({ settings: { username: null, hasPassword: false, autoStart: false, autoShare: null, ...s }, ...over });
const draftOf = (a: ReturnType<typeof app>, over: Partial<SettingsDraft> = {}): SettingsDraft => ({ ...settingsDraftFor(a), ...over });

// Invariant: a fresh app's draft has both toggles off, an empty login, and LAN (auth + TLS on) as the mode.
test('settingsDraftFor: an app with no settings → toggles off, mode lan', () => {
  expect(settingsDraftFor(app())).toStrictEqual({
    username: '', password: '', forgetPassword: false, autoStart: false, autoShare: false, mode: 'lan', auth: true, tls: true,
  });
  const stored = withSettings({ username: 'alice', hasPassword: true, autoStart: true, autoShare: { mode: 'tailscale', auth: true } });
  expect(settingsDraftFor(stored)).toMatchObject({ username: 'alice', password: '', autoStart: true, autoShare: true, mode: 'tailscale' });
});

// Invariant: the login part of the patch: nothing changed → no request; a blanked username clears it; a typed
// password replaces it; "forget" clears a stored one.
test('settingsPatch: login semantics', () => {
  const a = withSettings({ username: 'alice', hasPassword: true });
  expect(settingsPatch(draftOf(a), a)).toBe(null);
  expect(settingsPatch(draftOf(a, { username: '  ' }), a)).toStrictEqual({ username: null });
  expect(settingsPatch(draftOf(a, { username: ' bob ' }), a)).toStrictEqual({ username: 'bob' });
  expect(settingsPatch(draftOf(a, { password: 'new' }), a)).toStrictEqual({ password: 'new' });
  // Sent trimmed, as the server stores it; spaces alone are blank (keep).
  expect(settingsPatch(draftOf(a, { password: '  new  ' }), a)).toStrictEqual({ password: 'new' });
  expect(settingsPatch(draftOf(a, { password: '   ' }), a)).toBe(null);
  expect(settingsPatch(draftOf(a, { forgetPassword: true }), a)).toStrictEqual({ password: null });
  expect(settingsPatch(draftOf(a, { forgetPassword: true, password: 'typed' }), a)).toStrictEqual({ password: 'typed' });
  const none = withSettings({});
  expect(settingsPatch(draftOf(none, { forgetPassword: true }), none)).toBe(null);
});

// Invariant: the UI never sends a toggle for a worktree or the always-on host conductor.
test('settingsPatch: a worktree or always-on app never sends autoStart/autoShare', () => {
  for (const over of [{ isWorktree: true, id: 'web:k' }, { alwaysOn: true }]) {
    const a = withSettings({ autoShare: { mode: 'lan', auth: true, tls: true } }, over);
    expect(automationAllowed(a)).toBe(false);
    expect(settingsPatch(draftOf(a, { autoStart: true, autoShare: false, mode: 'tunnel' }), a)).toBe(null);
    expect(settingsPatch(draftOf(a, { autoStart: true, username: 'u' }), a)).toStrictEqual({ username: 'u' });
  }
});

// Invariant: the toggle part of the patch: the auto-share shape per mode, omitted when unchanged, null when
// unticked, and autoStart as a boolean.
test('settingsPatch: toggle shapes', () => {
  const a = app();
  expect(settingsPatch(draftOf(a, { autoShare: true, mode: 'lan', auth: false, tls: false }), a)).toStrictEqual({ autoShare: { mode: 'lan', auth: false, tls: false } });
  expect(settingsPatch(draftOf(a, { autoShare: true, mode: 'tunnel', auth: false, tls: false }), a)).toStrictEqual({ autoShare: { mode: 'tunnel', auth: true } });
  expect(settingsPatch(draftOf(a, { autoShare: true, mode: 'tailscale' }), a)).toStrictEqual({ autoShare: { mode: 'tailscale', auth: true } });
  expect(settingsPatch(draftOf(a, { autoStart: true }), a)).toStrictEqual({ autoStart: true });

  const stored = withSettings({ autoStart: true, autoShare: { mode: 'lan', auth: true, tls: true } });
  expect(settingsPatch(draftOf(stored), stored)).toBe(null);
  expect(settingsPatch(draftOf(stored, { autoShare: false }), stored)).toStrictEqual({ autoShare: null });
  expect(settingsPatch(draftOf(stored, { autoStart: false }), stored)).toStrictEqual({ autoStart: false });
  expect(settingsPatch(draftOf(stored, { tls: false }), stored)).toStrictEqual({ autoShare: { mode: 'lan', auth: true, tls: false } });
});
