import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useApps } from './useApps';
import { app, json, listing, stubFetch, type Call } from '@/test/fixtures';

// Every timer is faked, so any periodic load would fire when time advances; flush() lets pending responses land.
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const lists = (calls: Call[]) => calls.filter((c) => c.url === 'api/apps').length;
const waits = (calls: Call[], id: string) => calls.filter((c) => c.url === `api/apps/${encodeURIComponent(id)}/settled`).length;

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  act(() => { document.dispatchEvent(new Event('visibilitychange')); });
}
afterEach(() => { Reflect.deleteProperty(document, 'visibilityState'); });

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

// Invariant: the listing loads once on mount and never on a timer.
it('loads once on mount; ten minutes later it has sent no further request', async () => {
  const { calls } = stubFetch({ 'GET api/apps': listing([app({ id: 'web', status: 'running' })]) });
  const { result } = renderHook(() => useApps());
  await flush();
  expect(result.current.data?.apps[0].id).toBe('web');
  await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000); });
  expect(calls).toHaveLength(1);
});

// Invariant: returning to the tab reloads the listing; hiding it does not.
it('visibilitychange to visible loads once; to hidden, not at all', async () => {
  const { calls } = stubFetch({ 'GET api/apps': listing([]) });
  renderHook(() => useApps());
  await flush();
  setVisibility('hidden');
  await flush();
  expect(lists(calls)).toBe(1);
  setVisibility('visible');
  await flush();
  expect(lists(calls)).toBe(2);
});

// Invariant: an app shown mid-transition gets exactly one settle wait, then one reload; a reload still showing the
// same transition opens no second wait.
it('a starting app opens one settle wait, reloads once when it answers, and does not wait again', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const { routes, calls } = stubFetch({
    'GET api/apps': listing([app({ id: 'x:k', status: 'starting' })]),
    'GET api/apps/x%3Ak/settled': async () => { await gate; return json({ id: 'x:k', settled: true }); },
  });
  const { result } = renderHook(() => useApps());
  await flush();
  expect(waits(calls, 'x:k')).toBe(1);
  expect(lists(calls)).toBe(1);
  await act(async () => { await result.current.refresh(); }); // another listing of the same episode
  expect(waits(calls, 'x:k')).toBe(1);
  routes['GET api/apps'] = listing([app({ id: 'x:k', status: 'running' })]);
  release();
  await flush();
  expect(lists(calls)).toBe(3);
  expect(result.current.data?.apps[0].status).toBe('running');
  expect(waits(calls, 'x:k')).toBe(1);
});

// Invariant: a cut or failed settle wait degrades to one reload, never a loop.
it('a settle wait answering 502 still reloads once', async () => {
  const { calls } = stubFetch({
    'GET api/apps': listing([app({ id: 'web', status: 'running', autoShareStatus: 'pending' })]),
    'GET api/apps/web/settled': () => json({ error: 'bad gateway' }, 502),
  });
  renderHook(() => useApps());
  await flush();
  await flush();
  expect(waits(calls, 'web')).toBe(1);
  expect(lists(calls)).toBe(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(lists(calls)).toBe(2);
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
  await flush();
  expect(fn).toHaveBeenCalledTimes(1);
  expect(done).toBe(false);
  held.release();
  await act(async () => { await p; });
  expect(fn).toHaveBeenCalledTimes(2);
  expect(result.current.data?.apps[0].id).toBe('later-2');
});
