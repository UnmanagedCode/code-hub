// App builders and a fetch stub for the component tests.
import { vi } from 'vitest';
import type { App, AppsResponse } from '@/lib/types';

export const app = (over: Partial<App> = {}): App => ({
  id: 'demo',
  project: over.id?.split(':')[0] ?? 'demo',
  name: over.id ?? 'demo',
  isWorktree: false,
  branch: null,
  status: 'stopped',
  currentSha: null,
  lastCommitAt: null,
  outOfDate: false,
  sourceMissing: false,
  routes: [],
  shareDefaults: null,
  tunnel: null,
  error: null,
  manifestError: null,
  alwaysOn: false,
  ...over,
});

export const listing = (apps: App[], over: Partial<AppsResponse> = {}): AppsResponse => ({
  cloudflaredAvailable: true,
  tailscaleAvailable: false,
  apps,
  ...over,
});

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export interface Call {
  method: string;
  url: string;
  body: unknown;
}
type Reply = unknown | ((call: Call) => Response | Promise<Response>);

/**
 * Stub fetch: `routes` maps `"<METHOD> <url>"` to a JSON body or a Response factory; unmatched → 404.
 * Returns every call made, with its parsed JSON body.
 */
export function stubFetch(routes: Record<string, Reply>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = { method: init?.method ?? 'GET', url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const reply = routes[`${call.method} ${call.url}`];
    if (reply === undefined) return json({ error: `no stub for ${call.method} ${call.url}` }, 404);
    return typeof reply === 'function' ? (reply as (c: Call) => Response)(call) : json(reply);
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls, routes };
}
