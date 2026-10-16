import { describe, expect, it } from 'vitest';
import { applyCredSave, planCredSave, stepRequest, type SaveStep } from './shareSave';
import type { CredDraft, Tunnel } from './types';

const lanDraft = (over: Partial<CredDraft> = {}): CredDraft => ({ auth: true, tls: true, username: 'hub', password: 'pw', saveAsDefault: false, ...over });
const credDraft = (over: Partial<CredDraft> = {}): CredDraft => ({ username: 'hub', password: 'pw', saveAsDefault: false, ...over });
const LAN: Tunnel = { kind: 'lan', url: 'https://192.0.2.1:5001', auth: true, tls: true, username: 'hub', password: 'pw' };
const TUNNEL: Tunnel = { kind: 'tunnel', url: 'https://x.trycloudflare.com', auth: true, username: 'hub', password: 'pw' };

describe('planCredSave', () => {
  // Invariant: a TLS change re-shares (it can't flip in place) carrying the auth choice, then sends every
  // typed field — a fresh proxy has fresh creds, so "unchanged" means nothing — but only while auth is on.
  it('a TLS change re-shares, then sends all typed creds when auth is on', () => {
    expect(planCredSave(lanDraft({ tls: false }), LAN, 'lan')).toStrictEqual([
      { kind: 'reshare', body: { mode: 'lan', auth: true, tls: false } },
      { kind: 'creds', body: { username: 'hub', password: 'pw' } },
    ]);
    expect(planCredSave(lanDraft({ tls: false, auth: false }), LAN, 'lan')).toStrictEqual([
      { kind: 'reshare', body: { mode: 'lan', auth: false, tls: false } },
    ]);
    expect(planCredSave(lanDraft({ tls: false, username: '', password: '' }), LAN, 'lan')).toStrictEqual([
      { kind: 'reshare', body: { mode: 'lan', auth: true, tls: false } },
    ]);
  });

  // Invariant: on LAN an auth flip lands before any credentials PATCH (which 400s on an ungated share),
  // and the creds PATCH carries only what changed.
  it('a LAN auth flip comes before the creds PATCH, which carries only changes', () => {
    const off: Tunnel = { ...LAN, auth: false };
    expect(planCredSave(lanDraft({ password: 'new' }), off, 'lan')).toStrictEqual([
      { kind: 'auth', body: { enabled: true } },
      { kind: 'creds', body: { password: 'new' } },
    ]);
    expect(planCredSave(lanDraft(), off, 'lan')).toStrictEqual([{ kind: 'auth', body: { enabled: true } }]);
    expect(planCredSave(lanDraft({ username: 'alice' }), LAN, 'lan')).toStrictEqual([{ kind: 'creds', body: { username: 'alice' } }]);
    expect(planCredSave(lanDraft(), LAN, 'lan')).toStrictEqual([]);
  });

  // Invariant: turning LAN auth off sends no creds PATCH, so a ticked (then hidden) save-as-default writes nothing.
  it('LAN auth off sends no creds step, even with save-as-default ticked', () => {
    expect(planCredSave(lanDraft({ auth: false, password: 'new', saveAsDefault: true }), LAN, 'lan')).toStrictEqual([
      { kind: 'auth', body: { enabled: false } },
    ]);
  });

  // Invariant: tunnel and tailscale shares only ever PATCH creds, and only when something changed or the box is ticked.
  it('tunnel and tailscale send creds only when changed or ticked', () => {
    for (const kind of ['tunnel', 'tailscale'] as const) {
      const shared = { ...TUNNEL, kind };
      expect(planCredSave(credDraft(), shared, kind)).toStrictEqual([]);
      expect(planCredSave(credDraft({ username: 'bob' }), shared, kind)).toStrictEqual([{ kind: 'creds', body: { username: 'bob' } }]);
      expect(planCredSave(credDraft({ saveAsDefault: true }), shared, kind)).toStrictEqual([{ kind: 'creds', body: { saveAsDefault: true } }]);
    }
  });
});

