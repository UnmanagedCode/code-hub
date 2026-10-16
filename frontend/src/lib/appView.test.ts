import { describe, expect, it } from 'vitest';
import { controlsFor, groupApps, listView, metaItems, relativeTime, routeRows, shortSha, sortApps, statusTone, statusWord } from './appView';
import { app } from '@/test/fixtures';

const ids = (list: { id: string }[]) => list.map((a) => a.id);

describe('sortApps', () => {
  const a = app({ id: 'a', name: 'Zed', status: 'stopped', lastCommitAt: '2026-01-01T00:00:00Z' });
  const b = app({ id: 'b', name: 'alpha', status: 'crashed', lastCommitAt: null });
  const c = app({ id: 'c', name: 'Mid', status: 'ready', lastCommitAt: '2026-03-01T00:00:00Z' });
  const d = app({ id: 'd', name: 'beta', status: 'starting', lastCommitAt: '2026-03-01T00:00:00Z' });
  const e = app({ id: 'e', name: 'Able', status: 'running', lastCommitAt: null });

  // Invariant: Last edited is newest first, ties and missing dates by name, missing dates last.
  it('edited: newest first, nulls last, name breaks ties', () => {
    expect(ids(sortApps([a, b, c, d, e], 'edited'))).toStrictEqual(['d', 'c', 'a', 'e', 'b']);
  });
  // Invariant: Name sorts by display name.
  it('name: by display name', () => {
    expect(ids(sortApps([a, b, c, d, e], 'name'))).toStrictEqual(['e', 'b', 'd', 'c', 'a']);
  });
  // Invariant: Status ranks running/ready, starting, crashed, stopped; name within a rank.
  it('status: running/ready, starting, crashed, stopped; name within a rank', () => {
    expect(ids(sortApps([a, b, c, d, e], 'status'))).toStrictEqual(['e', 'c', 'd', 'b', 'a']);
  });
  // Invariant: sorting never reorders the caller's array.
  it('does not mutate its input', () => {
    const list = [a, b, c];
    sortApps(list, 'name');
    expect(ids(list)).toStrictEqual(['a', 'b', 'c']);
  });
});

describe('groupApps', () => {
  // Invariant: worktrees nest under their project's main card, ordered by branch (else id); the sort applies to
  // mains only; a project with worktrees but no main gets an orphan group after every main.
  it('nests worktrees, sorts mains only, appends orphans', () => {
    const apps = [
      app({ id: 'web', project: 'web', name: 'web', lastCommitAt: '2026-01-01T00:00:00Z' }),
      app({ id: 'api', project: 'api', name: 'api', lastCommitAt: '2026-02-01T00:00:00Z' }),
      app({ id: 'web:z', project: 'web', isWorktree: true, branch: 'zeta', lastCommitAt: '2026-09-01T00:00:00Z' }),
      app({ id: 'web:a', project: 'web', isWorktree: true, branch: 'alpha' }),
      app({ id: 'lost:k2', project: 'lost', isWorktree: true, branch: null }),
      app({ id: 'lost:k1', project: 'lost', isWorktree: true, branch: null }),
    ];
    const groups = groupApps(apps, 'edited');
    expect(groups.map((g) => (g.kind === 'app' ? g.app.id : `orphan:${g.project}`))).toStrictEqual(['api', 'web', 'orphan:lost']);
    expect(groups[0].worktrees).toStrictEqual([]);
    expect(ids(groups[1].worktrees)).toStrictEqual(['web:a', 'web:z']);
    expect(ids(groups[2].worktrees)).toStrictEqual(['lost:k1', 'lost:k2']);
    expect(groupApps(apps, 'name').map((g) => (g.kind === 'app' ? g.app.id : g.project))).toStrictEqual(['api', 'web', 'lost']);
  });
  it('an empty listing has no groups', () => {
    expect(groupApps([], 'edited')).toStrictEqual([]);
  });
});

