// The app list's and cards' decisions, as pure functions of the listing.

import type { App, AppStatus, SortKey } from './types';

export const shortSha = (sha: string | null | undefined): string => (sha ? sha.slice(0, 7) : '');
export const statusWord = (s: AppStatus): string => (s === 'ready' ? 'running' : s);

export type StatusTone = 'success' | 'warning' | 'destructive' | 'muted';
export function statusTone(s: AppStatus): StatusTone {
  if (s === 'running' || s === 'ready') return 'success';
  if (s === 'starting') return 'warning';
  if (s === 'crashed') return 'destructive';
  return 'muted';
}

// "34m ago" style relative label; '' for null/unparseable.
export function relativeTime(iso: string | null | undefined, now: number): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.round(mo / 12)}y ago`;
}

function statusRank(s: AppStatus): number {
  if (s === 'running' || s === 'ready') return 0;
  if (s === 'starting') return 1;
  if (s === 'crashed') return 2;
  return 3;
}

const byName = (a: App, b: App) => (a.name || a.id).localeCompare(b.name || b.id);

export function sortApps(apps: App[], sort: SortKey): App[] {
  const list = [...apps];
  if (sort === 'name') list.sort(byName);
  else if (sort === 'status') list.sort((a, b) => statusRank(a.status) - statusRank(b.status) || byName(a, b));
  else list.sort((a, b) => {
    const ta = a.lastCommitAt ? Date.parse(a.lastCommitAt) : -Infinity;
    const tb = b.lastCommitAt ? Date.parse(b.lastCommitAt) : -Infinity;
    return tb - ta || byName(a, b);
  });
  return list;
}

export type AppGroup =
  | { kind: 'app'; app: App; worktrees: App[] }
  /** Worktrees whose main checkout isn't in the listing (no manifest source, not discovered). */
  | { kind: 'orphan'; project: string; worktrees: App[] };

// Worktrees nest under their parent project rather than showing as top-level
// cards. The sort applies to the top-level (main) cards only; orphan groups
// follow every main.
export function groupApps(apps: App[], sort: SortKey): AppGroup[] {
  const byProject = new Map<string, App[]>();
  for (const w of apps) {
    if (!w.isWorktree) continue;
    if (!byProject.has(w.project)) byProject.set(w.project, []);
    byProject.get(w.project)!.push(w);
  }
  for (const list of byProject.values()) list.sort((a, b) => (a.branch || a.id).localeCompare(b.branch || b.id));
  const groups: AppGroup[] = [];
  const seen = new Set<string>();
  for (const app of sortApps(apps.filter((a) => !a.isWorktree), sort)) {
    seen.add(app.project);
    groups.push({ kind: 'app', app, worktrees: byProject.get(app.project) ?? [] });
  }
  for (const [project, worktrees] of byProject) if (!seen.has(project)) groups.push({ kind: 'orphan', project, worktrees });
  return groups;
}

export interface Control {
  disabled: boolean;
}
export interface Controls {
  start: Control | null;
  stop: Control | null;
  restart: Control | null;
  share: (Control & { label: 'Share' | 'Shared' }) | null;
}

// Stop and Restart are absent on an always-on app (the host conductor). Share
// waits while the app is starting or an auto-share is running: the backend
// takes one share per app at a time, and the auto-share is about to be it.
export function controlsFor(app: App, busy: boolean): Controls {
  const running = app.status === 'starting' || app.status === 'ready' || app.status === 'running';
  if (!running) {
    return { start: { disabled: busy || !!app.manifestError || app.sourceMissing }, stop: null, restart: null, share: null };
  }
  return {
    start: null,
    stop: app.alwaysOn ? null : { disabled: busy },
    restart: app.alwaysOn ? null : { disabled: busy || app.sourceMissing },
    share: {
      label: app.tunnel ? 'Shared' : 'Share',
      disabled: busy || !!app.tunnel || app.status === 'starting' || app.autoShareStatus === 'pending',
    },
  };
}

export interface RouteRow {
  /** Shown only when the app has several routes. */
  name: string | null;
  path: string;
  primary: string | null;
  /** The route's further URLs (LAN addresses). */
  rest: string[];
}

export function routeRows(app: App): RouteRow[] | null {
  if ((app.status !== 'ready' && app.status !== 'running') || !app.routes?.length) return null;
  const single = app.routes.length === 1;
  return app.routes.map((r) => {
    const [primary = null, ...rest] = r.urls;
    return { name: single ? null : r.name, path: r.path, primary, rest };
  });
}

export type MetaKind = 'branch' | 'alwaysOn' | 'id' | 'sha' | 'outdated' | 'edited' | 'sourceMissing';
export interface MetaItem {
  kind: MetaKind;
  text: string;
  title?: string;
}

export function metaItems(app: App, now: number): MetaItem[] {
  const items: MetaItem[] = [];
  if (app.isWorktree && app.branch) items.push({ kind: 'branch', text: app.branch });
  if (app.alwaysOn) items.push({ kind: 'alwaysOn', text: 'always on' });
  if (app.id !== app.name) items.push({ kind: 'id', text: app.id });
  if (app.currentSha) items.push({ kind: 'sha', text: shortSha(app.currentSha) });
  if (app.outOfDate) items.push({ kind: 'outdated', text: 'outdated' });
  if (app.lastCommitAt) {
    items.push({ kind: 'edited', text: `edited ${relativeTime(app.lastCommitAt, now)}`, title: new Date(app.lastCommitAt).toLocaleString() });
  }
  if (app.sourceMissing) items.push({ kind: 'sourceMissing', text: 'source removed' });
  return items;
}

/** A card's accessible name. A worktree usually inherits its project's name, so it is told apart by branch (else id). */
export const cardLabel = (app: Pick<App, 'isWorktree' | 'name' | 'branch' | 'id'>): string =>
  (app.isWorktree ? `${app.name} — ${app.branch || app.id}` : app.name);

/** The card's notice for a failed boot auto-start, or null. */
export function autoStartNotice(app: Pick<App, 'autoStartError'>): string | null {
  return app.autoStartError ? `Auto-start failed: ${app.autoStartError}` : null;
}

export type ListState = 'loading' | 'error' | 'empty' | 'list';

// `loaded`: a listing has arrived at least once. `error`: the latest load failed.
export function listView({ loaded, error, apps }: { loaded: boolean; error: string | null; apps: App[] }): { state: ListState; stale: boolean } {
  if (!loaded) return { state: error ? 'error' : 'loading', stale: false };
  return { state: apps.length ? 'list' : 'empty', stale: !!error };
}
