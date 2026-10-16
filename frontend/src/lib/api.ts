/** A failed request: the HTTP status plus the backend's `{error, code}` when its body carried them. */
export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/** A JSON request to this plugin's own backend. `path` is relative: a `/`-led path would reach cc's API. */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  if (path.startsWith('/')) throw new Error(`api('${path}'): root-relative, so it would reach cc, not this plugin`);
  const res = await fetch(path, init);
  if (!res.ok) {
    let body: { error?: unknown; code?: unknown } = {};
    try {
      body = (await res.json()) ?? {};
    } catch {
      // Not JSON: the status alone describes it.
    }
    const message = typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
    throw new ApiError(res.status, message, typeof body.code === 'string' ? body.code : undefined);
  }
  return (await res.json()) as T;
}
