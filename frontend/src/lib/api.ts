import { useAuthStore } from './auth';

// Where the API lives. Empty in production: the Pages site forwards /api and /auth to the Worker,
// so requests go to the page's own origin. `next dev` uses .env.development (localhost:8787).
export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';
const BASE = API_BASE;

// Refresh tokens are single-use, so concurrent requests must share one refresh call
let refreshing: Promise<string | null> | null = null;

/** Restores the session from the refresh cookie; shared by every caller in the tab. */
export function silentRefresh(): Promise<string | null> {
  refreshing ??= doRefresh().finally(() => { refreshing = null; });
  return refreshing;
}

async function doRefresh(): Promise<string | null> {
  // Never aborted: if the server rotates the token, the browser must receive the new cookie
  const res = await fetch(`${BASE}/auth/refresh`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
  }).catch(() => null);
  if (!res?.ok) return null;
  const { accessToken, role } = await res.json() as { accessToken: string; role: 'owner' | 'accountant' };
  useAuthStore.getState().setAuth(accessToken, role);
  return accessToken;
}

/** A refused request: the server's message, plus its status and whole JSON body for callers that need more. */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: unknown) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  let token = useAuthStore.getState().accessToken;

  if (!token) {
    token = await silentRefresh();
    if (!token) {
      window.location.href = '/login';
      throw new Error('Unauthenticated');
    }
  }

  const makeRequest = (t: string) =>
    fetch(`${BASE}${path}`, {
      ...options,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${t}`,
        'X-Requested-With': 'XMLHttpRequest',
        ...options.headers,
      },
    });

  let res = await makeRequest(token);

  if (res.status === 401) {
    const newToken = await silentRefresh();
    if (!newToken) {
      window.location.href = '/login';
      throw new Error('Unauthenticated');
    }
    res = await makeRequest(newToken);
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new ApiError(err.error ?? `API error ${res.status}`, res.status, err);
  }

  return res.json() as Promise<T>;
}

export async function logout(): Promise<void> {
  const token = useAuthStore.getState().accessToken;
  await fetch(`${BASE}/auth/logout`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'X-Requested-With': 'XMLHttpRequest',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  }).catch(() => {});
  useAuthStore.getState().clearAuth();
}
