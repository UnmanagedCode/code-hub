import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { AppsResponse } from './types';

export const POLL_MS = 2000;

export interface AppsFeed {
  /** The latest listing, kept through later failures. */
  data: AppsResponse | null;
  /** The latest load's failure, cleared by the next success. */
  error: string | null;
  updatedAt: Date | null;
  fetching: boolean;
  /** Load now. Waits out a load already in flight, so the result reflects everything done before the call. */
  refresh: () => Promise<void>;
}

// Polls `api/apps` (readiness and tunnel progress show up without a reload).
// A tick that finds a load in flight is skipped.
export function useApps(): AppsFeed {
  const [data, setData] = useState<AppsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [fetching, setFetching] = useState(false);
  const flight = useRef<Promise<void> | null>(null);

  const load = useCallback(() => {
    const p: Promise<void> = (async () => {
      setFetching(true);
      try {
        const next = await api<AppsResponse>('api/apps', { cache: 'no-store' });
        setData(next);
        setError(null);
        setUpdatedAt(new Date());
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })().finally(() => {
      if (flight.current !== p) return;
      flight.current = null;
      setFetching(false);
    });
    flight.current = p;
    return p;
  }, []);

  const refresh = useCallback(async () => {
    if (flight.current) await flight.current;
    await load();
  }, [load]);

  useEffect(() => {
    if (!flight.current) void load();
    const timer = setInterval(() => {
      if (!flight.current) void load();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  return { data, error, updatedAt, fetching, refresh };
}
