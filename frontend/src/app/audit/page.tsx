'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { AppShell } from '@/components/layout/AppShell';
import { AuditEntryRow } from '@/components/AuditHistory';
import { Pager } from '@/components/Pager';
import { api } from '@/lib/api';
import { AUDIT_RECORD_TYPES, auditHref, type AuditEntry } from '@/lib/audit';

type AuditPage = { rows: AuditEntry[]; total: number; page: number; pageSize: number };
type User = { id: string; name: string; role: string };

const PAGE_SIZE = 50;
const TYPE_LABEL = Object.fromEntries(AUDIT_RECORD_TYPES.map(t => [t.value, t.label]));

export default function AuditPage() {
  return (
    <AppShell>
      <AuditContent />
    </AppShell>
  );
}

function AuditContent() {
  const [resourceType, setResourceType] = useState('');
  const [userId, setUserId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);

  const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
  if (resourceType) params.set('resourceType', resourceType);
  if (userId) params.set('userId', userId);
  if (from) params.set('from', from);
  if (to) params.set('to', to);

  const { data, isLoading, error } = useQuery({
    queryKey: ['audit', 'log', params.toString()],
    queryFn: () => api<AuditPage>(`/api/v1/audit?${params}`),
  });
  const { data: users = [] } = useQuery({
    queryKey: ['users'],
    queryFn: () => api<User[]>('/api/v1/users'),
  });

  // Any filter change starts again from the first page
  const filter = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(1); };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Audit trail</h1>
        <p className="mt-1 text-sm text-slate-500">
          Every change to the books: who made it, when, and what it was before. Entries can&rsquo;t be edited or deleted.
        </p>
      </div>

      <div className="card grid grid-cols-1 gap-4 sm:grid-cols-4">
        <div>
          <label htmlFor="audit-type" className="field-label">Record</label>
          <select id="audit-type" className="input" value={resourceType} onChange={e => filter(setResourceType)(e.target.value)}>
            <option value="">All changes</option>
            {AUDIT_RECORD_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="audit-user" className="field-label">Person</label>
          <select id="audit-user" className="input" value={userId} onChange={e => filter(setUserId)(e.target.value)}>
            <option value="">Anyone</option>
            {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="audit-from" className="field-label">From</label>
          <input id="audit-from" type="date" className="input" value={from} onChange={e => filter(setFrom)(e.target.value)} />
        </div>
        <div>
          <label htmlFor="audit-to" className="field-label">To</label>
          <input id="audit-to" type="date" className="input" value={to} onChange={e => filter(setTo)(e.target.value)} />
        </div>
      </div>

      <div className="card overflow-hidden p-0">
        {isLoading ? (
          <div className="space-y-3 p-4">
            {[1, 2, 3].map(i => <div key={i} className="h-12 animate-pulse rounded-lg bg-slate-100" />)}
          </div>
        ) : error ? (
          <p className="p-4 text-sm text-red-700" role="alert">{(error as Error).message}</p>
        ) : !data?.rows.length ? (
          <p className="py-8 text-center text-sm text-slate-500">No changes match these filters.</p>
        ) : (<>
          <ol className="divide-y divide-slate-100 px-4">
            {data.rows.map(entry => {
              const href = auditHref(entry);
              const type = TYPE_LABEL[entry.resource_type] ?? entry.resource_type;
              return (
                <AuditEntryRow key={entry.id} entry={entry} aside={href
                  ? <Link href={href} className="text-blue-600 hover:text-blue-800">{type} ›</Link>
                  : type} />
              );
            })}
          </ol>
          <Pager page={page} pageSize={PAGE_SIZE} total={data.total} onPage={setPage} />
        </>)}
      </div>
    </div>
  );
}
