// The Hub settings dialog's draft and the PUT body it saves, as pure functions of
// the stored settings and the draft.

import type { HubSettings } from './types';

export interface HubSettingsDraft {
  bridgeFallback: boolean;
}

export type HubSettingsPatch = HubSettings;

export function hubSettingsDraftFor(s: HubSettings): HubSettingsDraft {
  return { bridgeFallback: s.bridgeFallback };
}

/** The body to PUT, or `null` when the draft changes nothing. */
export function hubSettingsPatch(draft: HubSettingsDraft, current: HubSettings): HubSettingsPatch | null {
  return draft.bridgeFallback === current.bridgeFallback ? null : { bridgeFallback: draft.bridgeFallback };
}
