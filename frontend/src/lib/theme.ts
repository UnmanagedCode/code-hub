import { useSyncExternalStore } from 'react';

export type Theme = 'light' | 'dark';

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}
const current = (): Theme => (document.documentElement.classList.contains('dark') ? 'dark' : 'light');

/** The page's theme; re-renders on every change, embedded or standalone. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, current);
}

/** Whether cc's bridge owns the theme (the page is embedded in cc). */
export const isEmbedded = (): boolean => document.documentElement.hasAttribute('data-cc-theme');
