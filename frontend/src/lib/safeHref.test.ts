import { expect, it } from 'vitest';
import { safeHref } from './safeHref';

// Invariant: only absolute http(s) URLs become links.
it('allows absolute http and https URLs', () => {
  expect(safeHref('http://192.0.2.1:5000/')).toBe('http://192.0.2.1:5000/');
  expect(safeHref('https://x.trycloudflare.com/?__hubauth=T')).toBe('https://x.trycloudflare.com/?__hubauth=T');
});

// Invariant: script-bearing schemes, other schemes, and anything relative render as text.
it('refuses javascript:, data:, mailto:, relative, protocol-relative and garbage', () => {
  for (const u of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'data:text/html,<script>alert(1)</script>',
    'mailto:a@example.com', 'relative/x', '/root', '//evil.example/x', '', 'not a url', 'http//missing-colon']) {
    expect(safeHref(u), u).toBe(null);
  }
});
