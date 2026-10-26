// Pure helpers for the share panel's state resolution, so the fallback ordering
// and the auth-off merge are unit-testable without rendering. No dependencies,
// no DOM access.

import type { App, AppSettings, CredDraft, ShareKind, SharePatch, ShareState, Tunnel } from './types';

// The panel draws from two sources: `s` = the UI's share state for the app (the
// one-time share() response, in-memory only — wiped on a full UI refresh) and
// `shared` = app.tunnel (the persisted tunnelInfo from list(), rebuilt live
// from the proxy). Right after sharing or a PATCH, `s` is the freshest; after a
// full UI refresh `s` is gone and `shared` carries the QR + magic-link instead.

type MaybeShare = ShareState | Partial<Tunnel> | null | undefined;
const field = <K extends keyof Tunnel>(s: MaybeShare, key: K): Tunnel[K] | undefined =>
  s && typeof s === 'object' ? (s as Partial<Tunnel>)[key] : undefined;

// Resolve the Open link URL. Prefer the in-memory magic-link, then the
// persisted one, then the plain share URL. A no-auth share has no authUrl
// anywhere, so it lands on the plain URL. Returns null only if shared is null.
export function resolveOpenUrl(s: MaybeShare, shared: Partial<Tunnel> | null | undefined): string | null {
  return field(s, 'authUrl') || (shared && shared.authUrl) || (shared && shared.url) || null;
}

// Resolve the QR SVG. Prefer the in-memory copy (freshest right after a share
// or a PATCH merged in), then the persisted tunnelInfo's (served by list(),
// which survives a full UI refresh). Returns null if neither has one.
export function resolveQrSvg(s: MaybeShare, shared: Partial<Tunnel> | null | undefined): string | null {
  return field(s, 'qrSvg') || (shared && shared.qrSvg) || null;
}

// Fold a credentials/auth PATCH response into the in-memory share state so the
// rendered QR/creds track the edit instead of the stale pre-edit share
// response — whose s.qrSvg/s.authUrl would otherwise shadow the fresh values
// list() serves (see resolveQrSvg/resolveOpenUrl's `s`-first ordering).
//
// Also drop s.authUrl when the gate turned off: the auth PATCH response
// carries no authUrl, so without this the stale magic-link keeps winning at
// resolveOpenUrl, leaking the ?__hubauth token into upstream request URLs once
// the proxy is ungated (it forwards req.url verbatim) and re-minting it as a
// live credential on a later re-gate. A from-the-start auth:false share has no
// s.authUrl to delete, so it's unaffected.
//
// `cur` is the app's share state — may be null/undefined if nothing's on
// screen. Mutates `cur`; callers holding React state pass a copy.
export function mergeSharePatch(cur: unknown, patched: SharePatch): void {
  if (!cur || typeof cur !== 'object') return;
  const t = cur as Partial<Tunnel>;
  if ('qrSvg' in patched) t.qrSvg = patched.qrSvg;
  if ('username' in patched) t.username = patched.username;
  if ('password' in patched) t.password = patched.password;
  if ('passwordIsDefault' in patched) t.passwordIsDefault = patched.passwordIsDefault;
  if (patched.auth === false) delete t.authUrl;
}

export interface FixedPortNotice {
  level: 'warn' | 'note';
  text: string;
}

