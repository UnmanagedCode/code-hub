// Which apps the listing shows mid-transition, and which settle waits to open
// for them. Pure: useApps does the I/O.

import type { App } from './types';

/** A start still settling: readiness not yet decided, or its auto-share still running. */
export function isTransitional(app: Pick<App, 'status' | 'autoShareStatus'>): boolean {
  return app.status === 'starting' || app.autoShareStatus === 'pending';
}

/**
 * The settle waits to open for a fresh listing: one per transitional app not already waited on. `waited` comes
 * back holding the ids still transitional (an episode is waited on once, however many listings show it) plus
 * those just opened; an id that settled leaves it, so its next transition opens a wait again.
 */
export function planSettleWaits(apps: Pick<App, 'id' | 'status' | 'autoShareStatus'>[], waited: ReadonlySet<string>): { open: string[]; waited: Set<string> } {
  const open: string[] = [];
  const next = new Set<string>();
  for (const app of apps) {
    if (!isTransitional(app)) continue;
    next.add(app.id);
    if (!waited.has(app.id)) open.push(app.id);
  }
  return { open, waited: next };
}
