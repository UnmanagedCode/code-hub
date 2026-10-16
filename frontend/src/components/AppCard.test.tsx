import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppCard } from './AppCard';
import { FEEDBACK_MS } from './CopyButton';
import { HubProvider } from '@/hub';
import { PASSWORD_MASK } from '@/lib/shareState';
import type { App } from '@/lib/types';
import { app, listing, stubFetch } from '@/test/fixtures';

const EVIL_HTML = '<img src=x onerror="alert(1)">';
const EVIL_SCRIPT = '<script>alert(1)</script>';
const QR = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" onload="alert(1)"><path d="M0 0h1v1H0z"/></svg>';

function renderCard(a: App, worktrees: App[] = []) {
  stubFetch({ 'GET api/apps': listing([a, ...worktrees]) });
  return render(<HubProvider><AppCard app={a} worktrees={worktrees} /></HubProvider>);
}

const card = (name: string) => screen.getByRole('article', { name });

// The poll is driven by hand; testing-library's own waits keep real timeouts.
beforeEach(() => { vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }); });
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
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
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
  // Invariant: the worktree list starts collapsed, its toggle reports the state, and expanding shows the subcards;
  // the only style then present is Radix's own collapsible bookkeeping, never content.
  it('the toggle flips aria-expanded and shows the subcards', async () => {
    const user = userEvent.setup();
    const wts = [app({ id: 'web:b', project: 'web', isWorktree: true, branch: 'beta' }), app({ id: 'web:a', project: 'web', isWorktree: true, branch: 'alpha' })];
    renderCard(app({ id: 'web' }), wts);
    const toggle = screen.getByRole('button', { name: '2 worktrees' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('article', { name: 'web:a' })).toBeNull();
    await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('article', { name: 'web:a' })).toBeTruthy();
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
