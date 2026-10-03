'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/lib/auth';
import { Sidebar } from './Sidebar';
import { silentRefresh } from '@/lib/api';

interface Props {
  children: React.ReactNode;
}

export function AppShell({ children }: Props) {
  const accessToken = useAuthStore(s => s.accessToken);
  const router = useRouter();

  // On mount: if no token in memory, restore the session from the refresh cookie
  useEffect(() => {
    if (accessToken) return;
    let active = true;
    silentRefresh().then(token => {
      if (active && !token) router.replace('/login');
    });
    return () => { active = false; };
  }, [accessToken, router]);

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
