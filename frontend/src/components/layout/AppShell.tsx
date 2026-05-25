'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/lib/auth';
import { Sidebar } from './Sidebar';

interface Props {
  children: React.ReactNode;
}

export function AppShell({ children }: Props) {
  const { accessToken, setAuth } = useAuthStore();
  const router = useRouter();

  // On mount: if no token in memory, try silent refresh via cookie
  useEffect(() => {
    if (accessToken) return;
    const BASE = process.env.NEXT_PUBLIC_API_URL ?? '';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    let active = true;
    fetch(`${BASE}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
      signal: controller.signal,
    })
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(({ accessToken, role }: { accessToken: string; role: 'owner' | 'accountant' }) => {
        if (!active) return;
        clearTimeout(timeout);
        setAuth(accessToken, role);
      })
      .catch(() => {
        if (!active) return;
        clearTimeout(timeout);
        router.replace('/login');
      });

    return () => {
      active = false;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [accessToken, router, setAuth]);

  if (!accessToken) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" aria-label="Loading" />
      </div>
    );
  }

  return (
    <div className="flex h-dvh">
      <Sidebar />
      <main className="flex-1 overflow-y-auto" id="main-content" tabIndex={-1}>
        <div className="mx-auto max-w-7xl px-6 py-8">
          {children}
        </div>
      </main>
    </div>
  );
}