// Resolve the fixed-port fallback notice for a LAN share, or null when there's
// nothing to say. Returns { level, text }: `level` is 'warn' whenever the app
// might be reachable on the LAN with no gate, and 'note' only when code-hub
// established it isn't.
//
// The three holder cases are deliberately NOT symmetric:
//   'app'     a wildcard hold was measured. Almost certainly this app — but
//             `share()` only knows the start command's wrapper process is
//             alive, not that the app's own listener is still up, so a
//             reloader's restart window could let something else hold the
//             wildcard. Warn loudly, phrased so it doesn't overclaim.
//   'unknown' the probe could not run (hosts without loopback aliases — macOS,
//             Windows — fail it for every port). This MUST warn: staying quiet
//             here would hide a real ungated exposure, which is the worse
//             direction to be wrong in. It still doesn't assert the app IS
//             exposed, only what follows if it binds all interfaces.
//   'other'   the port is positively not wildcard-held, so this app is not
//             what answers on the LAN there. Nothing to warn about.
export function resolveFixedPortNotice(app: Pick<App, 'port'> | null | undefined, shared: Partial<Tunnel> | null | undefined): FixedPortNotice | null {
  if (!shared || shared.kind !== 'lan' || !shared.fixedPortFallback) return null;
  const fixed = app && app.port;
  const actual = shared.proxyPort;
  const exposure = `it is already reachable on the LAN at port ${fixed} with NO authentication.`;
  if (shared.fixedPortHolder === 'other') {
    return {
      level: 'note',
      text: `Fixed port ${fixed} is held on the LAN by another process, not by this app, so this gated share is on port ${actual}.`,
    };
  }
  if (shared.fixedPortHolder === 'app') {
    return {
      level: 'warn',
      text: `⚠ Fixed port ${fixed} is held on every interface, so this gated share is on port ${actual} instead. That is almost certainly this app — in which case ${exposure}`,
    };
  }
  return {
    level: 'warn',
    text: `⚠ Fixed port ${fixed} could not be bound on the LAN and code-hub could not identify what holds it, so this gated share is on port ${actual}. If this app binds all interfaces, ${exposure}`,
  };
}

export interface ReachNotice {
  level: 'warn' | 'note';
  text: string;
}

const CONTAINER_INTERNAL = "These addresses are internal to code-hub's container, so other devices on your LAN can't reach them — run the code-hub host relay, or share via cloudflared or tailscale.";

// Resolve how a LAN share is reachable from the host's LAN when code-hub runs
// in a container, or null when there's nothing to say (no relay configured and
// not a bridge-only container, or not a LAN share). `level` is 'warn' whenever
// the shown addresses may not reach the LAN.
export function resolveLanReachNotice(shared: Partial<Tunnel> | null | undefined): ReachNotice | null {
  if (!shared || shared.kind !== 'lan') return null;
  const relay = shared.relay;
  const container = shared.containerInternal ? ` ${CONTAINER_INTERNAL}` : '';
  if (relay?.state === 'up') {
    const fallback = relay.portFallback ? ` Port ${relay.requestedPort} was busy on the host, so it is on port ${relay.port} there.` : '';
    return { level: 'note', text: `Exposed on the host's LAN through the code-hub relay.${fallback}` };
  }
  if (relay?.state === 'down') {
    const why = relay.error ? ` (${relay.error})` : '';
    if (relay.recovery === 'binding') return { level: 'warn', text: `⚠ The host relay hasn't confirmed this share's port yet.${container}` };
    if (relay.recovery === 'relay-file') return { level: 'warn', text: `⚠ The host relay can't be used${why}; code-hub waits for the relay's host.json to change.${container}` };
    return { level: 'warn', text: `⚠ The host relay isn't connected${why}; code-hub keeps retrying.${container}` };
  }
  if (relay?.state === 'failed') return { level: 'warn', text: `⚠ Host exposure failed: ${relay.error}.${container}` };
  if (shared.containerInternal) return { level: 'warn', text: `⚠ ${CONTAINER_INTERNAL}` };
  return null;
}

// Whether a QR helps: not while the share's addresses are container-internal
// and the relay isn't carrying it — a phone scanning it would reach nothing.
// Open and Copy stay, for a browser on the same machine.
export function qrUseful(shared: Partial<Tunnel> | null | undefined): boolean {
  return !(shared?.containerInternal && shared.relay?.state !== 'up');
}

// Resolve the share panel's mode/credentials note — the one line under the URL
// saying how this share is reachable.
//
// `kind` drives the split, NOT "is it LAN": a tailscale share is public like a
// tunnel but is NOT a cloudflared tunnel, and calling it one would misdescribe
// where TLS terminates and how stable the URL is. Anything unrecognised falls
// through to the tunnel wording, which is the default for a share without a kind.
export function resolveCredNote(shared: Partial<Tunnel>): string {
  const kind = (shared && shared.kind) || 'tunnel';
  if (kind === 'tailscale') return 'via Tailscale Funnel — public URL';
  if (kind !== 'lan') return 'via public tunnel';
  const authEnabled = shared.auth !== false;
  const lanTls = String(shared.url).startsWith('https:');
  if (!authEnabled && lanTls) return 'via LAN (HTTPS, self-signed — your browser warns on first visit), no authentication — anyone on the network can reach this app';
  if (!authEnabled) return 'via LAN, no authentication — anyone on the network can reach this app';
  if (lanTls) return 'via LAN (HTTPS, self-signed — your browser warns on first visit)';
  return 'via LAN (plain HTTP — credentials are not encrypted in transit)';
}

