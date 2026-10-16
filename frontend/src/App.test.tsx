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
    const wt = running({ id: 'web:k', project: 'web', name: 'web', isWorktree: true, branch: 'feat' });
    const shareResponse: Tunnel = { ...LAN, auth: false, username: null, password: null, authUrl: undefined };
    const { calls } = stubFetch({
      'GET api/apps': listing([app({ id: 'web' }), wt], { tailscaleAvailable: false }),
      'POST api/apps/web%3Ak/share': shareResponse,
    });
    render(<App />);
    await user.click(await screen.findByRole('button', { name: '1 worktree' }));
    const card = screen.getByRole('article', { name: 'web — feat' });
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

// A response held open until released, for observing the UI while a request is in flight.
function held<T>(reply: T) {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  return { release, reply: async () => { await gate; return json(reply); } };
}

describe('busy state', () => {
  // Invariant: after an action, its controls stay disabled until the refreshed listing has landed, so a second
  // click cannot repeat the action against the pre-action listing.
  it('Stop stays disabled until the post-action listing arrives', async () => {
    const user = userEvent.setup();
    const { routes, calls } = stubFetch({ 'GET api/apps': listing([running()]), 'POST api/apps/web/stop': { id: 'web', status: 'stopped' } });
    render(<App />);
    const card = await screen.findByRole('article', { name: 'web' });
    const after = held(listing([app({ id: 'web' })]));
    routes['GET api/apps'] = after.reply;
    const before = gets(calls);
    await user.click(within(card).getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(gets(calls)).toBe(before + 1));
    await act(async () => {});
    const stop = within(card).getByRole('button', { name: 'Stop' }) as HTMLButtonElement;
    expect(stop.disabled).toBe(true);
    await user.click(stop);
    expect(writes(calls)).toStrictEqual([{ method: 'POST', url: 'api/apps/web/stop', body: undefined }]);
    after.release();
    expect(await within(card).findByRole('button', { name: 'Start' })).toBeTruthy();
    expect((within(card).getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled).toBe(false);
  });

  // Invariant: while an action is in flight every control of that card is disabled.
  it('an in-flight Restart disables Stop, Restart and Share', async () => {
    const user = userEvent.setup();
    const post = held({ id: 'web', status: 'starting' });
    const { calls } = stubFetch({ 'GET api/apps': listing([running()]), 'POST api/apps/web/restart': post.reply });
    render(<App />);
    const card = await screen.findByRole('article', { name: 'web' });
    await user.click(within(card).getByRole('button', { name: 'Restart' }));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    for (const name of ['Stop', 'Restart', 'Share']) {
      expect((within(card).getByRole('button', { name }) as HTMLButtonElement).disabled, name).toBe(true);
    }
    post.release();
    await waitFor(() => expect((within(card).getByRole('button', { name: 'Restart' }) as HTMLButtonElement).disabled).toBe(false));
  });
});

describe('share lifecycle', () => {
  // Shares the app in-session over LAN and opens the Edit form, so the app has both share state and a draft.
  async function sharedAndEditing(extra: Record<string, unknown> = {}) {
    const user = userEvent.setup();
    const stub = stubFetch({ 'GET api/apps': listing([running()]), 'POST api/apps/web/share': LAN, ...extra });
    render(<App />);
    const card = await screen.findByRole('article', { name: 'web' });
    await user.click(within(card).getByRole('button', { name: 'Share' }));
    await user.click(within(card).getByRole('button', { name: 'LAN' }));
    await user.click(await within(card).findByRole('button', { name: 'Edit' }));
    within(card).getByRole('form', { name: 'Edit share login' });
    return { user, card, ...stub };
  }
  const reshareOpensNoForm = async (user: ReturnType<typeof userEvent.setup>, card: HTMLElement) => {
    await user.click(within(card).getByRole('button', { name: 'Share' }));
    await user.click(within(card).getByRole('button', { name: 'LAN' }));
    await within(card).findByRole('region', { name: 'Share' });
    expect(within(card).queryByRole('form', { name: 'Edit share login' })).toBeNull();
  };

  // Invariant: Restart posts `restart` and drops the app's share state and draft (the server tore the share down).
  it('Restart posts restart and clears the share and the draft', async () => {
    const { user, card, calls } = await sharedAndEditing({ 'POST api/apps/web/restart': { id: 'web', status: 'starting' } });
    await user.click(within(card).getByRole('button', { name: 'Restart' }));
    await waitFor(() => expect(within(card).queryByRole('region', { name: 'Share' })).toBeNull());
    expect(writes(calls).map((c) => `${c.method} ${c.url}`)).toStrictEqual(['POST api/apps/web/share', 'POST api/apps/web/restart']);
    await reshareOpensNoForm(user, card);
  });

  // Invariant: Unshare sends DELETE and drops the app's share state and draft.
  it('Unshare deletes the share and clears the share and the draft', async () => {
    const { user, card, calls } = await sharedAndEditing({ 'DELETE api/apps/web/share': { id: 'web', tunnel: null } });
    await user.click(within(card).getByRole('button', { name: 'Unshare' }));
    await waitFor(() => expect(within(card).queryByRole('region', { name: 'Share' })).toBeNull());
    expect(writes(calls).map((c) => `${c.method} ${c.url}`)).toStrictEqual(['POST api/apps/web/share', 'DELETE api/apps/web/share']);
    await reshareOpensNoForm(user, card);
  });

  // Invariant: Cancel in the share picker closes it without a request.
  it('Cancel in the share picker closes it and sends nothing', async () => {
    const user = userEvent.setup();
    const { calls } = stubFetch({ 'GET api/apps': listing([running()]) });
    render(<App />);
    const card = await screen.findByRole('article', { name: 'web' });
    await user.click(within(card).getByRole('button', { name: 'Share' }));
    await user.click(within(card).getByRole('button', { name: 'Cancel' }));
    expect(within(card).queryByRole('button', { name: 'LAN' })).toBeNull();
    expect(writes(calls)).toStrictEqual([]);
  });

  // Invariant: Save merges the PATCH response into the in-session share state, so the panel shows the new QR and
  // login from that response, while the share's own magic-link is kept.
  it('Save after an in-session share shows the PATCH response, not a stale or listed one', async () => {
    const shareResponse: Tunnel = { ...TUNNEL, qrSvg: '<svg xmlns="http://www.w3.org/2000/svg"><desc>from-share</desc></svg>' };
    const listed: Tunnel = { ...TUNNEL, authUrl: 'https://x.trycloudflare.com/?__hubauth=LISTED', qrSvg: '<svg xmlns="http://www.w3.org/2000/svg"><desc>from-list</desc></svg>' };
    const patched = { id: 'web', username: 'alice', password: 'pw', passwordIsDefault: false, qrSvg: '<svg xmlns="http://www.w3.org/2000/svg"><desc>from-patch</desc></svg>' };
    const user = userEvent.setup();
    const { routes } = stubFetch({ 'GET api/apps': listing([running()]), 'POST api/apps/web/share': shareResponse, 'PATCH api/apps/web/share/credentials': patched });
    render(<App />);
    const card = await screen.findByRole('article', { name: 'web' });
    await user.click(within(card).getByRole('button', { name: 'Share' }));
    routes['GET api/apps'] = listing([running({ tunnel: listed })]);
    await user.click(within(card).getByRole('button', { name: 'cloudflared' }));
    await user.click(await within(card).findByRole('button', { name: 'Edit' }));
    const userInput = within(card).getByLabelText('user');
    await user.clear(userInput);
    await user.type(userInput, 'alice{Enter}');
    await waitFor(() => expect(within(card).queryByRole('form', { name: 'Edit share login' })).toBeNull());
    const share = within(card).getByRole('region', { name: 'Share' });
    const qr = within(share).getByRole('button', { name: 'Enlarge QR code' }).querySelector('img')!;
    expect(decodeURIComponent(qr.getAttribute('src')!)).toContain('from-patch');
    expect(within(share).getByRole('link', { name: /open/i }).getAttribute('href')).toBe(TUNNEL.authUrl);
  });
});

describe('edit form details', () => {
  // Invariant: Cancel discards typed changes without submitting the form.
  it('Cancel after typing sends nothing and closes the form', async () => {
    const user = userEvent.setup();
    const { calls } = stubFetch({ 'GET api/apps': listing([running({ tunnel: TUNNEL })]) });
    render(<App />);
    const card = await screen.findByRole('article', { name: 'web' });
    await user.click(within(card).getByRole('button', { name: 'Edit' }));
    const pass = within(card).getByLabelText('pass');
    await user.clear(pass);
    await user.type(pass, 'typed-but-cancelled');
    await user.click(within(card).getByRole('button', { name: 'Cancel' }));
    expect(within(card).queryByRole('form', { name: 'Edit share login' })).toBeNull();
    await act(async () => {});
    expect(writes(calls)).toStrictEqual([]);
    await user.click(within(card).getByRole('button', { name: 'Edit' }));
    expect((within(card).getByLabelText('pass') as HTMLInputElement).value).toBe('pw');
  });

  // Invariant: ticking "Also save as this app's default login" sends saveAsDefault on the credentials PATCH.
  it('ticking save-as-default sends saveAsDefault: true', async () => {
    const user = userEvent.setup();
    const { calls } = stubFetch({
      'GET api/apps': listing([running({ tunnel: TUNNEL })]),
      'PATCH api/apps/web/share/credentials': { id: 'web', username: 'hub', password: 'pw', passwordIsDefault: true },
    });
    render(<App />);
    const card = await screen.findByRole('article', { name: 'web' });
    await user.click(within(card).getByRole('button', { name: 'Edit' }));
    await user.click(within(card).getByRole('checkbox', { name: "Also save as this app's default login" }));
    await user.click(within(card).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)).toStrictEqual([{ method: 'PATCH', url: 'api/apps/web/share/credentials', body: { saveAsDefault: true } }]);
  });

  // Invariant: a draft whose app left the listing is dropped, so it does not reopen when the app comes back.
  it('a draft of an app that left the listing does not come back with it', async () => {
    const user = userEvent.setup();
    const { routes, calls } = stubFetch({ 'GET api/apps': listing([running({ tunnel: TUNNEL })]) });
    render(<App />);
    const card = await screen.findByRole('article', { name: 'web' });
    await user.click(within(card).getByRole('button', { name: 'Edit' }));
    const poll = async (apps: AppT[]) => {
      routes['GET api/apps'] = listing(apps);
      const before = gets(calls);
      await tick();
      await waitFor(() => expect(gets(calls)).toBe(before + 1));
      await act(async () => {});
    };
    await poll([]);
    expect(screen.queryByRole('article', { name: 'web' })).toBeNull();
    await poll([running({ tunnel: TUNNEL })]);
    const back = await screen.findByRole('article', { name: 'web' });
    expect(within(back).queryByRole('form', { name: 'Edit share login' })).toBeNull();
    expect(within(back).getByRole('button', { name: 'Edit' })).toBeTruthy();
  });
});

