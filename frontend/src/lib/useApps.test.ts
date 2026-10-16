import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { POLL_MS, useApps } from './useApps';
import { app, json, listing, stubFetch } from '@/test/fixtures';

// Only the poll interval is faked; settle() lets pending responses land on a real macrotask (waitFor would
// poll with the faked setInterval and never re-check, since a hook changes no DOM).
beforeEach(() => { vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }); });
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

// Replies in order; the first reply is held until released.
function firstHeld() {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let n = 0;
  const reply = async () => {
    n += 1;
    if (n === 1) { await gate; return json(listing([app({ id: 'first' })])); }
    return json(listing([app({ id: `later-${n}` })]));
  };
  return { release, reply };
}

// Invariant: a poll tick that finds the previous load still in flight sends no second request.
it('skips ticks while a load is in flight', async () => {
  const held = firstHeld();
  const { fn } = stubFetch({ 'GET api/apps': held.reply });
  const { result } = renderHook(() => useApps());
  expect(fn).toHaveBeenCalledTimes(1);
  await act(async () => { vi.advanceTimersByTime(POLL_MS * 2); });
  expect(fn).toHaveBeenCalledTimes(1);
  held.release();
  await settle();
  expect(result.current.data?.apps[0].id).toBe('first');
  await act(async () => { vi.advanceTimersByTime(POLL_MS); });
  expect(fn).toHaveBeenCalledTimes(2);
});

// Invariant: refresh() waits out the load in flight and then loads afresh, resolving only once that newer
// listing is in — so a caller's refresh never resolves on a listing requested before it.
it('refresh waits out the load in flight, then loads afresh', async () => {
  const held = firstHeld();
  const { fn } = stubFetch({ 'GET api/apps': held.reply });
  const { result } = renderHook(() => useApps());
  let done = false;
  let p!: Promise<void>;
  act(() => { p = result.current.refresh().then(() => { done = true; }); });
  await settle();
  expect(fn).toHaveBeenCalledTimes(1);
  expect(done).toBe(false);
  held.release();
  await act(async () => { await p; });
  expect(fn).toHaveBeenCalledTimes(2);
  expect(result.current.data?.apps[0].id).toBe('later-2');
});

// Invariant: the listing refreshes every 2s, as docs/features.md states.
it('polls every 2 seconds', () => {
  expect(POLL_MS).toBe(2000);
});
