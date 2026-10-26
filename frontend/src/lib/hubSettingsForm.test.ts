import { describe, expect, it } from 'vitest';
import { hubSettingsDraftFor, hubSettingsPatch } from './hubSettingsForm';

describe('hubSettingsPatch', () => {
  // Invariant: an untouched draft saves nothing; a toggled one saves exactly the new value.
  it('is null when unchanged and carries the toggled value otherwise', () => {
    for (const bridgeFallback of [true, false]) {
      const current = { bridgeFallback };
      const draft = hubSettingsDraftFor(current);
      expect(hubSettingsPatch(draft, current)).toBeNull();
      expect(hubSettingsPatch({ bridgeFallback: !bridgeFallback }, current)).toEqual({ bridgeFallback: !bridgeFallback });
    }
  });
});