// Masking an app's DEFAULT share password. `passwordIsDefault` (from the server)
// marks a live share whose password is the app's stored default (seeded from
// it); generated and share-time-edited passwords stay plaintext. The mask is
// a fixed width so it doesn't reveal the length. The real value stays in
// `shared.password` for Copy, but is never put into an <input> — the edit
// drafts below start blank instead, and blank means keep.
// Masking guards against shoulder-surfing only: list() still serves the real
// password to the browser while the share is live.
export const PASSWORD_MASK = '••••••••';

// The share panel's `pass` row: what it shows, and what its Copy writes.
export function credRowValues(shared: Partial<Tunnel>): { display: string | null | undefined; copy: string | null | undefined } {
  return { display: shared.passwordIsDefault ? PASSWORD_MASK : shared.password, copy: shared.password };
}

// Drop edit drafts whose app is no longer in the listing — e.g. a removed
// worktree — so a form that can never be saved or cancelled doesn't linger and
// reappear if the id comes back. Mutates `drafts`; callers holding React state
// pass a copy.
export function pruneDrafts(drafts: Record<string, unknown>, apps: Pick<App, 'id'>[]): void {
  const ids = new Set(apps.map((a) => a.id));
  for (const id of Object.keys(drafts)) if (!ids.has(id)) delete drafts[id];
}

// The Edit form's initial draft for a live share. `kind` 'lan' also carries the
// auth/TLS toggles, which only a LAN share has.
export function credDraftFor(shared: Partial<Tunnel>, kind: ShareKind): CredDraft {
  const creds = {
    username: shared.username ?? '',
    password: shared.passwordIsDefault ? '' : (shared.password ?? ''),
  };
  return kind === 'lan' ? { auth: shared.auth !== false, tls: shared.tls !== false, ...creds } : creds;
}

// Whether the Edit form shows the user/pass fields: always for an
// always-gated share, for LAN only while auth is on.
export function credFieldsShown(editing: Pick<CredDraft, 'auth'>, kind: ShareKind): boolean {
  return kind !== 'lan' || !!editing.auth;
}

export function credPasswordPlaceholder(editing: Pick<CredDraft, 'password'>, shared: Partial<Tunnel>): string {
  if (shared.passwordIsDefault && !editing.password) return `${PASSWORD_MASK} (default — type to replace)`;
  return editing.password ? '' : 'leave blank to keep current';
}

export interface CredPatchBody {
  username?: string;
  password?: string;
}

// A credentials PATCH body from an Edit draft, or null when there's nothing to
// send. Blank fields mean "keep"; `onlyChanged` also drops a field equal to
// the live value (an in-place edit), whereas a fresh re-share sends every
// typed field.
export function credPatchBody(editing: CredDraft, shared: Partial<Tunnel>, { onlyChanged }: { onlyChanged: boolean }): CredPatchBody | null {
  const body: CredPatchBody = {};
  for (const key of ['username', 'password'] as const) {
    const v = editing[key];
    if (!v) continue;
    if (onlyChanged && v === (shared[key] ?? '')) continue;
    body[key] = v;
  }
  return Object.keys(body).length ? body : null;
}

// The Edit form's note when a LAN share's TLS toggle is about to change: that
// re-shares, and a re-share starts from the app's default login if it has one.
// `settings` is app.settings; keyed on a stored default PASSWORD, since with
// only a default username the password still resets to a random one.
export function resolveTlsReshareNote(auth: boolean | undefined, settings: Pick<AppSettings, 'hasPassword'> | null | undefined): string {
  if (!auth) return 'Changing TLS re-shares the app — new link & QR.';
  if (settings?.hasPassword) return "Changing TLS re-shares the app — new link & QR, and the login resets to this app's default (type below to override).";
  return 'Changing TLS re-shares the app — new link & QR, and the password resets (set one below to keep it).';
}