describe('list details', () => {
  // Invariant: worktrees whose main checkout isn't listed get a "no main checkout" parent, never hidden.
  it('an orphan worktree shows under a "no main checkout" parent', async () => {
    const user = userEvent.setup();
    stubFetch({ 'GET api/apps': listing([app({ id: 'lost:k', project: 'lost', name: 'lost', isWorktree: true, branch: 'fix' })]) });
    render(<App />);
    const parent = await screen.findByRole('article', { name: 'lost' });
    expect(within(parent).getByText('no main checkout')).toBeTruthy();
    expect(within(parent).queryByRole('button', { name: 'Start' })).toBeNull();
    await user.click(within(parent).getByRole('button', { name: '1 worktree' }));
    const wt = screen.getByRole('article', { name: 'lost — fix' });
    expect(within(wt).getByRole('button', { name: 'Start' })).toBeTruthy();
  });

  // Invariant: the toolbar's controls carry their names: the Refresh button (which reloads the listing) and each
  // sort option's label for its value.
  it('toolbar: Refresh is named and reloads; sort options pair label and value', async () => {
    const user = userEvent.setup();
    const { calls } = stubFetch({ 'GET api/apps': listing([app({ id: 'web' })]) });
    render(<App />);
    await screen.findByRole('article', { name: 'web' });
    const before = gets(calls);
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(gets(calls)).toBe(before + 1));
    const select = screen.getByRole('combobox', { name: 'Sort' }) as HTMLSelectElement;
    expect(select.value).toBe('edited');
    expect(within(select).getAllByRole('option').map((o) => [o.textContent, (o as HTMLOptionElement).value])).toStrictEqual([
      ['Last edited', 'edited'], ['Name', 'name'], ['Status', 'status'],
    ]);
  });
});
