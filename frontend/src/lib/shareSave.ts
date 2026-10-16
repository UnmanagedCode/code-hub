// The Edit form's Save, as data: which requests it makes, in which order, and
// how their responses fold into the share state. Pure apart from the `call`
// the executor is handed.

import { credPatchBody, mergeSharePatch, tlsChanging, type CredPatchBody } from './shareState';
import type { CredDraft, ShareKind, SharePatch, ShareState, Tunnel } from './types';

export type SaveStep =
  | { kind: 'reshare'; body: { mode: 'lan'; auth: boolean; tls: boolean } }
  | { kind: 'auth'; body: { enabled: boolean } }
  | { kind: 'creds'; body: CredPatchBody };

// A ticked save-as-default rides on each credentials step (credPatchBody adds
// the flag). Both LAN paths skip that step when auth is being turned off, which
// is what keeps a ticked-then-hidden checkbox from writing the default.
export function planCredSave(editing: CredDraft, shared: Tunnel, kind: ShareKind): SaveStep[] {
  const steps: SaveStep[] = [];
  const creds = (onlyChanged: boolean) => {
    const body = credPatchBody(editing, shared, { onlyChanged });
    if (body) steps.push({ kind: 'creds', body });
  };
  if (kind === 'lan' && tlsChanging(editing, shared)) {
    // TLS can't flip in place (scheme/URL/cert are fixed at proxy creation), so
    // re-share to swap it: a fresh proxy with a new URL/QR/token, and the app's
    // default login or else a generated password. share() applies the auth
    // choice itself, so there is no separate auth step. Then apply any creds
    // typed in this same edit (blank = keep the fresh proxy's).
    steps.push({ kind: 'reshare', body: { mode: 'lan', auth: !!editing.auth, tls: !!editing.tls } });
    if (editing.auth) creds(false);
  } else if (kind === 'lan') {
    // Auth first: the credentials PATCH 400s on a no-auth share, so an
    // auth-enabling toggle must land before it. Unchanged fields are skipped:
    // the proxy's credentials are stable across an auth toggle, so re-enabling
    // restores them untouched.
    if (editing.auth !== (shared.auth !== false)) steps.push({ kind: 'auth', body: { enabled: !!editing.auth } });
    if (editing.auth) creds(true);
  } else {
    creds(true);
  }
  return steps;
}

const PATHS: Record<SaveStep['kind'], [method: string, suffix: string]> = {
  reshare: ['POST', 'share'],
  auth: ['PATCH', 'share/auth'],
  creds: ['PATCH', 'share/credentials'],
};

export function stepRequest(id: string, step: SaveStep): { method: string; path: string; body: SaveStep['body'] } {
  const [method, suffix] = PATHS[step.kind];
  return { method, path: `api/apps/${encodeURIComponent(id)}/${suffix}`, body: step.body };
}

// Runs the steps in order through `call`, folding each response into a copy of
// `share`: a re-share response replaces it; a PATCH response merges into it
// (mergeSharePatch), so the QR and Open link track the edit rather than the
// stale pre-edit share response. Stops at the first failure and returns it
// with the state the completed steps produced.
export async function applyCredSave(
  steps: SaveStep[],
  call: (step: SaveStep) => Promise<unknown>,
  share: ShareState | undefined,
): Promise<{ share: ShareState | undefined; error: unknown }> {
  let cur = share && typeof share === 'object' ? { ...share } : share;
  for (const step of steps) {
    let res: unknown;
    try {
      res = await call(step);
    } catch (error) {
      return { share: cur, error };
    }
    if (step.kind === 'reshare') {
      cur = res as Tunnel;
    } else if (cur && typeof cur === 'object') {
      cur = { ...cur };
      mergeSharePatch(cur, res as SharePatch);
    }
  }
  return { share: cur, error: null };
}
