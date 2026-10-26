import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppCard } from './AppCard';
import { FEEDBACK_MS } from './CopyButton';
import { HubProvider } from '@/hub';
import { PASSWORD_MASK } from '@/lib/shareState';
import type { App, RelayInfo, Tunnel } from '@/lib/types';
import { app, listing, stubFetch } from '@/test/fixtures';

const EVIL_HTML = '<img src=x onerror="alert(1)">';
const EVIL_SCRIPT = '<script>alert(1)</script>';
const QR = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" onload="alert(1)"><path d="M0 0h1v1H0z"/></svg>';

function renderCard(a: App, worktrees: App[] = []) {
  stubFetch({ 'GET api/apps': listing([a, ...worktrees]) });
  return render(<HubProvider><AppCard app={a} worktrees={worktrees} /></HubProvider>);
}

const card = (name: string) => screen.getByRole('article', { name });

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('content renders as text', () => {
  // Invariant: a hostile app name, crash output or route name shows as its text and creates no element.
  it('a hostile name, error and route name render as text, never markup', () => {
    const { container } = renderCard(app({
      id: 'evil', name: EVIL_HTML, status: 'running', error: EVIL_SCRIPT,
      routes: [
        { name: EVIL_HTML, path: '/', urls: ['http://127.0.0.1:5000/'] },
        { name: EVIL_SCRIPT, path: '/x', urls: ['http://127.0.0.1:5000/x'] },
      ],
    }));
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(screen.getByRole('heading', { name: EVIL_HTML })).toBeTruthy();
    expect(screen.getByText(EVIL_SCRIPT, { selector: 'pre' })).toBeTruthy();
    expect(screen.getByText(EVIL_SCRIPT, { selector: 'span' })).toBeTruthy();
  });

  // Invariant: a URL from data that is not absolute http(s) is shown as text and never becomes a link,
  // and the Open button that would carry it is not rendered.
  it('javascript: and data: route and share URLs render as text, not links', () => {
    const js = 'javascript:alert(1)';
    const data = 'data:text/html,<script>alert(2)</script>';
    const { container } = renderCard(app({
      id: 'x', status: 'running',
      routes: [{ name: 'Main', path: '/', urls: [js, data] }],
      tunnel: { kind: 'lan', url: js, urls: [js, data], authUrl: data, auth: false },
    }));
    for (const a of container.querySelectorAll('a')) expect(a.getAttribute('href')).toMatch(/^https?:/);
    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(screen.getAllByText(js).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(data).length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByRole('link', { name: /open/i })).toBeNull();
  });

  // Invariant: every link opens in a new tab with no opener and no referrer.
  it('external links get target=_blank and rel="noopener noreferrer"', () => {
    const { container } = renderCard(app({
      id: 'web', status: 'ready',
      routes: [{ name: 'Main', path: '/', urls: ['http://127.0.0.1:5000/', 'http://192.0.2.1:5000/'] }],
      tunnel: { kind: 'lan', url: 'http://192.0.2.1:6000/', urls: ['http://192.0.2.1:6000/', 'http://198.51.100.1:6000/'], auth: false },
    }));
    const links = [...container.querySelectorAll('a')];
    expect(links.length).toBeGreaterThanOrEqual(5);
    for (const a of links) {
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    }
  });
});

