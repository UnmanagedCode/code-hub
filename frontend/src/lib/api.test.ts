import { afterEach, expect, it, vi } from 'vitest';
import { api, ApiError } from './api';

afterEach(() => vi.unstubAllGlobals());

// Invariant: requests go to the relative path as given; a root-relative path (which would reach cc) throws unsent.
it('sends relative paths and refuses root-relative ones', async () => {
  const fetchMock = vi.fn(async () => new Response('{"ok":true}'));
  vi.stubGlobal('fetch', fetchMock);
  await expect(api('api/apps')).resolves.toStrictEqual({ ok: true });
  expect(fetchMock).toHaveBeenCalledWith('api/apps', undefined);
  await expect(api('/api/apps')).rejects.toThrow(/root-relative/);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

// Invariant: a failure carries the status and the backend's {error, code}; a non-JSON body gives `HTTP <status>`.
it('errors carry status, message and code', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"unknown app \'x\'","code":"NOPE"}', { status: 404 })));
  const e = await api('api/apps/x/start').catch((x) => x);
  expect(e).toBeInstanceOf(ApiError);
  expect(e).toMatchObject({ status: 404, code: 'NOPE', message: "unknown app 'x'" });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>/home/secret/path</html>', { status: 502 })));
  const e2 = await api('api/apps').catch((x) => x);
  expect(e2).toMatchObject({ status: 502, code: undefined, message: 'HTTP 502' });
});
