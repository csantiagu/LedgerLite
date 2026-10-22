'use client';

import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/formatters';
import { auditActor, auditChanges, auditTitle, type AuditEntry } from '@/lib/audit';

export type AuditResource =
  'invoice' | 'bill' | 'transaction' | 'client' | 'vendor' | 'bank_account' | 'expense_category' | 'categorisation_rule';

/** One audit entry: when, who, what, and the fields it changed. */
export function AuditEntryRow({ entry, aside }: { entry: AuditEntry; aside?: ReactNode }) {
  const changes = auditChanges(entry);
  return (
    <li className="py-2">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-slate-800">{auditTitle(entry)}</p>
        {aside && <span className="shrink-0 text-xs text-slate-500">{aside}</span>}
      </div>
      <p className="text-xs text-slate-500">{formatDateTime(entry.created_at)} · {auditActor(entry)}</p>
      {changes.length > 0 && (
        <dl className="mt-1 space-y-0.5 text-xs">
          {changes.map(ch => (
            <div key={ch.field} className="flex flex-wrap gap-x-1.5">
              <dt className="text-slate-500">{ch.field}:</dt>
              <dd className="text-slate-700 break-words">
                {ch.from !== '—' && <><span className="line-through decoration-slate-400">{ch.from}</span> → </>}
                {ch.to}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  );
}

/**
 * Who changed this record, when, and what changed: newest first. Collapsed until opened, so the
 * history is only fetched when someone wants it.
 */
export function AuditHistory({ type, id, className = '' }: { type: AuditResource; id: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const { data, isLoading, error } = useQuery({
    queryKey: ['audit', type, id],
    queryFn: () => api<AuditEntry[]>(`/api/v1/audit/${type}/${id}`),
    enabled: open,
  });
  const entries = data ? [...data].reverse() : [];

  return (
    <section className={className}>
      <button
        type="button"
        className="text-xs font-semibold uppercase tracking-wide text-slate-500 hover:text-slate-800"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
      >
        {open ? '▾' : '▸'} History
      </button>
      {open && (
        isLoading ? <p className="mt-2 text-sm text-slate-500">Loading…</p>
        : error ? <p className="mt-2 text-sm text-red-700">{(error as Error).message}</p>
        : entries.length === 0 ? <p className="mt-2 text-sm text-slate-500">No changes recorded.</p>
        : <ol className="mt-1 divide-y divide-slate-100">{entries.map(e => <AuditEntryRow key={e.id} entry={e} />)}</ol>
      )}
    </section>
  );
}
