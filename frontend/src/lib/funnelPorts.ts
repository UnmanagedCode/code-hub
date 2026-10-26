// What the share picker and the header show for the Tailscale Funnel ports, as
// pure functions of the listing's `funnelPorts`.

import type { FunnelPort } from './types';

export interface FunnelPortChoice {
  port: number;
  label: string;
  /** Why the port can't be picked now, or null when it can. */
  disabledReason: string | null;
}

/** The share picker's Funnel port row for `appId`. A port this app holds stays enabled: sharing on it re-shares. */
export function funnelPortChoices(funnelPorts: FunnelPort[], appId: string): FunnelPortChoice[] {
  return funnelPorts.map(({ port, holder }) => ({
    port,
    label: `:${port}`,
    disabledReason: holder !== null && holder !== appId ? `used by ${holder}` : null,
  }));
}

export interface FunnelOccupancy {
  used: number;
  total: number;
  /** `used/total`, e.g. `2/3`. */
  label: string;
  rows: { port: number; text: string }[];
}

/** The header badge's count and its per-port list. */
export function funnelOccupancy(funnelPorts: FunnelPort[]): FunnelOccupancy {
  const used = funnelPorts.filter((p) => p.holder !== null).length;
  return {
    used,
    total: funnelPorts.length,
    label: `${used}/${funnelPorts.length}`,
    rows: funnelPorts.map(({ port, holder }) => ({ port, text: `:${port} — ${holder ?? 'free'}` })),
  };
}
