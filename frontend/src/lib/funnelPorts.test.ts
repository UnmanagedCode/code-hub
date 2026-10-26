import { expect, test } from 'vitest';
import { funnelOccupancy, funnelPortChoices } from './funnelPorts';
import type { FunnelPort } from './types';

const PORTS: FunnelPort[] = [{ port: 443, holder: null }, { port: 8443, holder: 'me' }, { port: 10000, holder: 'web' }];

// Invariant: a port is a choice unless ANOTHER app holds it; the reason names that app.
test('funnelPortChoices: free and own ports are enabled, another app\'s is disabled naming it', () => {
  expect(funnelPortChoices(PORTS, 'me')).toStrictEqual([
    { port: 443, label: ':443', disabledReason: null },
    { port: 8443, label: ':8443', disabledReason: null },
    { port: 10000, label: ':10000', disabledReason: 'used by web' },
  ]);
});

// Invariant: the header counts held ports over all ports, and lists each port with its holder or "free".
test('funnelOccupancy: count and per-port rows', () => {
  const o = funnelOccupancy(PORTS);
  expect([o.used, o.total, o.label]).toStrictEqual([2, 3, '2/3']);
  expect(o.rows.map((r) => r.text)).toStrictEqual([':443 — free', ':8443 — me', ':10000 — web']);
  expect(funnelOccupancy(PORTS.map((p) => ({ ...p, holder: null }))).label).toBe('0/3');
});
