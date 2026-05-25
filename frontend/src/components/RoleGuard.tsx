'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useAuthStore } from '@/lib/auth';

interface Props {
  allowedRoles: ('owner' | 'accountant')[];
  children: React.ReactNode;
}

export function RoleGuard({ allowedRoles, children }: Props) {
  const { role, accessToken } = useAuthStore();
  const router = useRouter();

  useEffect(() => {
    if (role && !allowedRoles.includes(role)) {
      router.replace('/403');
    }
  }, [role, allowedRoles, router]);

  if (!accessToken) return null;
  if (role && !allowedRoles.includes(role)) return null;
  return <>{children}</>;
}
