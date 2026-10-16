import { afterEach, expect, it, vi } from 'vitest';

type Listener = () => void;
function stubMatchMedia(dark: boolean) {
  const listeners: Listener[] = [];
  const mq = {
    matches: dark,
    addEventListener: (_: string, l: Listener) => listeners.push(l),
    removeEventListener: () => {},
  };
  vi.stubGlobal('matchMedia', vi.fn(() => mq));
  return { mq, flip: (d: boolean) => { mq.matches = d; listeners.forEach((l) => l()); } };
}

const root = document.documentElement;
afterEach(() => {
  vi.unstubAllGlobals();
  root.classList.remove('dark');
  root.removeAttribute('data-cc-theme');
});

// Invariant: standalone, the page follows the OS theme, live.
it('standalone: follows prefers-color-scheme and its changes', async () => {
  const { flip } = stubMatchMedia(true);
  vi.resetModules();
  await import('../../public/theme-init.js');
  expect(root.classList.contains('dark')).toBe(true);
  flip(false);
  expect(root.classList.contains('dark')).toBe(false);
  flip(true);
  expect(root.classList.contains('dark')).toBe(true);
});

// Invariant: embedded (the bridge set data-cc-theme), the script leaves the theme to cc.
it('embedded: does nothing when data-cc-theme is set', async () => {
  root.setAttribute('data-cc-theme', 'light');
  stubMatchMedia(true);
  vi.resetModules();
  await import('../../public/theme-init.js');
  expect(root.classList.contains('dark')).toBe(false);
  expect(window.matchMedia).not.toHaveBeenCalled();
});