describe('share panel', () => {
  const shared = (over: Partial<App> = {}) => app({
    id: 'web', status: 'running',
    tunnel: { kind: 'tunnel', url: 'https://x.trycloudflare.com', authUrl: 'https://x.trycloudflare.com/?__hubauth=T', auth: true, username: 'hub', password: 'real-pass', passwordIsDefault: true, qrSvg: QR },
    ...over,
  });

  // Invariant: the QR is an <img> of a data: SVG, so the server's markup never enters the DOM (no live svg[onload]).
  it('the QR is a data: image, and no svg[onload] reaches the DOM', () => {
    const { container } = renderCard(shared());
    const img = screen.getByRole('button', { name: 'Enlarge QR code' }).querySelector('img')!;
    expect(img.getAttribute('src')).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
    expect(document.querySelector('svg[onload]')).toBeNull();
    expect(container.innerHTML).not.toContain('onload="alert(1)"');
  });

  // Invariant: a collapsed card sets no style attribute anywhere (nothing from content can become CSS).
  it('no element in the card carries a style attribute', () => {
    const wt = app({ id: 'web:k', project: 'web', isWorktree: true, branch: 'feat' });
    renderCard(shared({ error: 'crashed', routes: [{ name: 'Main', path: '/', urls: ['http://127.0.0.1:5000/'] }] }), [wt]);
    expect(card('web').querySelectorAll('[style]')).toHaveLength(0);
  });

  // Invariant: the QR dialog is keyboard-operable — reachable by Tab, opened with Enter, closed with Escape —
  // and focus returns to the thumbnail.
  it('keyboard: Tab to the QR, Enter opens "Scan to open", Escape closes and focus returns', async () => {
    const user = userEvent.setup();
    renderCard(shared());
    const thumb = screen.getByRole('button', { name: 'Enlarge QR code' });
    for (let i = 0; i < 40 && document.activeElement !== thumb; i++) await user.tab();
    expect(document.activeElement).toBe(thumb);
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog', { name: 'Scan to open' });
    expect(within(dialog).getByRole('img', { name: 'QR code for https://x.trycloudflare.com' })).toBeTruthy();
    expect(within(dialog).getByRole('link', { name: /open/i }).getAttribute('href')).toBe('https://x.trycloudflare.com/?__hubauth=T');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(thumb);
  });

  // Invariant: a default password shows masked, but Copy writes the real one, says so, and the feedback clears.
  it('Copy writes the real password, shows Copied, then reverts', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    renderCard(shared());
    expect(screen.getByText(PASSWORD_MASK)).toBeTruthy();
    expect(screen.queryByText('real-pass')).toBeNull();
    const copy = screen.getByRole('button', { name: 'Copy pass' });
    await act(async () => { fireEvent.click(copy); });
    expect(writeText).toHaveBeenCalledWith('real-pass');
    expect(copy.textContent).toBe('Copied');
    act(() => { vi.advanceTimersByTime(FEEDBACK_MS); });
    expect(copy.textContent).toBe('Copy');
  });

  // Invariant: a refused clipboard write says so instead of claiming success.
  it('a failed copy says Copy failed', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn(async () => { throw new Error('denied'); }) } });
    renderCard(shared());
    const copy = screen.getByRole('button', { name: 'Copy link' });
    await act(async () => { fireEvent.click(copy); });
    expect(copy.textContent).toBe('Copy failed');
  });
});

