import { describe, expect, it, vi } from 'vitest';
import {
  EXPANDED_CARDS_KEY, cardSections, parseExpanded, readExpanded, serializeExpanded, toggled, withId, writeExpanded,
} from './cardExpansion';

describe('parseExpanded', () => {
  // Invariant: missing data is the default (nothing expanded), not a problem.
  it('null is empty with no problem', () => {
    expect(parseExpanded(null)).toStrictEqual({ ids: new Set(), problem: null });
  });
  // Invariant: a valid array of ids is read as is.
  it('reads an array of ids', () => {
    expect(parseExpanded('["a","b"]')).toStrictEqual({ ids: new Set(['a', 'b']), problem: null });
  });
  // Invariant: data that is not an array of ids reads as empty and reports a problem.
  it.each(['{bad', '{}', '"a"', '3'])('%s is empty with a problem', (raw) => {
    const r = parseExpanded(raw);
    expect(r.ids.size).toBe(0);
    expect(r.problem).toBeTruthy();
  });
  // Invariant: string entries survive a mixed array, and the rest is reported.
  it('keeps the string entries of a mixed array and reports the rest', () => {
    const r = parseExpanded('["a",1,null]');
    expect(r.ids).toStrictEqual(new Set(['a']));
    expect(r.problem).toBeTruthy();
  });
});

describe('serializeExpanded', () => {
  // Invariant: only ids in the listing are stored, sorted, and the result reads back unchanged.
  it('drops ids outside the listing, sorts, and round-trips', () => {
    const out = serializeExpanded(new Set(['b', 'gone', 'a']), ['a', 'b', 'c']);
    expect(out).toBe('["a","b"]');
    expect(parseExpanded(out).ids).toStrictEqual(new Set(['a', 'b']));
  });
});

describe('toggled / withId', () => {
  // Invariant: toggled adds a missing id and removes a present one, without mutating its input.
  it('toggled adds and removes', () => {
    const s = new Set(['a']);
    expect(toggled(s, 'b')).toStrictEqual(new Set(['a', 'b']));
    expect(toggled(s, 'a')).toStrictEqual(new Set());
    expect(s).toStrictEqual(new Set(['a']));
  });
  // Invariant: withId returns the same set when nothing changes, so no write or render follows.
  it('withId keeps the reference when the id is present', () => {
    const s = new Set(['a']);
    expect(withId(s, 'a')).toBe(s);
    expect(withId(s, 'b')).toStrictEqual(new Set(['a', 'b']));
  });
});

describe('readExpanded / writeExpanded', () => {
  // Invariant: a storage that throws on read warns once and reads as empty.
  it('a throwing getItem warns once and reads empty', () => {
    const warn = vi.fn();
    const storage = { getItem: () => { throw new Error('denied'); } };
    expect(readExpanded(storage, warn).size).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });
  // Invariant: a storage that throws on write warns once and does not throw.
  it('a throwing setItem warns once and does not throw', () => {
    const warn = vi.fn();
    writeExpanded({ setItem: () => { throw new Error('quota'); } }, '[]', warn);
    expect(warn).toHaveBeenCalledTimes(1);
  });
  // Invariant: no storage at all is a silent in-memory mode.
  it('a null storage reads empty and writes nothing, without a warning', () => {
    const warn = vi.fn();
    expect(readExpanded(null, warn).size).toBe(0);
    writeExpanded(null, '[]', warn);
    expect(warn).not.toHaveBeenCalled();
  });
  // Invariant: corrupt stored data warns with a message naming the key.
  it('corrupt data warns naming the key', () => {
    const warn = vi.fn();
    expect(readExpanded({ getItem: () => '{bad' }, warn).size).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(EXPANDED_CARDS_KEY);
  });
  // Invariant: a write lands under the key and reads back.
  it('writes under the key', () => {
    const store = new Map<string, string>();
    writeExpanded({ setItem: (k, v) => void store.set(k, v) }, '["a"]', vi.fn());
    expect(readExpanded({ getItem: (k) => store.get(k) ?? null }, vi.fn())).toStrictEqual(new Set(['a']));
  });
});

describe('cardSections', () => {
  const base = { expanded: false, hasRoutes: false, shareView: 'none' as const, worktreeCount: 0 };
  // Invariant: with nothing to reveal there is no toggle and no section.
  it('a stopped card with no worktrees has no toggle and nothing', () => {
    expect(cardSections(base)).toStrictEqual({ toggle: false, routes: false, share: null, worktrees: false });
  });
  // Invariant: routes are body content: the toggle shows when collapsed, the list only when expanded.
  it('routes show only when expanded', () => {
    expect(cardSections({ ...base, hasRoutes: true })).toMatchObject({ toggle: true, routes: false });
    expect(cardSections({ ...base, hasRoutes: true, expanded: true })).toMatchObject({ toggle: true, routes: true });
  });
  // Invariant: worktrees alone give a toggle, and the list shows only when expanded.
  it('worktrees show only when expanded', () => {
    expect(cardSections({ ...base, worktreeCount: 2 })).toMatchObject({ toggle: true, worktrees: false });
    expect(cardSections({ ...base, worktreeCount: 2, expanded: true })).toMatchObject({ toggle: true, worktrees: true });
  });
  // Invariant: a live share panel is body content and always gives a toggle.
  it('an active share is in the body when expanded, hidden when collapsed', () => {
    expect(cardSections({ ...base, shareView: 'active' })).toMatchObject({ toggle: true, share: null });
    expect(cardSections({ ...base, shareView: 'active', expanded: true })).toMatchObject({ toggle: true, share: 'body' });
  });
  // Invariant: transient share views show in the summary in both states.
  it.each(['choosing', 'loading', 'error', 'autoPending', 'autoFailed'] as const)('%s is in the summary either way', (shareView) => {
    expect(cardSections({ ...base, shareView }).share).toBe('summary');
    expect(cardSections({ ...base, shareView, expanded: true }).share).toBe('summary');
  });
  // Invariant: a stored-expanded card whose body is empty shows nothing and offers no toggle.
  it('expanded with an empty body has no toggle and nothing', () => {
    expect(cardSections({ ...base, expanded: true })).toStrictEqual({ toggle: false, routes: false, share: null, worktrees: false });
  });
});
