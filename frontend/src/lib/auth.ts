import { create } from 'zustand';

interface AuthState {
  accessToken: string | null;
  role: 'owner' | 'accountant' | null;
  setAuth:   (token: string, role: 'owner' | 'accountant') => void;
  clearAuth: () => void;
}

// Module-level variable only — gone on page refresh.
// Silent re-auth happens via httpOnly refresh_token cookie on /auth/refresh.
// NEVER store in localStorage or sessionStorage.
export const useAuthStore = create<AuthState>((set) => ({
  accessToken: null,
  role:        null,
  setAuth:     (accessToken, role) => set({ accessToken, role }),
  clearAuth:   () => set({ accessToken: null, role: null }),
}));

/** The email claim of an access token, for display only (the server verifies the token). */
export function tokenEmail(token: string | null): string | null {
  const payload = token?.split('.')[1];
  if (!payload) return null;
  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(base64), ch => ch.charCodeAt(0));
    const claims: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const email = (claims as { email?: unknown }).email;
    return typeof email === 'string' && email ? email : null;
  } catch {
    return null;
  }
}

/** One or two letters for an avatar: "jane.doe@firm.co.uk" → "JD", "owner@test.com" → "O". */
export function initialsFor(email: string | null): string {
  const local = email?.split('@')[0] ?? '';
  const parts = local.split(/[._+-]+/).filter(part => /^[a-z]/i.test(part));
  const letters = parts.slice(0, 2).map(part => part[0].toUpperCase()).join('');
  return letters || '?';
}
