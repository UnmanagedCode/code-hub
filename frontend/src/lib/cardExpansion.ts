import type { SharePanelView } from '@/lib/shareState';

/** Ids of the expanded cards, as a JSON array. Collapsed is the default and is not stored. */
export const EXPANDED_CARDS_KEY = 'code-hub:expandedCards';

/** Lenient: string entries are kept, anything else is dropped and reported through `problem`. */
export function parseExpanded(raw: string | null): { ids: Set<string>; problem: string | null } {
  if (raw === null) return { ids: new Set(), problem: null };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (e) {
    return { ids: new Set(), problem: `not valid JSON (${e instanceof Error ? e.message : String(e)})` };
  }
  if (!Array.isArray(value)) return { ids: new Set(), problem: 'not an array' };
  const ids = new Set(value.filter((v): v is string => typeof v === 'string'));
  return { ids, problem: ids.size === value.length ? null : 'has non-string entries' };
}

/** The expanded ids that are still in the listing, sorted, as the stored JSON array. */
export function serializeExpanded(expanded: ReadonlySet<string>, listedIds: Iterable<string>): string {
  const listed = new Set(listedIds);
  return JSON.stringify([...expanded].filter((id) => listed.has(id)).sort());
}

export function toggled(set: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(set);
  if (!next.delete(id)) next.add(id);
  return next;
}

/** Returns `set` itself when it already has `id`. */
export function withId(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  return set.has(id) ? set : new Set(set).add(id);
}

/** Storage I/O that never throws; failures go to `warn` and leave the in-memory state in charge. */
export function readExpanded(storage: Pick<Storage, 'getItem'> | null, warn: (msg: string) => void): Set<string> {
  if (!storage) return new Set();
  let raw: string | null;
  try {
    raw = storage.getItem(EXPANDED_CARDS_KEY);
  } catch (e) {
    warn(`code-hub: cannot read ${EXPANDED_CARDS_KEY} from localStorage: ${e instanceof Error ? e.message : String(e)}`);
    return new Set();
  }
  const { ids, problem } = parseExpanded(raw);
  if (problem) warn(`code-hub: ${EXPANDED_CARDS_KEY} in localStorage is ${problem}`);
  return ids;
}

export function writeExpanded(storage: Pick<Storage, 'setItem'> | null, value: string, warn: (msg: string) => void): void {
  if (!storage) return;
  try {
    storage.setItem(EXPANDED_CARDS_KEY, value);
  } catch (e) {
    warn(`code-hub: cannot write ${EXPANDED_CARDS_KEY} to localStorage: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export type SharePlacement = 'summary' | 'body' | null;
export interface CardSections {
  toggle: boolean;
  routes: boolean;
  share: SharePlacement;
  worktrees: boolean;
}

/** Every visibility decision for one card. `expanded` is the stored expansion preference; the caller ANDs `toggle` into the Collapsible's `open`. */
export function cardSections(input: {
  expanded: boolean;
  hasRoutes: boolean;
  shareView: SharePanelView['view'];
  worktreeCount: number;
}): CardSections {
  const { expanded, hasRoutes, shareView, worktreeCount } = input;
  return {
    toggle: hasRoutes || shareView === 'active' || worktreeCount > 0,
    routes: expanded && hasRoutes,
    share: shareView === 'none' ? null : shareView === 'active' ? (expanded ? 'body' : null) : 'summary',
    worktrees: expanded && worktreeCount > 0,
  };
}
