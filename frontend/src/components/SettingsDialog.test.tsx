import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '@/App';
import type { App as AppT, AppSettings } from '@/lib/types';
import { portNote, portPlaceholder } from '@/lib/settingsForm';
import { app, json, listing, stubFetch, type Call } from '@/test/fixtures';

afterEach(() => { vi.unstubAllGlobals(); });

const settings = (over: Partial<AppSettings> = {}): AppSettings => ({ username: null, hasPassword: false, autoStart: false, autoShare: null, port: null, ...over });
const puts = (calls: Call[]) => calls.filter((c) => c.method === 'PUT');
const gets = (calls: Call[]) => calls.filter((c) => c.method === 'GET' && c.url === 'api/apps').length;

async function openSettings(apps: AppT[], cardName = 'web', extra: Record<string, unknown> = {}) {
  const user = userEvent.setup();
  const stub = stubFetch({ 'GET api/apps': listing(apps, { tailscaleAvailable: true }), 'PUT api/apps/web/settings': { id: 'web' }, ...extra });
  render(<App />);
  const card = await screen.findByRole('article', { name: cardName });
  await user.click(within(card).getByRole('button', { name: 'Settings' }));
  const dialog = await screen.findByRole('dialog', { name: `Settings — ${cardName}` });
  return { user, card, dialog, ...stub };
}

