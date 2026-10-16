// Each card's accent bar: a stable colour per app id, from a fixed class list,
// so no style attribute is ever built from data. The one place own code names
// palette colours (tests/frontend-theme.test.mjs exempts this file); the bar is
// decoration, so it need not follow the host theme.

export const ACCENTS = [
  'border-l-rose-400',
  'border-l-orange-400',
  'border-l-amber-400',
  'border-l-lime-400',
  'border-l-emerald-400',
  'border-l-teal-400',
  'border-l-sky-400',
  'border-l-indigo-400',
  'border-l-violet-400',
  'border-l-fuchsia-400',
] as const;

function hash(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}

export function accentClass(id: string): (typeof ACCENTS)[number] {
  return ACCENTS[hash(id) % ACCENTS.length];
}