// Invariant: each step maps to the endpoint and JSON body the backend expects, the id encoded as one path segment.
it('stepRequest: method, path and body per step, with the id encoded', () => {
  const id = 'app:ab12cd';
  expect(stepRequest(id, { kind: 'reshare', body: { mode: 'lan', auth: true, tls: false } })).toStrictEqual({
    method: 'POST', path: 'api/apps/app%3Aab12cd/share', body: { mode: 'lan', auth: true, tls: false },
  });
  expect(stepRequest(id, { kind: 'auth', body: { enabled: false } })).toStrictEqual({
    method: 'PATCH', path: 'api/apps/app%3Aab12cd/share/auth', body: { enabled: false },
  });
  expect(stepRequest(id, { kind: 'creds', body: { username: 'u', saveAsDefault: true } })).toStrictEqual({
    method: 'PATCH', path: 'api/apps/app%3Aab12cd/share/credentials', body: { username: 'u', saveAsDefault: true },
  });
});

describe('applyCredSave', () => {
  const recorder = (replies: Record<string, unknown>, failOn?: SaveStep['kind']) => {
    const calls: SaveStep['kind'][] = [];
    const call = async (step: SaveStep) => {
      calls.push(step.kind);
      if (step.kind === failOn) throw new Error(`${step.kind} failed`);
      return replies[step.kind];
    };
    return { calls, call };
  };

  // Invariant: steps run in order; a re-share response replaces the share state and later PATCHes merge into it.
  it('a re-share replaces the share, and the creds PATCH merges into the new one', async () => {
    const reshared = { kind: 'lan', url: 'http://192.0.2.1:5002', authUrl: 'http://192.0.2.1:5002/?__hubauth=N', qrSvg: '<svg>new</svg>', username: 'hub', password: 'gen' };
    const { calls, call } = recorder({ reshare: reshared, creds: { username: 'hub', password: 'typed', passwordIsDefault: false, qrSvg: '<svg>creds</svg>' } });
    const before = { ...LAN, authUrl: 'https://192.0.2.1:5001/?__hubauth=OLD', qrSvg: '<svg>old</svg>' };
    const { share, error } = await applyCredSave(
      [{ kind: 'reshare', body: { mode: 'lan', auth: true, tls: false } }, { kind: 'creds', body: { password: 'typed' } }], call, before);
    expect(error).toBe(null);
    expect(calls).toStrictEqual(['reshare', 'creds']);
    expect(share).toStrictEqual({ ...reshared, password: 'typed', passwordIsDefault: false, qrSvg: '<svg>creds</svg>' });
    expect(reshared.password).toBe('gen');
  });

  // Invariant: an auth-off PATCH drops the stale magic-link and swaps the QR, without mutating the input.
  it('an auth-off PATCH drops authUrl and swaps the QR; the input is not mutated', async () => {
    const before = { ...LAN, authUrl: 'https://192.0.2.1:5001/?__hubauth=T', qrSvg: '<svg>cred</svg>' };
    const snapshot = structuredClone(before);
    const { call } = recorder({ auth: { id: 'a', auth: false, qrSvg: '<svg>plain</svg>' } });
    const { share } = await applyCredSave([{ kind: 'auth', body: { enabled: false } }], call, before);
    expect(share).toMatchObject({ qrSvg: '<svg>plain</svg>' });
    expect(share && typeof share === 'object' && 'authUrl' in share).toBe(false);
    expect(before).toStrictEqual(snapshot);
  });

  // Invariant: with no share state on screen (a reload since sharing) the PATCHes still run and nothing is invented.
  it('no share state on screen: steps still run, the state stays absent', async () => {
    const { calls, call } = recorder({ auth: { auth: true, qrSvg: '<svg/>' }, creds: { username: 'x' } });
    const { share, error } = await applyCredSave([{ kind: 'auth', body: { enabled: true } }, { kind: 'creds', body: { username: 'x' } }], call, undefined);
    expect(calls).toStrictEqual(['auth', 'creds']);
    expect(share).toBe(undefined);
    expect(error).toBe(null);
  });

  // Invariant: a failing step stops the sequence and reports it, keeping what the earlier steps applied, so a
  // re-share that landed is not shadowed by the stale pre-edit response.
  it('a failure stops the sequence and keeps the earlier steps', async () => {
    const reshared = { kind: 'lan', url: 'http://192.0.2.1:5002', qrSvg: '<svg>new</svg>' };
    const { calls, call } = recorder({ reshare: reshared }, 'creds');
    const { share, error } = await applyCredSave(
      [{ kind: 'reshare', body: { mode: 'lan', auth: true, tls: false } }, { kind: 'creds', body: { password: 'x' } }, { kind: 'auth', body: { enabled: true } }],
      call, LAN);
    expect(calls).toStrictEqual(['reshare', 'creds']);
    expect(share).toStrictEqual(reshared);
    expect((error as Error).message).toBe('creds failed');
  });
});
