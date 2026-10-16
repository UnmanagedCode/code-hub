import type * as React from 'react';
import { safeHref } from '@/lib/safeHref';

type Props = Omit<React.ComponentProps<'a'>, 'href' | 'target' | 'rel'> & {
  url: string;
  /** What a URL that is not absolute http(s) renders as: its text (default), or nothing. */
  fallback?: 'text' | 'none';
};

/** The one place a link is built from data: http(s) only, opened in a new tab without an opener. */
export function ExternalLink({ url, fallback = 'text', children, ...props }: Props) {
  const href = safeHref(url);
  if (!href) return fallback === 'text' ? <span className={props.className}>{url}</span> : null;
  return (
    <a {...props} href={href} target="_blank" rel="noopener noreferrer">
      {children ?? url}
    </a>
  );
}
