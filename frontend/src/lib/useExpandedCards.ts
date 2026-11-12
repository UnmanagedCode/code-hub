import { useCallback, useRef, useState } from 'react';
import { EXPANDED_CARDS_KEY, readExpanded, serializeExpanded, toggled, withId, writeExpanded } from './cardExpansion';

/** `window.localStorage`, or null (with a warning naming the key) when merely accessing it throws. */
function safeLocalStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch (e) {
    console.warn(`code-hub: cannot access localStorage for ${EXPANDED_CARDS_KEY}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** Which cards are expanded, remembered in localStorage. Writes keep only ids in `listedIds`. */
export function useExpandedCards(listedIds: string[]) {
  // Resolved once per mount so writes reuse it; dev StrictMode runs the initializer twice.
  const storage = useRef<Storage | null | undefined>(undefined);
  const [expandedCards, setExpanded] = useState<ReadonlySet<string>>(() => {
    storage.current = safeLocalStorage();
    return readExpanded(storage.current, console.warn);
  });
  const listedRef = useRef(listedIds);
  listedRef.current = listedIds;
  const current = useRef(expandedCards);
  current.current = expandedCards;

  const commit = useCallback((next: ReadonlySet<string>) => {
    if (next === current.current) return;
    current.current = next;
    setExpanded(next);
    writeExpanded(storage.current ?? null, serializeExpanded(next, listedRef.current), console.warn);
  }, []);
  const toggleCard = useCallback((id: string) => commit(toggled(current.current, id)), [commit]);
  const expandCard = useCallback((id: string) => commit(withId(current.current, id)), [commit]);
  return { expandedCards, toggleCard, expandCard };
}
