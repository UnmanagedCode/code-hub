import { useCallback, useRef, useState } from 'react';
import { readExpanded, serializeExpanded, toggled, withId, writeExpanded } from './cardExpansion';

function safeLocalStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Which cards are expanded, remembered in localStorage. Writes keep only ids in `listedIds`. */
export function useExpandedCards(listedIds: string[]) {
  const [expandedCards, setExpanded] = useState<ReadonlySet<string>>(() => readExpanded(safeLocalStorage(), console.warn));
  const listedRef = useRef(listedIds);
  listedRef.current = listedIds;
  const current = useRef(expandedCards);
  current.current = expandedCards;

  const commit = useCallback((next: ReadonlySet<string>) => {
    if (next === current.current) return;
    current.current = next;
    setExpanded(next);
    writeExpanded(safeLocalStorage(), serializeExpanded(next, listedRef.current), console.warn);
  }, []);
  const toggleCard = useCallback((id: string) => commit(toggled(current.current, id)), [commit]);
  const expandCard = useCallback((id: string) => commit(withId(current.current, id)), [commit]);
  return { expandedCards, toggleCard, expandCard };
}