// Whether Save would flip a LAN share's TLS. TLS can't flip on a live proxy, so
// this is what makes Save re-share. Only a LAN draft carries `tls`.
export function tlsChanging(editing: CredDraft, shared: Partial<Tunnel>): boolean {
  return typeof editing.tls === 'boolean' && editing.tls !== (shared.tls !== false);
}

export interface ShareMode {
  mode: ShareKind;
  label: string;
  /** Why the mode can't be picked now, or null when it can. */
  disabledReason: string | null;
}

// The share picker's modes in order. LAN needs nothing installed.
export function shareModes(cloudflaredAvailable: boolean, tailscaleAvailable: boolean): ShareMode[] {
  return [
    { mode: 'lan', label: 'LAN', disabledReason: null },
    { mode: 'tunnel', label: 'cloudflared', disabledReason: cloudflaredAvailable ? null : 'cloudflared not installed' },
    { mode: 'tailscale', label: 'tailscale', disabledReason: tailscaleAvailable ? null : 'tailscale not available' },
  ];
}

export type SharePanelView =
  | { view: 'choosing' }
  | { view: 'loading' }
  | { view: 'error'; error: string }
  /** An auto-share is running for this app's latest start. */
  | { view: 'autoPending' }
  /** The auto-share after its latest start failed, and no share has replaced it. */
  | { view: 'autoFailed'; error: string }
  | { view: 'none' }
  | {
      view: 'active';
      shared: Tunnel;
      kind: ShareKind;
      openUrl: string;
      qrSvg: string | null;
      credNote: string;
      fixedPortNotice: FixedPortNotice | null;
      reachNotice: ReachNotice | null;
      /** The share's further URLs (the other LAN addresses), past the one shown. */
      extraUrls: string[];
      /** Whether the creds area shows: the Edit form while editing, else the user/pass rows. */
      showCreds: boolean;
      /** Whether Edit is offered: on any LAN share (it is how auth is turned back on), else only with creds. */
      canEdit: boolean;
    };

// What the share panel shows, in precedence order: the mode picker, a share in
// flight, a failed share (over a live app.tunnel too, so the failure is seen),
// the live share, an auto-share in flight, a failed auto-share, or nothing.
// `editing` is whether the app's Edit form is open.
export function sharePanelView(s: ShareState | undefined, app: Pick<App, 'tunnel' | 'port' | 'autoShareStatus' | 'autoShareError'>, editing: boolean): SharePanelView {
  if (s && typeof s === 'object' && 'choosing' in s) return { view: 'choosing' };
  if (s === 'loading') return { view: 'loading' };
  const shared = app.tunnel || (s && typeof s === 'object' && 'url' in s && s.url ? s : null);
  if (s && typeof s === 'object' && 'error' in s && s.error) return { view: 'error', error: s.error };
  if (!shared) {
    if (app.autoShareStatus === 'pending') return { view: 'autoPending' };
    if (app.autoShareStatus === 'failed') return { view: 'autoFailed', error: app.autoShareError ?? 'auto-share failed' };
    return { view: 'none' };
  }
  const kind = shared.kind || 'tunnel';
  const hasCreds = shared.auth !== false && !!shared.username && !!shared.password;
  return {
    view: 'active',
    shared,
    kind,
    openUrl: resolveOpenUrl(s, shared) as string,
    qrSvg: qrUseful(shared) ? resolveQrSvg(s, shared) : null,
    credNote: resolveCredNote(shared),
    fixedPortNotice: resolveFixedPortNotice(app, shared),
    reachNotice: resolveLanReachNotice(shared),
    extraUrls: shared.urls && shared.urls.length > 1 ? shared.urls.slice(1) : [],
    showCreds: editing || hasCreds,
    canEdit: kind === 'lan' || hasCreds,
  };
}

// The QR as an <img> source: a data: URL of the server's SVG, which an <img>
// renders without running any script it carries. Anything that is not an SVG
// document yields null, and no QR is shown.
export function qrImageSrc(svg: unknown): string | null {
  if (typeof svg !== 'string' || !svg.trimStart().startsWith('<svg')) return null;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
