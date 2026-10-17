import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { planSettleWaits } from './transitions';
import type { AppsResponse } from './types';

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

// Loads `api/apps` on events only — no timer: on mount, on refresh() (each action, the toolbar's Refresh), and
// when the tab becomes visible again. A transition the listing shows mid-way (a start settling, an auto-share
// running) gets one settle wait — a long-poll the server answers once it is over — and one load after it.
export function useApps(): AppsFeed {
  const [data, setData] = useState<AppsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [fetching, setFetching] = useState(false);
  const flight = useRef<Promise<void> | null>(null);
  const waited = useRef<ReadonlySet<string>>(new Set());
  const mounted = useRef(true);

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
    mounted.current = true;
    if (!flight.current) void load();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      mounted.current = false;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load, refresh]);

  // A failed or cut wait still loads once: the wait only decides when.
  useEffect(() => {
    if (!data) return;
    const plan = planSettleWaits(data.apps, waited.current);
    waited.current = plan.waited;
    for (const id of plan.open) {
      void api(`api/apps/${encodeURIComponent(id)}/settled`, { cache: 'no-store' })
        .catch(() => {})
        .then(() => (mounted.current ? refresh() : undefined));
    }
  }, [data, refresh]);

  return { data, error, updatedAt, fetching, refresh };
}
