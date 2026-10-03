'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { API_BASE } from '@/lib/api';

export default function Home() {
  const router = useRouter();

  useEffect(() => {
    const API = API_BASE;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    let active = true;
    fetch(`${API}/auth/setup/status`, {
      signal: controller.signal,
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    })
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(({ setupRequired }: { setupRequired: boolean }) => {
        if (!active) return;
        clearTimeout(timeout);
        router.replace(setupRequired ? '/setup' : '/dashboard');
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
  }, [router]);

  return (
    <div className="flex min-h-dvh items-center justify-center">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" aria-label="Loading" />
    </div>
  );
}