describe('Settings dialog', () => {
  // Invariant: Settings is reachable from a card in any state, stopped and running alike.
  it('a stopped and a running card both open their Settings dialog', async () => {
    const user = userEvent.setup();
    stubFetch({ 'GET api/apps': listing([app({ id: 'idle' }), app({ id: 'web', status: 'running', tunnel: { kind: 'lan', url: 'http://192.0.2.1:1', auth: false } })]) });
    render(<App />);
    for (const name of ['idle', 'web']) {
      const card = await screen.findByRole('article', { name });
      await user.click(within(card).getByRole('button', { name: 'Settings' }));
      const dialog = await screen.findByRole('dialog', { name: `Settings — ${name}` });
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    }
  });

  // Invariant: a worktree's dialog offers the login but neither automation toggle.
  it('a worktree\'s dialog has the login fields but no auto-start or auto-share', async () => {
    const user = userEvent.setup();
    stubFetch({ 'GET api/apps': listing([app({ id: 'web' }), app({ id: 'web:k', project: 'web', name: 'web', isWorktree: true, branch: 'feat' })]) });
    render(<App />);
    await user.click(await screen.findByRole('button', { name: '1 worktree' }));
    const card = screen.getByRole('article', { name: 'web — feat' });
    await user.click(within(card).getByRole('button', { name: 'Settings' }));
    const dialog = await screen.findByRole('dialog', { name: 'Settings — web — feat' });
    expect(within(dialog).getByLabelText('user')).toBeTruthy();
    expect(within(dialog).getByLabelText('pass')).toBeTruthy();
    expect(within(dialog).queryByRole('checkbox', { name: 'Start automatically when code-hub starts' })).toBeNull();
    expect(within(dialog).queryByRole('checkbox', { name: 'Share automatically when started' })).toBeNull();
    expect(within(dialog).queryByLabelText('Fixed port')).toBeNull();
  });

  // Invariant: the always-on dialog renders what automationFor decides: the login, auto-start present but disabled
  // and unchecked — even with a hand-written autoStart:true stored — with its reason attached, and auto-share enabled.
  it('the always-on card\'s Settings has the login, a disabled unchecked auto-start with its reason, and auto-share', async () => {
    const { dialog } = await openSettings(
      [app({ id: 'code-conductor', status: 'running', alwaysOn: true, settings: settings({ autoStart: true }) })],
      'code-conductor',
    );
    expect(within(dialog).getByLabelText('user')).toBeTruthy();
    expect(within(dialog).getByLabelText('pass')).toBeTruthy();
    const autoStart = within(dialog).getByRole('checkbox', { name: 'Start automatically when code-hub starts' }) as HTMLButtonElement;
    expect(autoStart.disabled).toBe(true);
    expect(autoStart.getAttribute('aria-checked')).toBe('false');
    const reasonId = autoStart.getAttribute('aria-describedby');
    expect(reasonId).toBeTruthy();
    expect(document.getElementById(reasonId!)?.textContent?.trim()).toBeTruthy();
    const autoShare = within(dialog).getByRole('checkbox', { name: 'Share automatically when code-hub starts' }) as HTMLButtonElement;
    expect(autoShare.disabled).toBe(false);
    expect(within(dialog).queryByLabelText('Fixed port')).toBeNull();
  });

  // Invariant: saving the always-on dialog sends what the server accepts: the auto-share, never autoStart.
  it('always-on: tick auto-share, keep LAN, Save → one PUT {autoShare} with no autoStart, a reload, closed', async () => {
    const { user, dialog, calls } = await openSettings(
      [app({ id: 'code-conductor', status: 'running', alwaysOn: true, settings: settings({ autoStart: true }) })],
      'code-conductor',
      { 'PUT api/apps/code-conductor/settings': { id: 'code-conductor' } },
    );
    await user.click(within(dialog).getByRole('checkbox', { name: 'Share automatically when code-hub starts' }));
    const before = gets(calls);
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(puts(calls)).toStrictEqual([{ method: 'PUT', url: 'api/apps/code-conductor/settings', body: { autoShare: { mode: 'lan', auth: true, tls: true } } }]);
    expect(gets(calls)).toBe(before + 1);
  });

  // Invariant: a main card offers the port field, with the manifest fallback as its placeholder, wired to the body.
  it('a main card offers the port field with the manifest fallback, and Save PUTs the typed port', async () => {
    const web = app({ id: 'web', manifestPort: 3000 });
    const { user, dialog, calls } = await openSettings([web]);
    const field = within(dialog).getByLabelText('Fixed port');
    expect(field.getAttribute('placeholder')).toBe(portPlaceholder(web));
    await user.type(field, '4100');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect(puts(calls)[0].body).toStrictEqual({ port: 4100 });
  });

  // Invariant: blanking a stored port clears it.
  it('blanking a stored port PUTs null', async () => {
    const { user, dialog, calls } = await openSettings([app({ id: 'web', settings: settings({ port: 4100 }) })]);
    const field = within(dialog).getByLabelText('Fixed port') as HTMLInputElement;
    expect(field.value).toBe('4100');
    await user.clear(field);
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect(puts(calls)[0].body).toStrictEqual({ port: null });
  });

  // Invariant: an out-of-range port can't be saved, by button or by Enter.
  it('an invalid port blocks Save', async () => {
    const { user, dialog, calls } = await openSettings([app({ id: 'web' })]);
    const field = within(dialog).getByLabelText('Fixed port');
    await user.type(field, '80');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect((within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(field, '{Enter}');
    expect(puts(calls)).toHaveLength(0);
  });

  // Invariant: a running app's dialog says a changed port applies on the next start; a stopped one's doesn't.
  it('a running app\'s dialog says the port applies on the next start', async () => {
    const running = app({ id: 'web', status: 'running', port: 41051 });
    const { dialog } = await openSettings([running]);
    expect(within(dialog).getByText(portNote(running)!)).toBeTruthy();
  });

  it('a stopped app\'s dialog shows the port field and no next-start note', async () => {
    const { dialog } = await openSettings([app({ id: 'web', port: 41051 })]);
    expect(within(dialog).getByLabelText('Fixed port')).toBeTruthy();
    expect(within(dialog).queryByText(/Applies on the next start/)).toBeNull();
  });

  // Invariant: Save sends exactly the helper's patch in one PUT, then reloads the listing and closes.
  it('tick auto-share, choose tailscale, Save → one PUT {autoShare:{mode:"tailscale",auth:true}}, a reload, closed', async () => {
    const { user, dialog, calls } = await openSettings([app({ id: 'web' })]);
    await user.click(within(dialog).getByRole('checkbox', { name: 'Share automatically when started' }));
    await user.click(within(dialog).getByRole('radio', { name: 'tailscale' }));
    const before = gets(calls);
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(puts(calls)).toStrictEqual([{ method: 'PUT', url: 'api/apps/web/settings', body: { autoShare: { mode: 'tailscale', auth: true } } }]);
    expect(gets(calls)).toBe(before + 1);
  });

  // Invariant: a LAN auto-share offers Authentication and TLS, and the TLS choice reaches the body.
  it('LAN auto-share shows Authentication and TLS; unticking TLS sends tls:false', async () => {
    const { user, dialog, calls } = await openSettings([app({ id: 'web' })]);
    await user.click(within(dialog).getByRole('checkbox', { name: 'Share automatically when started' }));
    expect((within(dialog).getByRole('radio', { name: 'LAN' }) as HTMLInputElement).checked).toBe(true);
    expect(within(dialog).getByRole('checkbox', { name: 'Authentication' })).toBeTruthy();
    await user.click(within(dialog).getByRole('checkbox', { name: 'TLS (HTTPS)' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect(puts(calls)[0].body).toStrictEqual({ autoShare: { mode: 'lan', auth: true, tls: false } });
  });

  // Invariant: the auto-start checkbox is wired to the body.
  it('ticking auto-start and saving sends {autoStart:true}', async () => {
    const { user, dialog, calls } = await openSettings([app({ id: 'web' })]);
    await user.click(within(dialog).getByRole('checkbox', { name: 'Start automatically when code-hub starts' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect(puts(calls)[0].body).toStrictEqual({ autoStart: true });
  });

  // Invariant: a refused save shows its error in the dialog, which stays open with the draft.
  it('a 400 keeps the dialog open with the error text', async () => {
    const { user, dialog, calls } = await openSettings([app({ id: 'web' })], 'web', {
      'PUT api/apps/web/settings': () => json({ error: "auto-start and auto-share apply only to a project's main checkout" }, 400),
    });
    await user.click(within(dialog).getByRole('checkbox', { name: 'Start automatically when code-hub starts' }));
    const before = gets(calls);
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain("apply only to a project's main checkout");
    expect(screen.getByRole('dialog', { name: 'Settings — web' })).toBeTruthy();
    expect((within(dialog).getByRole('checkbox', { name: 'Start automatically when code-hub starts' })).getAttribute('aria-checked')).toBe('true');
    expect(gets(calls)).toBe(before);
  });

  // Invariant: saving an unchanged draft writes nothing.
  it('Save with nothing changed sends no PUT', async () => {
    const { user, dialog, calls } = await openSettings([app({ id: 'web', settings: settings({ username: 'alice', autoStart: true }) })]);
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(puts(calls)).toStrictEqual([]);
  });

  // Invariant: "Forget stored password" is offered only for a stored password, and sends password:null.
  it('with a stored password, ticking Forget sends {password:null}', async () => {
    const { user, dialog, calls } = await openSettings([app({ id: 'web', settings: settings({ hasPassword: true }) })]);
    expect((within(dialog).getByLabelText('pass') as HTMLInputElement).value).toBe('');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Forget stored password' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect(puts(calls)[0].body).toStrictEqual({ password: null });
  });
});
