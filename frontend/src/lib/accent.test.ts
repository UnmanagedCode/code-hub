import { expect, it } from 'vitest';
import { ACCENTS, accentClass } from './accent';

// Invariant: an id always gets the same accent, and it is always one of the fixed classes.
it('accentClass is deterministic and always a member of ACCENTS', () => {
  const ids = ['code-hub', 'code-hub:feat', 'a', '', 'x'.repeat(500), '<img src=x>'];
  for (const id of ids) {
    expect(ACCENTS).toContain(accentClass(id));
    expect(accentClass(id)).toBe(accentClass(id));
  }
});

// Invariant: the hash spreads ids over the palette instead of collapsing onto one class.
it('accentClass spreads ids across the palette', () => {
  const seen = new Set(Array.from({ length: 200 }, (_, i) => accentClass(`app-${i}`)));
  expect(seen.size).toBe(ACCENTS.length);
});
