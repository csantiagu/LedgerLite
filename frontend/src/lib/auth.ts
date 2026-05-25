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
