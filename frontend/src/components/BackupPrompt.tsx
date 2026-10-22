'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuthStore } from '@/lib/auth';
import { backupWarning, type BackupStatus } from '@/lib/backups';

/** Dashboard warning for the owner when backups aren't running or something is wrong. */
export function BackupPrompt() {
  const owner = useAuthStore(s => s.role) === 'owner';
  const { data } = useQuery({
    queryKey: ['backups'],
    queryFn: () => api<BackupStatus>('/api/v1/backups'),
    enabled: owner,
  });
  const warning = data && backupWarning(data);
  if (!owner || !warning) return null;
  return (
    <div className="card flex flex-wrap items-center justify-between gap-3 border-amber-200 bg-amber-50 text-sm text-amber-900">
      <p><strong>Backups:</strong> {warning}</p>
      <Link href="/settings/backups" className="btn-secondary text-sm">Check backups</Link>
    </div>
  );
}
