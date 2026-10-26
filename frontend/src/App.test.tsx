import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { App as AppT, Tunnel } from '@/lib/types';
import { app, json, listing, stubFetch } from '@/test/fixtures';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); Reflect.deleteProperty(document, 'visibilityState'); });

// A tab-return refresh, as the browser signals it.
const tabReturn = () => act(async () => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  document.dispatchEvent(new Event('visibilitychange'));
});
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

  // Invariant: a failed refresh after a successful load keeps the cards and says they are stale.
  it('a failed manual Refresh after load keeps the list and shows the stale alert', async () => {
    const user = userEvent.setup();
    const { routes, calls } = stubFetch({ 'GET api/apps': listing([app({ id: 'web' })]) });
    render(<App />);
    await screen.findByRole('article', { name: 'web' });
    routes['GET api/apps'] = () => json({ error: 'down' }, 502);
    const before = gets(calls);
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(gets(calls)).toBe(before + 1));
    expect((await screen.findByRole('alert')).textContent).toMatch(/^Can't reach code-hub — showing data from /);
    expect(screen.getByRole('article', { name: 'web' })).toBeTruthy();
    routes['GET api/apps'] = listing([app({ id: 'web' })]);
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  // Invariant: nothing on the page reloads the listing on a timer.
  it('after the first load, minutes pass with no further GET api/apps', async () => {
    vi.useFakeTimers();
    const { calls } = stubFetch({ 'GET api/apps': listing([running()]) });
    render(<App />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByRole('article', { name: 'web' })).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000); });
    expect(gets(calls)).toBe(1);
  });

  // Invariant: the header reports which share backends are available; an available tailscale also counts its
  // Funnel ports in use.
  it('the header shows cloudflared and tailscale availability', async () => {
    const { routes } = stubFetch({ 'GET api/apps': listing([], { cloudflaredAvailable: true, tailscaleAvailable: false }) });
    render(<App />);
    expect(await screen.findByText('cloudflared ✓')).toBeTruthy();
    expect(screen.getByText('no tailscale')).toBeTruthy();
    routes['GET api/apps'] = listing([], { cloudflaredAvailable: false, tailscaleAvailable: true });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByRole('button', { name: 'tailscale ✓ 0/3' })).toBeTruthy();
    expect(screen.getByText('no cloudflared')).toBeTruthy();
  });

  // Invariant: the tailscale badge counts the Funnel ports in use and lists each port's holder (on hover via its
  // title, on click in a popover); it changes only when a new listing arrives.
  it('the header tailscale badge shows ports in use and, on click, lists each port and its holder; it changes only with a new listing', async () => {
    const user = userEvent.setup();
    const ports = (holders: (string | null)[]) => [443, 8443, 10000].map((port, i) => ({ port, holder: holders[i] }));
    const { routes } = stubFetch({ 'GET api/apps': listing([], { tailscaleAvailable: true, funnelPorts: ports([null, 'web', null]) }) });
    render(<App />);
    const badge = await screen.findByRole('button', { name: 'tailscale ✓ 1/3' });
    expect(badge.getAttribute('title')).toBe(':443 — free\n:8443 — web\n:10000 — free');
    await user.click(badge);
    const popover = await screen.findByRole('dialog');
    expect(within(popover).getAllByRole('listitem').map((li) => li.textContent)).toStrictEqual([':443 — free', ':8443 — web', ':10000 — free']);
    await user.keyboard('{Escape}');

    routes['GET api/apps'] = listing([], { tailscaleAvailable: true, funnelPorts: ports(['api', 'web', null]) });
    expect(screen.getByRole('button', { name: 'tailscale ✓ 1/3' })).toBeTruthy(); // nothing reloads on its own
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByRole('button', { name: 'tailscale ✓ 2/3' })).toBeTruthy();
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

describe('layout', () => {
  // Invariant: <main> is capped by cc's session width, falling back to 42rem standalone.
  it('main follows --cc-session-width with a 42rem fallback', () => {
    stubFetch({ 'GET api/apps': listing([]) });
    render(<App />);
    const main = screen.getByRole('main');
    expect(main.classList.contains('max-w-[var(--cc-session-width,42rem)]')).toBe(true);
    expect(main.classList.contains('max-w-2xl')).toBe(false);
  });

  // Invariant: the cards sit in an auto-fill grid, and the stale alert spans every column.
  it('cards flow in an auto-fill grid; the stale alert spans all columns', async () => {
    const { routes } = stubFetch({ 'GET api/apps': listing([app({ id: 'web' })]) });
    render(<App />);
    const card = await screen.findByRole('article', { name: 'web' });
    const list = card.parentElement!;
    for (const c of ['grid', 'grid-cols-[repeat(auto-fill,minmax(min(36rem,100%),1fr))]', '[&>*]:min-w-0']) {
      expect(list.classList.contains(c), c).toBe(true);
    }
    routes['GET api/apps'] = () => json({ error: 'down' }, 502);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Refresh' }));
    expect((await screen.findByRole('alert')).classList.contains('col-span-full')).toBe(true);
  });
});

describe('layout empty state', () => {
  // Invariant: the empty-state text spans every grid column.
  it('the empty text spans all columns', async () => {
    stubFetch({ 'GET api/apps': listing([]) });
    render(<App />);
    const text = await screen.findByText('No apps found. Add a .hub.json to a sibling project.');
    expect(text.classList.contains('col-span-full')).toBe(true);
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

  // Invariant: tailscale asks for a Funnel port before sharing; a port another app holds is disabled saying who
  // holds it, and the chosen port is posted and shown on the share.
  it('Share → tailscale shows the Funnel port row; a port held by another app is disabled with "used by <app>"; :8443 posts {mode:"tailscale",funnelPort:8443} and the panel shows the :8443 URL and "port 8443"', async () => {
    const user = userEvent.setup();
    const share: Tunnel = { kind: 'tailscale', url: 'https://node.tailnet.ts.net:8443', funnelPort: 8443, auth: true, username: 'hub', password: 'pw', authUrl: 'https://node.tailnet.ts.net:8443?__hubauth=T' };
    const { calls } = stubFetch({
      'GET api/apps': listing([running()], { tailscaleAvailable: true, funnelPorts: [{ port: 443, holder: 'api' }, { port: 8443, holder: null }, { port: 10000, holder: null }] }),
      'POST api/apps/web/share': share,
    });
    render(<App />);
    const card = await screen.findByRole('article', { name: 'web' });
    await user.click(within(card).getByRole('button', { name: 'Share' }));
    expect(within(card).queryByRole('group', { name: 'Funnel port' })).toBeNull();
    await user.click(within(card).getByRole('button', { name: 'tailscale' }));
    expect(writes(calls)).toStrictEqual([]);
    const row = within(card).getByRole('group', { name: 'Funnel port' });
    const held = within(row).getByRole('button', { name: ':443' }) as HTMLButtonElement;
    expect(held.disabled).toBe(true);
    expect(document.getElementById(held.getAttribute('aria-describedby')!)?.textContent).toContain('used by api');
    expect((within(row).getByRole('button', { name: ':10000' }) as HTMLButtonElement).disabled).toBe(false);
    await user.click(within(row).getByRole('button', { name: ':8443' }));
    expect(await within(card).findByText('https://node.tailnet.ts.net:8443')).toBeTruthy();
    expect(within(card).getByText(/port 8443/)).toBeTruthy();
    expect(writes(calls)).toStrictEqual([{ method: 'POST', url: 'api/apps/web/share', body: { mode: 'tailscale', funnelPort: 8443 } }]);
  });

  // Invariant: with every Funnel port held by other apps, tailscale can't be picked, and says why.
  it('every Funnel port held by other apps disables tailscale with "all Funnel ports in use"', async () => {
    const user = userEvent.setup();
    stubFetch({ 'GET api/apps': listing([running()], { tailscaleAvailable: true, funnelPorts: [443, 8443, 10000].map((port) => ({ port, holder: 'api' })) }) });
    render(<App />);
    const card = await screen.findByRole('article', { name: 'web' });
    await user.click(within(card).getByRole('button', { name: 'Share' }));
    const tailscale = within(card).getByRole('button', { name: 'tailscale' }) as HTMLButtonElement;
    expect(tailscale.disabled).toBe(true);
    expect(document.getElementById(tailscale.getAttribute('aria-describedby')!)?.textContent).toBe('all Funnel ports in use');
  });

  // Invariant: a refused share — a 409 for a held Funnel port included — shows the server's message in the card.
  it('a share 409 renders in the share panel\'s alert', async () => {
    const user = userEvent.setup();
    const error = "'other' already has a tailscale share on Funnel port 443 — unshare it, or share on another port";
    stubFetch({ 'GET api/apps': listing([running()], { tailscaleAvailable: true }), 'POST api/apps/web/share': () => json({ error }, 409) });
    render(<App />);
    const card = await screen.findByRole('article', { name: 'web' });
    await user.click(within(card).getByRole('button', { name: 'Share' }));
    await user.click(within(card).getByRole('button', { name: 'tailscale' }));
    await user.click(within(card).getByRole('button', { name: ':443' }));
    expect((await within(card).findByRole('alert')).textContent).toBe(error);
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
  // Invariant: a refresh does not disturb an open Edit form: the typed value and the focus survive it.
  it('typing in the Edit form keeps its value and focus across a tab-return refresh', async () => {
    const user = userEvent.setup();
    const { calls } = stubFetch({ 'GET api/apps': listing([running({ tunnel: TUNNEL })]) });
    render(<App />);
    const card = await screen.findByRole('article', { name: 'web' });
    await user.click(within(card).getByRole('button', { name: 'Edit' }));
    const userInput = within(card).getByLabelText('user') as HTMLInputElement;
    await user.clear(userInput);
    await user.type(userInput, 'alice');
    const before = gets(calls);
    await tabReturn();
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

  // Invariant: Cancel backs out of the picker entirely even with the Funnel port row open, sending nothing.
  it('Cancel after opening the Funnel port row sends nothing and closes the picker', async () => {
    const user = userEvent.setup();
    const { calls } = stubFetch({ 'GET api/apps': listing([running()], { tailscaleAvailable: true }) });
    render(<App />);
    const card = await screen.findByRole('article', { name: 'web' });
    await user.click(within(card).getByRole('button', { name: 'Share' }));
    await user.click(within(card).getByRole('button', { name: 'tailscale' }));
    within(card).getByRole('group', { name: 'Funnel port' });
    await user.click(within(card).getByRole('button', { name: 'Cancel' }));
    expect(within(card).queryByRole('group', { name: 'Funnel port' })).toBeNull();
    expect(within(card).queryByRole('button', { name: 'tailscale' })).toBeNull();
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

  // Invariant: the Edit form's submit — by Enter in a field or by Save — is handled in script and never
  // submits natively (the CSP's form-action 'none' would block a native submit anyway).
  it('submitting the Edit form, by Enter or by Save, prevents the native submit', async () => {
    const user = userEvent.setup();
    const submits: boolean[] = [];
    // Registered on document, so it runs after React's root listener has handled the event.
    const onSubmit = (e: Event) => submits.push(e.defaultPrevented);
    document.addEventListener('submit', onSubmit);
    try {
      stubFetch({
        'GET api/apps': listing([running({ tunnel: TUNNEL })]),
        'PATCH api/apps/web/share/credentials': { id: 'web', username: 'hub', password: 'x', passwordIsDefault: false },
      });
      render(<App />);
      const card = await screen.findByRole('article', { name: 'web' });
      await user.click(within(card).getByRole('button', { name: 'Edit' }));
      await user.type(within(card).getByLabelText('pass'), '{Enter}');
      await waitFor(() => expect(within(card).queryByRole('form', { name: 'Edit share login' })).toBeNull());
      await user.click(within(card).getByRole('button', { name: 'Edit' }));
      await user.click(within(card).getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(within(card).queryByRole('form', { name: 'Edit share login' })).toBeNull());
      expect(submits).toStrictEqual([true, true]);
    } finally {
      document.removeEventListener('submit', onSubmit);
    }
  });

  // Invariant: the live share's Edit form no longer offers saving its login as the default (Settings owns it).
  it('the Edit form has no save-as-default checkbox', async () => {
    const user = userEvent.setup();
    stubFetch({ 'GET api/apps': listing([running({ tunnel: LAN })]) });
    render(<App />);
    const card = await screen.findByRole('article', { name: 'web' });
    await user.click(within(card).getByRole('button', { name: 'Edit' }));
    const form = within(card).getByRole('form', { name: 'Edit share login' });
    expect(within(form).getAllByRole('checkbox').map((c) => c.getAttribute('aria-label') ?? form.querySelector(`label[for="${c.id}"]`)?.textContent)).toStrictEqual(['Authentication', 'TLS (HTTPS)']);
    expect(within(form).queryByText(/default login/)).toBeNull();
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
      await tabReturn();
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

describe('transitions and automation', () => {
  // Invariant: a Start's transition reaches the page with no poll: the starting listing opens one settle wait,
  // and the listing loaded after it shows the app running.
  it('Start: starting → one GET settled → the next listing shows running', async () => {
    const user = userEvent.setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { routes, calls } = stubFetch({
      'GET api/apps': listing([app({ id: 'web' })]),
      'POST api/apps/web/start': { id: 'web' },
      'GET api/apps/web/settled': async () => { await gate; return json({ id: 'web', settled: true }); },
    });
    render(<App />);
    const card = await screen.findByRole('article', { name: 'web' });
    routes['GET api/apps'] = listing([app({ id: 'web', status: 'starting' })]);
    await user.click(within(card).getByRole('button', { name: 'Start' }));
    await within(card).findByText('starting');
    const settles = () => calls.filter((c) => c.url === 'api/apps/web/settled').length;
    await waitFor(() => expect(settles()).toBe(1));
    routes['GET api/apps'] = listing([running()]);
    release();
    expect(await within(card).findByText('running')).toBeTruthy();
    expect(settles()).toBe(1);
  });

  // Invariant: the card shows an auto-share in flight as a status, and its failure as an alert with the reason.
  it('auto-share pending shows "Sharing automatically…", failed shows the error', async () => {
    const user = userEvent.setup();
    const { routes } = stubFetch({
      'GET api/apps': listing([running({ autoShareStatus: 'pending' })]),
      'GET api/apps/web/settled': { id: 'web', settled: false },
    });
    render(<App />);
    const card = await screen.findByRole('article', { name: 'web' });
    expect(within(card).getByRole('status').textContent).toBe('Sharing automatically…');
    routes['GET api/apps'] = listing([running({ autoShareStatus: 'failed', autoShareError: "'other' already has a tailscale share" })]);
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    const alert = await within(card).findByRole('alert');
    expect(alert.textContent).toContain('Auto-share failed');
    expect(alert.textContent).toContain("'other' already has a tailscale share");
  });

  // Invariant: the always-on card surfaces its auto-share outcome like any card: pending as a status with Share
  // disabled, failed as an alert with the reason.
  it('always-on: auto-share pending and failed show on the card', async () => {
    const user = userEvent.setup();
    const conductor = (over: Partial<AppT>) => running({ id: 'code-conductor', alwaysOn: true, ...over });
    const { routes } = stubFetch({
      'GET api/apps': listing([conductor({ autoShareStatus: 'pending' })]),
      'GET api/apps/code-conductor/settled': { id: 'code-conductor', settled: false },
    });
    render(<App />);
    const card = await screen.findByRole('article', { name: 'code-conductor' });
    expect(within(card).getByRole('status').textContent).toBe('Sharing automatically…');
    expect((within(card).getByRole('button', { name: 'Share' }) as HTMLButtonElement).disabled).toBe(true);
    routes['GET api/apps'] = listing([conductor({ autoShareStatus: 'failed', autoShareError: 'cloudflared is not installed' })]);
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    const alert = await within(card).findByRole('alert');
    expect(alert.textContent).toContain('Auto-share failed');
    expect(alert.textContent).toContain('cloudflared is not installed');
  });

  // Invariant: the card's Share control is disabled while the app is starting or its auto-share is running, and
  // enabled again once neither holds.
  it('Share is disabled on a starting card and on one with an auto-share pending', async () => {
    const user = userEvent.setup();
    const { routes } = stubFetch({
      'GET api/apps': listing([app({ id: 'web', status: 'starting' }), app({ id: 'api', status: 'running', autoShareStatus: 'pending' })]),
    });
    render(<App />);
    for (const name of ['web', 'api']) {
      const card = await screen.findByRole('article', { name });
      expect((within(card).getByRole('button', { name: 'Share' }) as HTMLButtonElement).disabled, name).toBe(true);
    }
    routes['GET api/apps'] = listing([running(), app({ id: 'api', status: 'running' })]);
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    for (const name of ['web', 'api']) {
      const card = screen.getByRole('article', { name });
      await waitFor(() => expect((within(card).getByRole('button', { name: 'Share' }) as HTMLButtonElement).disabled, name).toBe(false));
    }
  });

  // Invariant: a failed boot auto-start is visible on the card.
  it('autoStartError shows as an alert on the card', async () => {
    stubFetch({ 'GET api/apps': listing([app({ id: 'web', autoStartError: 'port 3000 is already in use' })]) });
    render(<App />);
    const card = await screen.findByRole('article', { name: 'web' });
    expect(within(card).getByRole('alert').textContent).toContain('port 3000 is already in use');
  });
});