describe('controlsFor', () => {
  // Invariant: a stopped (or crashed) app offers only Start, disabled while busy, with a manifest error, or with its source gone.
  it('stopped: Start only, with its disabling conditions', () => {
    expect(controlsFor(app({ status: 'stopped' }), false)).toStrictEqual({ start: { disabled: false }, stop: null, restart: null, share: null });
    expect(controlsFor(app({ status: 'crashed' }), false).start).toStrictEqual({ disabled: false });
    expect(controlsFor(app({ status: 'stopped' }), true).start).toStrictEqual({ disabled: true });
    expect(controlsFor(app({ status: 'stopped', manifestError: 'bad json' }), false).start).toStrictEqual({ disabled: true });
    expect(controlsFor(app({ status: 'stopped', sourceMissing: true }), false).start).toStrictEqual({ disabled: true });
  });
  // Invariant: a running app offers Stop, Restart and Share; Restart is off with the source gone; busy disables all.
  it('running: Stop, Restart, Share', () => {
    for (const status of ['starting', 'ready', 'running'] as const) {
      expect(controlsFor(app({ status }), false)).toStrictEqual({
        start: null, stop: { disabled: false }, restart: { disabled: false }, share: { label: 'Share', disabled: false },
      });
    }
    expect(controlsFor(app({ status: 'running', sourceMissing: true }), false).restart).toStrictEqual({ disabled: true });
    expect(controlsFor(app({ status: 'running' }), true)).toStrictEqual({
      start: null, stop: { disabled: true }, restart: { disabled: true }, share: { label: 'Share', disabled: true },
    });
  });
  // Invariant: an always-on app (the host conductor) can't be stopped or restarted from here, only shared.
  it('alwaysOn: Share only', () => {
    expect(controlsFor(app({ status: 'running', alwaysOn: true }), false)).toStrictEqual({
      start: null, stop: null, restart: null, share: { label: 'Share', disabled: false },
    });
  });
  // Invariant: a shared app's Share reads "Shared" and is disabled.
  it('shared: the Share control reads Shared and is disabled', () => {
    expect(controlsFor(app({ status: 'running', tunnel: { url: 'https://x' } }), false).share).toStrictEqual({ label: 'Shared', disabled: true });
  });
});

describe('routeRows', () => {
  const routes = [
    { name: 'Main', path: '/', urls: ['http://127.0.0.1:5000/', 'http://192.0.2.1:5000/'] },
    { name: 'Editor', path: '/editor.html', urls: ['http://127.0.0.1:5000/editor.html'] },
  ];
  // Invariant: routes show only while the app is ready or running.
  it('null unless ready or running', () => {
    for (const status of ['stopped', 'starting', 'crashed'] as const) expect(routeRows(app({ status, routes }))).toBe(null);
    expect(routeRows(app({ status: 'running', routes: [] }))).toBe(null);
  });
  // Invariant: each route splits into its primary URL and the rest; names show only when there are several.
  it('primary/rest split; a single route has no name', () => {
    expect(routeRows(app({ status: 'ready', routes }))).toStrictEqual([
      { name: 'Main', path: '/', primary: 'http://127.0.0.1:5000/', rest: ['http://192.0.2.1:5000/'] },
      { name: 'Editor', path: '/editor.html', primary: 'http://127.0.0.1:5000/editor.html', rest: [] },
    ]);
    expect(routeRows(app({ status: 'running', routes: [routes[0]] }))).toStrictEqual([
      { name: null, path: '/', primary: 'http://127.0.0.1:5000/', rest: ['http://192.0.2.1:5000/'] },
    ]);
    expect(routeRows(app({ status: 'running', routes: [{ name: 'x', path: '/', urls: [] }] }))).toStrictEqual([
      { name: null, path: '/', primary: null, rest: [] },
    ]);
  });
});