describe('worktrees', () => {
  // Invariant: the worktree list starts collapsed, its toggle reports the state, and expanding shows the subcards,
  // each named apart from its parent; the only style then present is Radix's own collapsible bookkeeping, never content.
  it('the toggle flips aria-expanded and shows the subcards', async () => {
    const user = userEvent.setup();
    // Worktrees inherit the project's name; a detached one has no branch.
    const wts = [app({ id: 'web:b', project: 'web', name: 'web', isWorktree: true, branch: 'beta' }), app({ id: 'web:a', project: 'web', name: 'web', isWorktree: true, branch: null })];
    renderCard(app({ id: 'web' }), wts);
    const toggle = screen.getByRole('button', { name: '2 worktrees' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('article', { name: 'web — beta' })).toBeNull();
    await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    // Each card is told apart from its parent by branch, else id.
    expect(screen.getAllByRole('article').map((a) => a.getAttribute('aria-label'))).toStrictEqual(['web', 'web — beta', 'web — web:a']);
    for (const el of card('web').querySelectorAll('[style]')) {
      expect(el.getAttribute('data-slot')).toBe('collapsible-content');
      for (const decl of (el.getAttribute('style') ?? '').split(';').map((d) => d.trim()).filter(Boolean)) {
        expect(decl).toMatch(/^(?:transition-duration|animation-name|--radix-collapsible-content-(?:height|width)):/);
      }
    }
    await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });
});

// Every element styled as a button is a real <button> or an http(s) link — a refused URL never leaves a
// button-styled stand-in behind.
function expectOnlyRealButtons(scope: Element) {
  for (const el of scope.querySelectorAll('[data-slot="button"]')) {
    const ok = el.tagName === 'BUTTON' || (el.tagName === 'A' && /^https?:/.test(el.getAttribute('href') ?? ''));
    expect(ok, el.outerHTML).toBe(true);
  }
}

describe('refused URLs', () => {
  // Invariant: a route whose URL is refused gets no Open control of any kind.
  it('RouteList renders no Open control for a refused route URL', () => {
    renderCard(app({ id: 'x', status: 'running', routes: [{ name: 'Main', path: '/', urls: ['javascript:alert(1)'] }] }));
    const routes = screen.getByRole('list', { name: 'Routes' });
    expect(within(routes).queryByText(/^Open/)).toBeNull();
    expect(within(routes).queryByRole('button', { name: /open/i })).toBeNull();
    expect(within(routes).queryByRole('link', { name: /open/i })).toBeNull();
    expect(within(routes).getAllByText('javascript:alert(1)')).toHaveLength(1);
    expectOnlyRealButtons(routes);
  });

  // Invariant: when the share's Open URL is refused, neither the panel nor the QR dialog offers Open.
  it('QrDialog and the share panel render no Open control for a refused open URL', async () => {
    const user = userEvent.setup();
    renderCard(app({ id: 'x', status: 'running', tunnel: { kind: 'tunnel', url: 'https://x.trycloudflare.com', authUrl: 'javascript:alert(1)', auth: true, username: 'hub', password: 'pw', qrSvg: QR } }));
    const share = screen.getByRole('region', { name: 'Share' });
    expect(within(share).queryByText(/^Open/)).toBeNull();
    expect(within(share).queryByRole('button', { name: /open/i })).toBeNull();
    expect(within(share).queryByRole('link', { name: /open/i })).toBeNull();
    expect(within(share).queryByText('javascript:alert(1)')).toBeNull();
    expectOnlyRealButtons(share);
    await user.click(within(share).getByRole('button', { name: 'Enlarge QR code' }));
    const dialog = await screen.findByRole('dialog', { name: 'Scan to open' });
    expect(within(dialog).queryByText(/^Open/)).toBeNull();
    expect(within(dialog).queryByRole('button', { name: /open/i })).toBeNull();
    expect(within(dialog).queryByRole('link', { name: /open/i })).toBeNull();
    expect(within(dialog).queryByText('javascript:alert(1)')).toBeNull();
    expectOnlyRealButtons(dialog);
  });
});

describe('control states', () => {
  const btn = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

  // Invariant: Start is disabled when the source is gone or the manifest is broken, enabled otherwise.
  it('Start: disabled with the source removed or a manifest error', () => {
    const { unmount } = renderCard(app({ id: 'a', status: 'stopped' }));
    expect(btn('Start').disabled).toBe(false);
    unmount();
    const second = renderCard(app({ id: 'a', status: 'stopped', sourceMissing: true }));
    expect(btn('Start').disabled).toBe(true);
    second.unmount();
    renderCard(app({ id: 'a', status: 'stopped', manifestError: 'bad json' }));
    expect(btn('Start').disabled).toBe(true);
  });

  // Invariant: a running app whose source is gone can be stopped but not restarted.
  it('Restart is disabled with the source removed; Stop is not', () => {
    renderCard(app({ id: 'a', status: 'running', sourceMissing: true }));
    expect(btn('Restart').disabled).toBe(true);
    expect(btn('Stop').disabled).toBe(false);
  });

  // Invariant: a shared app's Share control reads Shared and is disabled.
  it('Shared is disabled', () => {
    renderCard(app({ id: 'a', status: 'running', tunnel: { kind: 'lan', url: 'http://192.0.2.1:5001', auth: false } }));
    expect(btn('Shared').disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Share' })).toBeNull();
  });
});

describe('call sites', () => {
  // Invariant: with a default password, the Edit form's password field starts empty and says the default is kept.
  it('a default password: the field starts blank with the masked placeholder', async () => {
    const user = userEvent.setup();
    renderCard(app({ id: 'a', status: 'running', tunnel: { kind: 'tunnel', url: 'https://x.trycloudflare.com', auth: true, username: 'hub', password: 'secret-default', passwordIsDefault: true } }));
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const pass = screen.getByLabelText('pass') as HTMLInputElement;
    expect(pass.value).toBe('');
    expect(pass.placeholder).toBe(`${PASSWORD_MASK} (default — type to replace)`);
    expect(screen.queryByDisplayValue('secret-default')).toBeNull();
  });

  const lan = (over: Partial<Tunnel> = {}) => app({
    id: 'web', status: 'running',
    tunnel: { kind: 'lan', url: 'https://172.17.0.5:7100', auth: false, qrSvg: QR, ...over },
  });
  const relayInfo = (over: Partial<RelayInfo> = {}): RelayInfo => ({ state: 'up', error: null, port: 7200, requestedPort: null, portFallback: false, ...over });

  // Invariant: a container-internal share warns and offers no QR to scan, while Open stays.
  it('a container-internal LAN share: a warning, and no QR', () => {
    renderCard(lan({ containerInternal: true, relay: null }));
    expect(screen.getByRole('alert').textContent).toMatch(/internal to code-hub's container/);
    expect(screen.queryByRole('button', { name: 'Enlarge QR code' })).toBeNull();
    expect(screen.getByRole('link', { name: /open/i })).toBeTruthy();
  });

  // Invariant: a relay-backed share shows the relay note (not an alert) and keeps its QR.
  it('a relay-backed LAN share: the relay note, and the QR', () => {
    renderCard(lan({ url: 'https://192.168.1.20:7200', containerInternal: false, relay: relayInfo() }));
    expect(screen.getByText(/host's LAN through the code-hub relay/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Enlarge QR code' })).toBeTruthy();
  });

  // Invariant: a failed relay is an alert naming the error.
  it('a failed relay: an alert with the error', () => {
    renderCard(lan({ containerInternal: true, relay: relayInfo({ state: 'failed', error: 'connect ECONNREFUSED 10.0.0.1:7077' }) }));
    expect(screen.getByRole('alert').textContent).toMatch(/Host exposure failed: connect ECONNREFUSED 10\.0\.0\.1:7077/);
  });

  // Invariant: a relay that isn't connected is an alert carrying the reason (resolveLanReachNotice's call site).
  it('a relay that is down: an alert with its reason', () => {
    renderCard(lan({ containerInternal: true, relay: relayInfo({ state: 'down', error: 'connection to the relay lost: the relay closed the connection', port: null }) }));
    expect(screen.getByRole('alert').textContent).toMatch(/host relay isn't connected \(connection to the relay lost: the relay closed the connection\)/);
  });

  // Invariant: a relay waiting for its host.json to change says so, and promises no retry (resolveLanReachNotice's call site).
  it('a relay waiting for its host.json: an alert that names the wait', () => {
    renderCard(lan({ containerInternal: true, relay: relayInfo({ state: 'down', error: 'bad host.json', port: null, recovery: 'relay-file' }) }));
    const text = screen.getByRole('alert').textContent ?? '';
    expect(text).toMatch(/waits for the relay's host\.json to change/);
    expect(text).not.toMatch(/retrying/);
  });

  // Invariant: the "edited X ago" label carries the commit's absolute date as its title.
  it('the edited label carries the absolute date', () => {
    const iso = '2026-01-02T03:04:05Z';
    renderCard(app({ id: 'a', lastCommitAt: iso }));
    expect(screen.getByText(/^edited /).getAttribute('title')).toBe(new Date(iso).toLocaleString());
  });
});
