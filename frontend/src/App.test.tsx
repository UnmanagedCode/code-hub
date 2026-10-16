import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { POLL_MS } from '@/lib/useApps';
import type { App as AppT, Tunnel } from '@/lib/types';
import { app, json, listing, stubFetch } from '@/test/fixtures';

// The poll is driven by hand; testing-library's own waits keep real timeouts.
beforeEach(() => { vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const tick = () => act(async () => { vi.advanceTimersByTime(POLL_MS); });
const gets = (calls: { method: string; url: string }[]) => calls.filter((c) => c.method === 'GET' && c.url === 'api/apps').length;
const writes = (calls: { method: string; url: string; body: unknown }[]) => calls.filter((c) => c.method !== 'GET');

const TUNNEL: Tunnel = { kind: 'tunnel', url: 'https://x.trycloudflare.com', authUrl: 'https://x.trycloudflare.com/?__hubauth=T', auth: true, username: 'hub', password: 'pw', qrSvg: '<svg xmlns="http://www.w3.org/2000/svg"/>' };
const LAN: Tunnel = { kind: 'lan', url: 'https://192.0.2.1:5001', urls: ['https://192.0.2.1:5001'], auth: true, tls: true, username: 'hub', password: 'pw', authUrl: 'https://192.0.2.1:5001/?__hubauth=T' };
const running = (over: Partial<AppT> = {}) => app({ id: 'web', status: 'running', port: 5000, routes: [{ name: 'web', path: '/', urls: ['http://127.0.0.1:5000/'] }], ...over });

describe('list states', () => {
  // Invariant: before the first answer the list shows a loading placeholder, then the cards.
  it('shows the loading placeholder, then the list', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    stubFetch({ 'GET api/apps': async () => { await gate; return json(listing([app({ id: 'web' })])); } });
    render(<App />);
    expect(screen.getByRole('status', { name: 'Loading apps…' })).toBeTruthy();
    release();
    expect(await screen.findByRole('article', { name: 'web' })).toBeTruthy();
    expect(screen.queryByRole('status', { name: 'Loading apps…' })).toBeNull();
    expect(screen.getByText(/^updated /)).toBeTruthy();
  });

  // Invariant: a failed first load says why and offers Retry, which recovers.
  it('a first-load failure shows the error, and Retry recovers', async () => {
    const user = userEvent.setup();
    const { routes } = stubFetch({ 'GET api/apps': () => json({ error: 'boom' }, 500) });
    render(<App />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Failed to load: boom');
    routes['GET api/apps'] = listing([app({ id: 'web' })]);
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('article', { name: 'web' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  // Invariant: an empty listing says how to add an app.
  it('an empty listing shows the empty text', async () => {
    stubFetch({ 'GET api/apps': listing([]) });
    render(<App />);
    expect(await screen.findByText('No apps found. Add a .hub.json to a sibling project.')).toBeTruthy();
  });

  // Invariant: a poll failure after a successful load keeps the cards and says they are stale.
  it('a poll failure after load keeps the list and shows the stale alert', async () => {
    const { routes, calls } = stubFetch({ 'GET api/apps': listing([app({ id: 'web' })]) });
    render(<App />);
    await screen.findByRole('article', { name: 'web' });
    routes['GET api/apps'] = () => json({ error: 'down' }, 502);
    const before = gets(calls);
    await tick();
    await waitFor(() => expect(gets(calls)).toBe(before + 1));
    expect((await screen.findByRole('alert')).textContent).toMatch(/^Can't reach code-hub — showing data from /);
    expect(screen.getByRole('article', { name: 'web' })).toBeTruthy();
    routes['GET api/apps'] = listing([app({ id: 'web' })]);
    await tick();
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  // Invariant: the header reports which share backends are available.
  it('the header shows cloudflared and tailscale availability', async () => {
    stubFetch({ 'GET api/apps': listing([], { cloudflaredAvailable: true, tailscaleAvailable: false }) });
    render(<App />);
    expect(await screen.findByText('cloudflared ✓')).toBeTruthy();
    expect(screen.getByText('no tailscale')).toBeTruthy();
  });

  // Invariant: the sort select reorders the cards.
  it('sorting by name reorders the cards', async () => {
    const user = userEvent.setup();
    stubFetch({ 'GET api/apps': listing([
      app({ id: 'zed', lastCommitAt: '2026-05-01T00:00:00Z' }), app({ id: 'alpha', lastCommitAt: '2026-01-01T00:00:00Z' }),
    ]) });
    render(<App />);
    await screen.findByRole('article', { name: 'zed' });
    const names = () => screen.getAllByRole('article').map((a) => a.getAttribute('aria-label'));
    expect(names()).toStrictEqual(['zed', 'alpha']);
    await user.selectOptions(screen.getByLabelText('Sort'), 'name');
    expect(names()).toStrictEqual(['alpha', 'zed']);
  });
});

describe('actions', () => {
  // Invariant: a failed action shows inline on its card (no browser alert), and the next action clears it.
  it('a failed Start shows an inline alert, never window.alert', async () => {
    const user = userEvent.setup();
    const alertSpy = vi.fn();
    vi.stubGlobal('alert', alertSpy);
    const { routes, calls } = stubFetch({
      'GET api/apps': listing([app({ id: 'web' })]),
      'POST api/apps/web/start': () => json({ error: 'port 3000 is busy' }, 409),
    });
    render(<App />);
    const card = await screen.findByRole('article', { name: 'web' });
    await user.click(within(card).getByRole('button', { name: 'Start' }));
    expect((await within(card).findByRole('alert')).textContent).toContain('port 3000 is busy');
    expect(alertSpy).not.toHaveBeenCalled();
    expect(writes(calls)).toStrictEqual([{ method: 'POST', url: 'api/apps/web/start', body: undefined }]);

    routes['POST api/apps/web/start'] = { id: 'web', status: 'starting' };
    await user.click(within(card).getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(within(card).queryByRole('alert')).toBeNull());
  });

  // Invariant: the inline error can be dismissed.
  it('the inline error dismisses', async () => {
    const user = userEvent.setup();
    stubFetch({ 'GET api/apps': listing([app({ id: 'web' })]), 'POST api/apps/web/start': () => json({ error: 'nope' }, 400) });
    render(<App />);
    const card = await screen.findByRole('article', { name: 'web' });
    await user.click(within(card).getByRole('button', { name: 'Start' }));
    await user.click(await within(card).findByRole('button', { name: 'Dismiss error' }));
    expect(within(card).queryByRole('alert')).toBeNull();
  });

  // Invariant: Share → LAN posts the mode for the id as one encoded path segment, then shows the share; an
  // unavailable mode is disabled and says why.
  it('Share → LAN posts {mode:"lan"} and shows the share', async () => {
    const user = userEvent.setup();
    const wt = running({ id: 'web:k', project: 'web', isWorktree: true, branch: 'feat' });
    const shareResponse: Tunnel = { ...LAN, auth: false, username: null, password: null, authUrl: undefined };
    const { calls } = stubFetch({
      'GET api/apps': listing([app({ id: 'web' }), wt], { tailscaleAvailable: false }),
      'POST api/apps/web%3Ak/share': shareResponse,
    });
    render(<App />);
    await user.click(await screen.findByRole('button', { name: '1 worktree' }));
    const card = screen.getByRole('article', { name: 'web:k' });
    await user.click(within(card).getByRole('button', { name: 'Share' }));
    const tailscale = within(card).getByRole('button', { name: 'tailscale' }) as HTMLButtonElement;
    expect(tailscale.disabled).toBe(true);
    expect(document.getElementById(tailscale.getAttribute('aria-describedby')!)?.textContent).toBe('tailscale not available');
    await user.click(within(card).getByRole('button', { name: 'LAN' }));
    expect(await within(card).findByText('https://192.0.2.1:5001')).toBeTruthy();
    expect(writes(calls)).toStrictEqual([{ method: 'POST', url: 'api/apps/web%3Ak/share', body: { mode: 'lan' } }]);
  });

  // Invariant: a failed share shows its error in place of the panel.
  it('a failed share shows its error', async () => {
    const user = userEvent.setup();
    stubFetch({ 'GET api/apps': listing([running()]), 'POST api/apps/web/share': () => json({ error: 'cloudflared exited' }, 502) });
    render(<App />);
    const card = await screen.findByRole('article', { name: 'web' });
    await user.click(within(card).getByRole('button', { name: 'Share' }));
    await user.click(within(card).getByRole('button', { name: 'cloudflared' }));
    expect((await within(card).findByRole('alert')).textContent).toBe('cloudflared exited');
  });

  // Invariant: Stop posts and clears the app's share state, so no defunct share lingers.
  it('Stop clears the share panel', async () => {
    const user = userEvent.setup();
    const { routes } = stubFetch({ 'GET api/apps': listing([running()]), 'POST api/apps/web/share': TUNNEL });
    render(<App />);
    const card = await screen.findByRole('article', { name: 'web' });
    await user.click(within(card).getByRole('button', { name: 'Share' }));
    await user.click(within(card).getByRole('button', { name: 'cloudflared' }));
    await within(card).findByText('https://x.trycloudflare.com');
    routes['POST api/apps/web/stop'] = { id: 'web', status: 'stopped' };
    routes['GET api/apps'] = listing([app({ id: 'web' })]);
    await user.click(within(card).getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(within(card).queryByText('https://x.trycloudflare.com')).toBeNull());
    expect(within(card).getByRole('button', { name: 'Start' })).toBeTruthy();
  });
});

describe('edit form', () => {
  // Invariant: a poll does not disturb an open Edit form: the typed value and the focus survive it.
  it('typing in the Edit form keeps its value and focus across a poll', async () => {
    const user = userEvent.setup();
    const { calls } = stubFetch({ 'GET api/apps': listing([running({ tunnel: TUNNEL })]) });
    render(<App />);
    const card = await screen.findByRole('article', { name: 'web' });
    await user.click(within(card).getByRole('button', { name: 'Edit' }));
    const userInput = within(card).getByLabelText('user') as HTMLInputElement;
    await user.clear(userInput);
    await user.type(userInput, 'alice');
    const before = gets(calls);
    await tick();
    await waitFor(() => expect(gets(calls)).toBe(before + 1));
    const after = within(card).getByLabelText('user') as HTMLInputElement;
    expect(after).toBe(userInput);
    expect(after.value).toBe('alice');
    expect(document.activeElement).toBe(after);
  });

  // Invariant: Enter in the form saves: only the changed field is PATCHed, and the form closes.
  it('Enter saves the changed field and closes the form', async () => {
    const user = userEvent.setup();
    const { calls } = stubFetch({
      'GET api/apps': listing([running({ tunnel: TUNNEL })]),
      'PATCH api/apps/web/share/credentials': { id: 'web', username: 'hub', password: 'newpass', passwordIsDefault: false, qrSvg: TUNNEL.qrSvg },
    });
    render(<App />);
    const card = await screen.findByRole('article', { name: 'web' });
    await user.click(within(card).getByRole('button', { name: 'Edit' }));
    const pass = within(card).getByLabelText('pass');
    await user.clear(pass);
    await user.type(pass, 'newpass{Enter}');
    await waitFor(() => expect(within(card).queryByRole('form', { name: 'Edit share login' })).toBeNull());
    expect(writes(calls)).toStrictEqual([{ method: 'PATCH', url: 'api/apps/web/share/credentials', body: { password: 'newpass' } }]);
  });

  // Invariant: turning LAN auth off PATCHes the gate only — no credentials PATCH — and the panel drops the creds.
  it('LAN: unticking Authentication PATCHes share/auth only', async () => {
    const user = userEvent.setup();
    const { routes, calls } = stubFetch({
      'GET api/apps': listing([running({ tunnel: LAN })]),
      'PATCH api/apps/web/share/auth': { id: 'web', auth: false, qrSvg: '<svg xmlns="http://www.w3.org/2000/svg"/>' },
    });
    render(<App />);
    const card = await screen.findByRole('article', { name: 'web' });
    await user.click(within(card).getByRole('button', { name: 'Edit' }));
    await user.click(within(card).getByRole('checkbox', { name: 'Authentication' }));
    expect(within(card).queryByLabelText('user')).toBeNull();
    routes['GET api/apps'] = listing([running({ tunnel: { ...LAN, auth: false, authUrl: undefined } })]);
    await user.click(within(card).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(within(card).queryByRole('form', { name: 'Edit share login' })).toBeNull());
    expect(writes(calls)).toStrictEqual([{ method: 'PATCH', url: 'api/apps/web/share/auth', body: { enabled: false } }]);
    expect(within(card).queryByRole('button', { name: 'Copy pass' })).toBeNull();
    expect(within(within(card).getByRole('region', { name: 'Share' })).getByRole('link', { name: /open/i }).getAttribute('href')).toBe('https://192.0.2.1:5001/');
  });

  // Invariant: flipping TLS warns that Save re-shares, and Save re-shares with the auth and TLS choice.
  it('LAN: a TLS flip shows the re-share note and Save re-shares', async () => {
    const user = userEvent.setup();
    const reshared: Tunnel = { ...LAN, url: 'http://192.0.2.1:5002', urls: ['http://192.0.2.1:5002'], tls: false, authUrl: 'http://192.0.2.1:5002/?__hubauth=N' };
    const { calls } = stubFetch({
      'GET api/apps': listing([running({ tunnel: LAN })]),
      'POST api/apps/web/share': reshared,
      'PATCH api/apps/web/share/credentials': { id: 'web', username: 'hub', password: 'pw', passwordIsDefault: false },
    });
    render(<App />);
    const card = await screen.findByRole('article', { name: 'web' });
    await user.click(within(card).getByRole('button', { name: 'Edit' }));
    expect(within(card).queryByText(/Changing TLS re-shares/)).toBeNull();
    await user.click(within(card).getByRole('checkbox', { name: 'TLS (HTTPS)' }));
    expect(within(card).getByText(/^Changing TLS re-shares the app/)).toBeTruthy();
    await user.click(within(card).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(within(card).queryByRole('form', { name: 'Edit share login' })).toBeNull());
    expect(writes(calls)).toStrictEqual([
      { method: 'POST', url: 'api/apps/web/share', body: { mode: 'lan', auth: true, tls: false } },
      { method: 'PATCH', url: 'api/apps/web/share/credentials', body: { username: 'hub', password: 'pw' } },
    ]);
    expect(within(within(card).getByRole('region', { name: 'Share' })).getByRole('link', { name: /open/i }).getAttribute('href')).toBe('http://192.0.2.1:5002/?__hubauth=N');
  });

  // Invariant: Cancel closes the form without a request.
  it('Cancel closes the form and sends nothing', async () => {
    const user = userEvent.setup();
    const { calls } = stubFetch({ 'GET api/apps': listing([running({ tunnel: TUNNEL })]) });
    render(<App />);
    const card = await screen.findByRole('article', { name: 'web' });
    await user.click(within(card).getByRole('button', { name: 'Edit' }));
    await user.click(within(card).getByRole('button', { name: 'Cancel' }));
    expect(within(card).queryByRole('form', { name: 'Edit share login' })).toBeNull();
    expect(writes(calls)).toStrictEqual([]);
  });
});