describe('metaItems', () => {
  const now = Date.parse('2026-05-01T12:00:00Z');
  // Invariant: the meta row lists, in order, branch (worktrees), always on, id (when it differs from the name),
  // short sha, outdated, the edited label with its absolute date, and source removed.
  it('every item, in order', () => {
    const items = metaItems(app({
      id: 'web:k', name: 'Web', isWorktree: true, branch: 'feat', alwaysOn: true, currentSha: '0123456789abcdef',
      outOfDate: true, lastCommitAt: '2026-05-01T11:00:00Z', sourceMissing: true,
    }), now);
    expect(items.map((i) => [i.kind, i.text])).toStrictEqual([
      ['branch', 'feat'], ['alwaysOn', 'always on'], ['id', 'web:k'], ['sha', '0123456'], ['outdated', 'outdated'],
      ['edited', 'edited 1h ago'], ['sourceMissing', 'source removed'],
    ]);
    expect(items.find((i) => i.kind === 'edited')?.title).toBe(new Date('2026-05-01T11:00:00Z').toLocaleString());
  });
  // Invariant: nothing is listed that the app does not carry; a main checkout shows no branch.
  it('omits what is absent', () => {
    expect(metaItems(app({ id: 'web', name: 'web', branch: 'main', isWorktree: false }), now)).toStrictEqual([]);
  });
});

// Invariant: the relative label rounds into s, m, h, d, mo and y at each unit's boundary, clamps the future to 0s,
// and is empty for a missing or unparseable date.
it('relativeTime: each unit boundary', () => {
  const now = Date.parse('2026-05-01T00:00:00Z');
  const ago = (sec: number) => relativeTime(new Date(now - sec * 1000).toISOString(), now);
  expect(ago(0)).toBe('0s ago');
  expect(ago(59)).toBe('59s ago');
  expect(ago(60)).toBe('1m ago');
  expect(ago(59 * 60)).toBe('59m ago');
  expect(ago(60 * 60)).toBe('1h ago');
  expect(ago(23 * 3600)).toBe('23h ago');
  expect(ago(24 * 3600)).toBe('1d ago');
  expect(ago(29 * 86400)).toBe('29d ago');
  expect(ago(30 * 86400)).toBe('1mo ago');
  expect(ago(11 * 30 * 86400)).toBe('11mo ago');
  expect(ago(12 * 30 * 86400)).toBe('1y ago');
  expect(ago(-60)).toBe('0s ago');
  expect(relativeTime(null, now)).toBe('');
  expect(relativeTime('not a date', now)).toBe('');
});

// Invariant: ready reads as running; every status maps to its tone.
it('statusWord and statusTone', () => {
  expect(statusWord('ready')).toBe('running');
  for (const s of ['running', 'starting', 'stopped', 'crashed'] as const) expect(statusWord(s)).toBe(s);
  expect(statusTone('ready')).toBe('success');
  expect(statusTone('running')).toBe('success');
  expect(statusTone('starting')).toBe('warning');
  expect(statusTone('crashed')).toBe('destructive');
  expect(statusTone('stopped')).toBe('muted');
});

it('shortSha: seven characters, empty for none', () => {
  expect(shortSha('0123456789')).toBe('0123456');
  expect(shortSha(null)).toBe('');
});

// Invariant: before any load the list is loading (or the first failure); after a load it shows the data, and a
// later failure marks it stale instead of hiding it.
it('listView: loading, error, empty, list and stale', () => {
  expect(listView({ loaded: false, error: null, apps: [] })).toStrictEqual({ state: 'loading', stale: false });
  expect(listView({ loaded: false, error: 'down', apps: [] })).toStrictEqual({ state: 'error', stale: false });
  expect(listView({ loaded: true, error: null, apps: [] })).toStrictEqual({ state: 'empty', stale: false });
  expect(listView({ loaded: true, error: null, apps: [app()] })).toStrictEqual({ state: 'list', stale: false });
  expect(listView({ loaded: true, error: 'down', apps: [app()] })).toStrictEqual({ state: 'list', stale: true });
  expect(listView({ loaded: true, error: 'down', apps: [] })).toStrictEqual({ state: 'empty', stale: true });
});
