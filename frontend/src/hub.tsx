// App-level UI state and the actions that change it. Every map is keyed by app
// id (expansion by project), at this level so it survives polls, re-sorting
// and a collapsed worktree list.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { applyCredSave, planCredSave, stepRequest, type SaveStep } from '@/lib/shareSave';
import { credDraftFor, pruneDrafts } from '@/lib/shareState';
import { useApps, type AppsFeed } from '@/lib/useApps';
import type { CredDraft, ShareKind, ShareState, Tunnel } from '@/lib/types';

/** The control an app's in-flight action belongs to (its button shows the spinner). */
export type BusyAction = 'start' | 'stop' | 'restart' | 'unshare' | 'save';

export interface Hub extends AppsFeed {
  share: Record<string, ShareState>;
  credEdit: Record<string, CredDraft>;
  expanded: ReadonlySet<string>;
  busy: Record<string, BusyAction>;
  actionError: Record<string, string>;
  start: (id: string) => Promise<void>;
  stop: (id: string) => Promise<void>;
  restart: (id: string) => Promise<void>;
  chooseShare: (id: string) => void;
  cancelShare: (id: string) => void;
  doShare: (id: string, mode: ShareKind) => Promise<void>;
  unshare: (id: string) => Promise<void>;
  beginEdit: (id: string, shared: Tunnel, kind: ShareKind) => void;
  updateDraft: (id: string, patch: Partial<CredDraft>) => void;
  cancelEdit: (id: string) => void;
  saveEdit: (id: string, shared: Tunnel, kind: ShareKind) => Promise<void>;
  dismissError: (id: string) => void;
  toggleExpanded: (project: string) => void;
}

const HubContext = createContext<Hub | null>(null);

export function useHub(): Hub {
  const hub = useContext(HubContext);
  if (!hub) throw new Error('useHub outside HubProvider');
  return hub;
}

const omit = <T,>(m: Record<string, T>, id: string): Record<string, T> => {
  if (!(id in m)) return m;
  const next = { ...m };
  delete next[id];
  return next;
};
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const json = (method: string, body?: unknown): RequestInit =>
  body === undefined ? { method } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
const appPath = (id: string, suffix: string) => `api/apps/${encodeURIComponent(id)}/${suffix}`;

export function HubProvider({ children }: { children: ReactNode }) {
  const feed = useApps();
  const { data, refresh } = feed;
  const [share, setShare] = useState<Record<string, ShareState>>({});
  const [credEdit, setCredEdit] = useState<Record<string, CredDraft>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<Record<string, BusyAction>>({});
  const [actionError, setActionError] = useState<Record<string, string>>({});
  // The share state and drafts as of the last render, for Save to start from.
  const shareRef = useRef(share);
  shareRef.current = share;
  const credEditRef = useRef(credEdit);
  credEditRef.current = credEdit;

  useEffect(() => {
    if (!data) return;
    setCredEdit((drafts) => {
      const next = { ...drafts };
      pruneDrafts(next, data.apps);
      return Object.keys(next).length === Object.keys(drafts).length ? drafts : next;
    });
  }, [data]);

  const setShareFor = useCallback((id: string, s: ShareState | undefined) => {
    setShare((m) => (s === undefined ? omit(m, id) : { ...m, [id]: s }));
  }, []);
  const clearShare = useCallback((id: string) => {
    setShare((m) => omit(m, id));
    setCredEdit((m) => omit(m, id));
  }, []);

  // A failure shows inline on the app's card until its next action or a dismiss.
  // The card stays busy until the post-action listing is in: clearing it sooner
  // re-enables controls drawn from the pre-action listing (a second Stop on a
  // stopped app).
  const action = useCallback(async (id: string, kind: BusyAction, run: () => Promise<void>) => {
    setBusy((m) => ({ ...m, [id]: kind }));
    setActionError((m) => omit(m, id));
    try {
      await run();
    } catch (e) {
      setActionError((m) => ({ ...m, [id]: message(e) }));
    } finally {
      await refresh();
      setBusy((m) => omit(m, id));
    }
  }, [refresh]);

  const actions = useMemo(() => ({
    start: (id: string) => action(id, 'start', async () => {
      await api(appPath(id, 'start'), json('POST'));
    }),
    // Stop and Restart tear any share down server-side; clear it here too, or the
    // panel would keep showing the defunct URL until a re-share overwrites it.
    stop: (id: string) => action(id, 'stop', async () => {
      await api(appPath(id, 'stop'), json('POST'));
      clearShare(id);
    }),
    restart: (id: string) => action(id, 'restart', async () => {
      await api(appPath(id, 'restart'), json('POST'));
      clearShare(id);
    }),
    chooseShare: (id: string) => setShareFor(id, { choosing: true }),
    cancelShare: (id: string) => setShareFor(id, undefined),
    doShare: async (id: string, mode: ShareKind) => {
      setShareFor(id, 'loading');
      try {
        setShareFor(id, await api<Tunnel>(appPath(id, 'share'), json('POST', { mode })));
      } catch (e) {
        setShareFor(id, { error: message(e) });
      }
      await refresh();
    },
    unshare: (id: string) => action(id, 'unshare', async () => {
      await api(appPath(id, 'share'), json('DELETE'));
      clearShare(id);
    }),
    beginEdit: (id: string, shared: Tunnel, kind: ShareKind) => setCredEdit((m) => ({ ...m, [id]: credDraftFor(shared, kind) })),
    updateDraft: (id: string, patch: Partial<CredDraft>) =>
      setCredEdit((m) => (m[id] ? { ...m, [id]: { ...m[id], ...patch } } : m)),
    cancelEdit: (id: string) => setCredEdit((m) => omit(m, id)),
    saveEdit: (id: string, shared: Tunnel, kind: ShareKind) => action(id, 'save', async () => {
      const draft = credEditRef.current[id];
      if (!draft) return;
      const call = (step: SaveStep) => {
        const req = stepRequest(id, step);
        return api(req.path, json(req.method, req.body));
      };
      const result = await applyCredSave(planCredSave(draft, shared, kind), call, shareRef.current[id]);
      setShareFor(id, result.share);
      if (result.error) throw result.error;
      setCredEdit((m) => omit(m, id));
    }),
    dismissError: (id: string) => setActionError((m) => omit(m, id)),
    toggleExpanded: (project: string) => setExpanded((s) => {
      const next = new Set(s);
      if (!next.delete(project)) next.add(project);
      return next;
    }),
  }), [action, clearShare, refresh, setShareFor]);

  const hub: Hub = { ...feed, share, credEdit, expanded, busy, actionError, ...actions };
  return <HubContext.Provider value={hub}>{children}</HubContext.Provider>;
}
