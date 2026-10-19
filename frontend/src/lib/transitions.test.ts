import { expect, test } from 'vitest';
import { isTransitional, planSettleWaits } from './transitions';
import { app } from '@/test/fixtures';

test('isTransitional: starting, or an auto-share pending', () => {
  expect(isTransitional(app({ status: 'starting' }))).toBe(true);
  expect(isTransitional(app({ status: 'running', autoShareStatus: 'pending' }))).toBe(true);
  expect(isTransitional(app({ status: 'running', autoShareStatus: 'failed' }))).toBe(false);
  expect(isTransitional(app({ status: 'crashed' }))).toBe(false);
});

// Invariant: a transition episode opens exactly one wait, however many listings show it; once it settles the id
// leaves the waited set, so its next episode opens a wait again.
test('planSettleWaits: one wait per episode, re-armed once the app settles', () => {
  const starting = app({ id: 'a', status: 'starting' });
  const pending = app({ id: 'b', status: 'running', autoShareStatus: 'pending' });
  const idle = app({ id: 'c', status: 'running' });
  const first = planSettleWaits([starting, pending, idle], new Set());
  expect(first.open).toStrictEqual(['a', 'b']);
  expect([...first.waited].sort()).toStrictEqual(['a', 'b']);

  const again = planSettleWaits([starting, pending, idle], first.waited);
  expect(again.open).toStrictEqual([]);
  expect([...again.waited].sort()).toStrictEqual(['a', 'b']);

  const settled = planSettleWaits([app({ id: 'a', status: 'running' }), pending, idle], again.waited);
  expect(settled.open).toStrictEqual([]);
  expect([...settled.waited]).toStrictEqual(['b']);

  const next = planSettleWaits([starting], settled.waited);
  expect(next.open).toStrictEqual(['a']);
});
