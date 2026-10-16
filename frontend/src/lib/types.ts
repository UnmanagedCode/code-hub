// The shapes `GET api/apps` and the share endpoints answer with (src/appManager.js `list()`, `share()`,
// `updateShareCredentials()`, `setShareAuth()`); docs/protocol.md is the contract.

export type AppStatus = 'stopped' | 'starting' | 'ready' | 'running' | 'crashed';
export type ShareKind = 'lan' | 'tunnel' | 'tailscale';
export type SortKey = 'edited' | 'name' | 'status';

export interface Route {
  name: string;
  path: string;
  urls: string[];
}

/** A live share: `app.tunnel` from the listing, or the one-time `POST …/share` response. */
export interface Tunnel {
  url: string;
  kind?: ShareKind;
  urls?: string[] | null;
  proxyPort?: number | null;
  fixedPortFallback?: boolean;
  fixedPortHolder?: 'app' | 'other' | 'unknown' | null;
  auth?: boolean;
  tls?: boolean;
  username?: string | null;
  password?: string | null;
  passwordIsDefault?: boolean;
  authUrl?: string;
  qrSvg?: string;
}

export interface ShareDefaults {
  username: string | null;
  hasPassword: boolean;
}

export interface App {
  id: string;
  project: string;
  name: string;
  path?: string;
  isWorktree: boolean;
  branch: string | null;
  status: AppStatus;
  port?: number;
  urls?: string[];
  startedSha?: string;
  currentSha: string | null;
  lastCommitAt: string | null;
  outOfDate: boolean;
  sourceMissing: boolean;
  routes: Route[];
  shareDefaults: ShareDefaults | null;
  tunnel: Tunnel | null;
  error: string | null;
  manifestError: string | null;
  alwaysOn: boolean;
}

export interface AppsResponse {
  cloudflaredAvailable: boolean;
  tailscaleAvailable: boolean;
  apps: App[];
}

/** A credentials or auth PATCH response, folded into the share state by `mergeSharePatch`. */
export interface SharePatch {
  auth?: boolean;
  qrSvg?: string;
  username?: string | null;
  password?: string | null;
  passwordIsDefault?: boolean;
}

/** The UI's per-app share state: the mode picker, a share in flight, its failure, or the share response. */
export type ShareState = { choosing: true } | 'loading' | { error: string } | Tunnel;

/** An open Edit form. `auth`/`tls` exist only for a LAN share. */
export interface CredDraft {
  username: string;
  password: string;
  saveAsDefault: boolean;
  auth?: boolean;
  tls?: boolean;
}
