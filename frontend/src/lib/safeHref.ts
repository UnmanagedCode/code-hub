// The schemes a link built from data may open: an app's route and share URLs
// are always http(s).
const ALLOWED = new Set(['http:', 'https:']);

/**
 * `u` as an href when it is an absolute http(s) URL; null otherwise (render it as text).
 * Parsed with no base, so a relative or `//host` string is refused rather than resolved against the page.
 */
export function safeHref(u: string): string | null {
  try {
    const url = new URL(u);
    return ALLOWED.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
