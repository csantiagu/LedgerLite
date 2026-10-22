'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppShell } from '@/components/layout/AppShell';
import { RoleGuard } from '@/components/RoleGuard';
import { api, API_BASE } from '@/lib/api';
import { useAuthStore } from '@/lib/auth';
import { formatDateTime } from '@/lib/formatters';
import { backupWarning, formatBytes, type BackupStatus } from '@/lib/backups';

export default function BackupsPage() {
  return (
    <AppShell>
      <RoleGuard allowedRoles={['owner']}>
        <BackupsContent />
      </RoleGuard>
    </AppShell>
  );
}

function BackupsContent() {
  const qc = useQueryClient();
  const token = useAuthStore(s => s.accessToken);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ['backups'],
    queryFn: () => api<BackupStatus>('/api/v1/backups'),
  });

  const run = useMutation({
    mutationFn: () => api<{ filesCopied: number; filesMissing: number }>('/api/v1/backups/run', { method: 'POST' }),
    onSuccess: r => {
      setMessage({ text: `Backed up the database${r.filesCopied ? `, and ${r.filesCopied} stored file${r.filesCopied === 1 ? '' : 's'}` : ''}.` });
      qc.invalidateQueries({ queryKey: ['backups'] });
    },
    onError: (err: Error) => setMessage({ text: err.message, error: true }),
  });

  const download = async () => {
    setMessage(null);
    const res = await fetch(`${API_BASE}/api/v1/backups/latest`, {
      credentials: 'include',
      headers: { Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      setMessage({ text: body.error ?? `Download failed (${res.status})`, error: true });
      return;
    }
    const name = /filename="?([^";]+)/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'ledgerlite-backup.ndjson';
    const url = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  if (isLoading) return <div className="card h-48 animate-pulse bg-slate-50" />;
  if (error || !data) return <p className="text-sm text-red-700" role="alert">{(error as Error)?.message ?? 'Could not load backups'}</p>;
  const warning = backupWarning(data);
  const { lastGood, lastFailed } = data.database;

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Backups</h1>
        <p className="mt-1 text-sm text-slate-500">
          The database is copied to a separate backup bucket every night, and stored files (receipts, PDFs, statements)
          are copied there as they arrive. Download a copy now and then to keep one outside Cloudflare.
        </p>
      </div>

      {warning && (
        <p className="card border-amber-200 bg-amber-50 text-sm text-amber-900" role="alert">{warning}</p>
      )}
      {message && (
        <p className={`text-sm ${message.error ? 'text-red-700' : 'text-slate-700'}`} role={message.error ? 'alert' : 'status'}>{message.text}</p>
      )}

      <div className="card space-y-3 text-sm">
        <h2 className="text-base font-semibold text-slate-900">Database</h2>
        {lastGood ? (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
            <dt className="text-slate-500">Last backup</dt><dd>{formatDateTime(lastGood.at)}</dd>
            {lastGood.rows !== undefined && <><dt className="text-slate-500">Rows</dt><dd>{lastGood.rows.toLocaleString('en-GB')}</dd></>}
            {lastGood.bytes !== undefined && <><dt className="text-slate-500">Size</dt><dd>{formatBytes(lastGood.bytes)}</dd></>}
          </dl>
        ) : <p className="text-slate-500">No backup yet. The first runs tonight at 02:30 UTC, or now with the button below.</p>}
        {lastFailed && <p className="text-red-700">Failed {formatDateTime(lastFailed.at)}: {lastFailed.error}</p>}
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-primary text-sm" disabled={run.isPending} onClick={() => { setMessage(null); run.mutate(); }}>
            {run.isPending ? 'Backing up…' : 'Back up now'}
          </button>
          <button type="button" className="btn-secondary text-sm" disabled={!lastGood} onClick={download}>
            Download latest backup
          </button>
        </div>
      </div>

      <div className="card space-y-1 text-sm">
        <h2 className="text-base font-semibold text-slate-900">Stored files</h2>
        <p>
          {data.files.referenced - data.files.pending - data.files.missing} of {data.files.referenced} backed up
          {data.files.pending > 0 && ` · ${data.files.pending} waiting (copied a few each hour)`}
          {data.files.last_copied_at && ` · last copied ${formatDateTime(data.files.last_copied_at)}`}
        </p>
        {data.files.missing > 0 && (
          <p className="text-amber-800">{data.files.missing} file{data.files.missing === 1 ? ' was' : 's were'} missing from storage when the backup tried to copy {data.files.missing === 1 ? 'it' : 'them'}.</p>
        )}
      </div>
    </div>
  );
}
