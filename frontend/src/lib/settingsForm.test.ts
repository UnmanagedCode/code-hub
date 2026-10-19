import { expect, test } from 'vitest';
import { automationFor, mainCheckoutSettingsAllowed, portError, portNote, portPlaceholder, settingsDraftFor, settingsPatch, type SettingsDraft } from './settingsForm';
import type { AppSettings } from './types';
import { app } from '@/test/fixtures';

const withSettings = (s: Partial<AppSettings>, over = {}) =>
  app({ settings: { username: null, hasPassword: false, autoStart: false, autoShare: null, port: null, ...s }, ...over });
const draftOf = (a: ReturnType<typeof app>, over: Partial<SettingsDraft> = {}): SettingsDraft => ({ ...settingsDraftFor(a), ...over });

// Invariant: a fresh app's draft has both toggles off, an empty login, and LAN (auth + TLS on) as the mode.
test('settingsDraftFor: an app with no settings → toggles off, mode lan', () => {
  expect(settingsDraftFor(app())).toStrictEqual({
    username: '', password: '', forgetPassword: false, autoStart: false, autoShare: false, mode: 'lan', auth: true, tls: true, port: '',
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

// Invariant: a worktree offers neither toggle; the always-on app offers auto-share, and auto-start only disabled with a
// reason; a normal main checkout offers both, enabled.
test('automationFor: what each kind of app offers', () => {
  expect(automationFor(app({ isWorktree: true, id: 'web:k' }))).toStrictEqual({ autoStart: null, autoShare: null });
  const alwaysOn = automationFor(app({ alwaysOn: true }));
  expect(alwaysOn.autoStart?.disabledReason).toBeTruthy();
  expect(alwaysOn.autoShare).not.toBe(null);
  const normal = automationFor(app());
  expect(normal.autoStart).toStrictEqual({ disabledReason: null });
  expect(normal.autoShare).not.toBe(null);
  expect(alwaysOn.autoShare?.label).not.toBe(normal.autoShare?.label);
});

// Invariant: the UI never sends a toggle for a worktree.
test('settingsPatch: a worktree never sends autoStart/autoShare', () => {
  const a = withSettings({ autoShare: { mode: 'lan', auth: true, tls: true } }, { isWorktree: true, id: 'web:k' });
  expect(settingsPatch(draftOf(a, { autoStart: true, autoShare: false, mode: 'tunnel' }), a)).toBe(null);
  expect(settingsPatch(draftOf(a, { autoStart: true, username: 'u' }), a)).toStrictEqual({ username: 'u' });
});

// Invariant: for the always-on app the patch sends exactly what the server accepts — never autoStart, and
// autoShare set or cleared like a normal app's.
test('settingsPatch: the always-on app sends autoShare but never autoStart', () => {
  const a = withSettings({}, { alwaysOn: true });
  expect(settingsPatch(draftOf(a, { autoStart: true }), a)).toBe(null);
  expect(settingsPatch(draftOf(a, { autoStart: true, autoShare: true, mode: 'lan' }), a)).toStrictEqual({ autoShare: { mode: 'lan', auth: true, tls: true } });
  const stored = withSettings({ autoShare: { mode: 'lan', auth: true, tls: true } }, { alwaysOn: true });
  expect(settingsPatch(draftOf(stored, { autoShare: false }), stored)).toStrictEqual({ autoShare: null });
});

// Invariant: the fixed port is offered only to a main checkout code-hub can start.
test('mainCheckoutSettingsAllowed: not a worktree, not the always-on app', () => {
  expect(mainCheckoutSettingsAllowed(app())).toBe(true);
  expect(mainCheckoutSettingsAllowed(app({ isWorktree: true, id: 'web:k' }))).toBe(false);
  expect(mainCheckoutSettingsAllowed(app({ alwaysOn: true }))).toBe(false);
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

// Invariant: the draft carries the stored port as text, blank when none.
test('settingsDraftFor: the stored port is seeded as text', () => {
  expect(settingsDraftFor(withSettings({ port: null })).port).toBe('');
  expect(settingsDraftFor(withSettings({ port: 4100 })).port).toBe('4100');
});

// Invariant: blank is valid (it clears), the range is inclusive, anything else is refused.
test('portError accepts blank and the inclusive range, rejects the rest', () => {
  for (const ok of ['', '  ', ' 1024 ', '65535']) expect(portError(ok)).toBeNull();
  for (const bad of ['1023', '65536', '30a', '3.5', '-1']) expect(portError(bad)).not.toBeNull();
});

// Invariant: the placeholder tells what a blank port falls back to, and from which file.
test('portPlaceholder shows what blank falls back to', () => {
  const manifest = portPlaceholder({ manifestPort: 3000, source: 'manifest' });
  expect(manifest).toContain('3000');
  expect(manifest).toContain('.hub.json');
  expect(portPlaceholder({ manifestPort: 3000, source: 'registry' })).toContain('registrations.json');
  expect(portPlaceholder({ manifestPort: null, source: 'manifest' })).toBe('free port');
});

// Invariant: the next-start note is shown only while the app is up, and names its current port.
test('portNote is present only while the app is up', () => {
  for (const status of ['starting', 'ready', 'running'] as const) {
    expect(portNote({ status, port: 41051 })).toContain(':41051');
  }
  for (const status of ['stopped', 'crashed'] as const) expect(portNote({ status, port: undefined })).toBeNull();
});

// Invariant: the patch carries a port only when it changed, is valid, and the app may carry one.
test('settingsPatch: a changed, valid port on a main checkout', () => {
  const a = app();
  expect(settingsPatch(draftOf(a, { port: '4100' }), a)).toStrictEqual({ port: 4100 });
  expect(settingsPatch(draftOf(a), a)).toBeNull();
  const stored = withSettings({ port: 4100 });
  expect(settingsPatch(draftOf(stored), stored)).toBeNull();
  expect(settingsPatch(draftOf(stored, { port: '' }), stored)).toStrictEqual({ port: null });
  expect(settingsPatch(draftOf(a, { port: '80' }), a)).toBeNull();
  expect(settingsPatch(draftOf(a, { port: '80', username: 'u' }), a)).toStrictEqual({ username: 'u' });
  for (const over of [{ isWorktree: true, id: 'web:k' }, { alwaysOn: true }]) {
    const w = withSettings({}, over);
    expect(settingsPatch(draftOf(w, { port: '4100' }), w)).toBeNull();
  }
});
