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
        <div className="spinner" role="status" aria-label="Loading" />
      </div>
    );
  }

  return (
    <div className="app-frame">
      <Sidebar />
      <main className="app-main" id="main-content" tabIndex={-1}>
        <div className="mx-auto max-w-6xl px-2 py-4 sm:px-4 sm:py-6">
          {children}
        </div>
      </main>
    </div>
  );
}
