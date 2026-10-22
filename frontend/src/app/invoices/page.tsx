'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { RoleGuard } from '@/components/RoleGuard';
import { Pager } from '@/components/Pager';
import { api } from '@/lib/api';
import { formatPence, formatDate, statusBadgeClass, statusLabel } from '@/lib/formatters';
import { creditStatusLabel } from '@/lib/creditNote';
import { nextSort, type SortKey } from './listSort';

type InvoiceRow = {
  id: string;
  invoice_number: string;
  status: string;
  source: 'ledgerlite' | 'quickbooks';
  vat_for_invoice_id: string | null;
  kind: 'invoice' | 'credit_note';
  vat_treatment: 'standard' | 'outside_scope';
  /** Credit applied to it by credit notes */
  credited: number;
  issue_date: string;
  due_date: string;
  total: number;
  amount_paid: number;
  client_name: string;
};
type InvoicePage = { rows: InvoiceRow[]; total: number; page: number; pageSize: number; counts: Record<string, number> };
type Client = { id: string; name: string };

const PAGE_SIZE = 50;

// Status chips; unpaid covers sent, part paid and overdue. The counts come from the server.
const STATUS_CHIPS: Array<{ value: string; label: string; count: string }> = [
  { value: '', label: 'All', count: 'all' },
  { value: 'draft', label: 'Drafts', count: 'draft' },
  { value: 'unpaid', label: 'Unpaid', count: 'unpaid' },
  { value: 'overdue', label: 'Overdue', count: 'overdue' },
  { value: 'paid', label: 'Paid', count: 'paid' },
  { value: 'void', label: 'Void', count: 'void' },
];

const COLUMNS: Array<{ key: SortKey; label: string; right?: boolean }> = [
  { key: 'number', label: 'Number' },
  { key: 'client', label: 'Client' },
  { key: 'issue_date', label: 'Issued' },
  { key: 'due_date', label: 'Due' },
  { key: 'status', label: 'Status' },
  { key: 'total', label: 'Amount', right: true },
  { key: 'balance', label: 'Balance', right: true },
];

// The filters live in the address (?status=…&q=…&sort=…&page=…), so a refresh or a shared link
// shows the same list
const FILTER_KEYS = ['status', 'q', 'client_id', 'from', 'to', 'sort', 'dir', 'page'] as const;

/** True when `local` still has a filter the address has not applied yet. */
function isAhead(local: URLSearchParams, url: URLSearchParams): boolean {
  for (const [key, value] of local.entries()) {
    if (url.get(key) !== value) return true;
  }
  for (const key of url.keys()) {
    if (!local.has(key)) return true;
  }
  return false;
}

export default function InvoicesPage() {
  return (
    <AppShell>
      <RoleGuard allowedRoles={['owner']}>
        <Suspense>
          <InvoicesContent />
        </Suspense>
      </RoleGuard>
    </AppShell>
  );
}

function InvoicesContent() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const get = (k: (typeof FILTER_KEYS)[number]) => params.get(k) ?? '';
  const status = get('status');
  const q = get('q');
  const clientId = get('client_id');
  const from = get('from');
  const to = get('to');
  const sort = get('sort') as SortKey | '';
  const dir = get('dir') === 'asc' ? 'asc' : 'desc';
  const page = Math.max(1, Number.parseInt(get('page') || '1', 10) || 1);

  // Filters the address has not caught up with yet. A search timer and a status click
  // in the same moment both merge into this, and a late render of the old address does not wipe it.
  const paramsRef = useRef(new URLSearchParams(params.toString()));
  const written = useRef(params.toString());
  const seenUrl = useRef(params.toString());
  const url = params.toString();
  if (url !== seenUrl.current) {
    const prev = seenUrl.current;
    seenUrl.current = url;
    const urlParams = new URLSearchParams(url);
    const caughtUp = url === written.current || !isAhead(paramsRef.current, urlParams);
    const external = prev === written.current && url !== written.current;
    if (caughtUp || external) {
      paramsRef.current = urlParams;
      written.current = url;
    }
  }

  /** Changes some filters; any change but the page goes back to page 1. */
  const update = (changes: Partial<Record<(typeof FILTER_KEYS)[number], string>>) => {
    const next = new URLSearchParams(paramsRef.current.toString());
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v); else next.delete(k);
    }
    if (!('page' in changes)) next.delete('page');
    paramsRef.current = next;
    const qs = next.toString();
    written.current = qs;
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  // The search box updates the address a moment after typing stops
  const [search, setSearch] = useState(q);
  useEffect(() => { setSearch(q); }, [q]);
  useEffect(() => {
    if (search.trim() === q) return;
    const t = setTimeout(() => update({ q: search.trim() }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const query = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
  if (status) query.set('status', status);
  if (q) query.set('q', q);
  if (clientId) query.set('client_id', clientId);
  if (from) query.set('from', from);
  if (to) query.set('to', to);
  if (sort) { query.set('sort', sort); query.set('dir', dir); }

  const { data, isLoading, isFetching } = useQuery<InvoicePage>({
    queryKey: ['invoices', 'list', query.toString()],
    queryFn: () => api<InvoicePage>(`/api/v1/invoices?${query.toString()}`),
    placeholderData: keepPreviousData,
  });
  const { data: clients = [] } = useQuery<Client[]>({
    queryKey: ['clients'],
    queryFn: () => api<Client[]>('/api/v1/clients'),
  });

  const rows = data?.rows ?? [];
  const filtered = !!(status || q || clientId || from || to);
  // Asking for a page past the end (e.g. after a filter narrowed the list): show the last one
  useEffect(() => {
    if (data && data.rows.length === 0 && data.total > 0 && page > 1) {
      update({ page: String(Math.ceil(data.total / PAGE_SIZE)) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, page]);

  // Click a heading to sort by it, again to flip it, a third time for the default order (see nextSort)
  const sortBy = (key: SortKey) => {
    const next = nextSort({ sort, dir }, key);
    update({ sort: next.sort, dir: next.sort ? next.dir : '' });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Invoices</h1>
          <p className="mt-1 text-sm text-slate-500">Track and manage your invoices.</p>
        </div>
        <div className="flex gap-2">
          <Link href="/invoices/import" className="btn-secondary">Import from QuickBooks</Link>
          <Link href="/invoices/new" className="btn-primary">New invoice</Link>
        </div>
      </div>

      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by status">
        {STATUS_CHIPS.map(f => (
          <button
            key={f.value}
            type="button"
            onClick={() => update({ status: f.value })}
            aria-pressed={status === f.value}
            className={`rounded-full border px-3 py-1 text-xs ${status === f.value
              ? 'border-blue-600 bg-blue-600 text-white'
              : 'border-slate-200 text-slate-600 hover:border-blue-300 hover:text-slate-900'}`}
          >
            {f.label} <span className="tabular-nums opacity-70">{data?.counts?.[f.count] ?? 0}</span>
          </button>
        ))}
      </div>

      <div className="card flex flex-wrap items-end gap-3 py-3">
        <div className="min-w-56 flex-1">
          <label htmlFor="inv-q" className="field-label">Search</label>
          <input id="inv-q" type="search" value={search} onChange={e => setSearch(e.target.value)}
            className="input" placeholder="Number, client or amount" />
        </div>
        <div className="min-w-48">
          <label htmlFor="inv-client-filter" className="field-label">Client</label>
          <select id="inv-client-filter" value={clientId} onChange={e => update({ client_id: e.target.value })} className="input">
            <option value="">All clients</option>
            {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="inv-from" className="field-label">Issued from</label>
          <input id="inv-from" type="date" value={from} onChange={e => update({ from: e.target.value })} className="input" />
        </div>
        <div>
          <label htmlFor="inv-to" className="field-label">to</label>
          <input id="inv-to" type="date" value={to} onChange={e => update({ to: e.target.value })} className="input" />
        </div>
        {(filtered || sort) && (
          <button type="button" className="btn-secondary"
            onClick={() => {
              setSearch('');
              paramsRef.current = new URLSearchParams();
              written.current = '';
              router.replace(pathname, { scroll: false });
            }}>
            Clear
          </button>
        )}
      </div>

      <div className={`card overflow-x-auto p-0 ${isFetching && !isLoading ? 'opacity-70' : ''}`}>
        {isLoading ? (
          <div className="space-y-3 p-4">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="h-14 animate-pulse rounded-lg bg-slate-100" />
            ))}
          </div>
        ) : rows.length === 0 && !filtered ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <p className="text-sm font-medium text-slate-500">No invoices yet</p>
            <p className="text-xs text-slate-400 mt-1">Create your first invoice to get started.</p>
            <Link href="/invoices/new" className="btn-primary mt-4">New invoice</Link>
          </div>
        ) : (
          <>
            {data && data.total > 0 && (
              <Pager top page={page} pageSize={PAGE_SIZE} total={data.total} onPage={p => update({ page: p > 1 ? String(p) : '' })} />
            )}
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100">
                  {COLUMNS.map(col => {
                    const active = sort === col.key;
                    return (
                      <th key={col.key} scope="col"
                        aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                        className={`py-3 px-4 text-xs font-semibold uppercase tracking-wide text-slate-500 whitespace-nowrap ${col.right ? 'text-right' : 'text-left'}`}>
                        <button type="button" onClick={() => sortBy(col.key)}
                          className={`inline-flex items-center gap-1 uppercase hover:text-slate-900 ${active ? 'text-slate-900' : ''}`}>
                          {col.label}
                          <span aria-hidden="true" className={active ? '' : 'opacity-0'}>{dir === 'asc' ? '▲' : '▼'}</span>
                        </button>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {rows.length === 0 && (
                  <tr><td colSpan={COLUMNS.length} className="py-12 text-center text-sm text-slate-500">No invoices match these filters.</td></tr>
                )}
                {rows.map(inv => {
                  const creditNote = inv.kind === 'credit_note';
                  // A credit note's balance is credit still to refund: shown negative, like its total
                  const sign = creditNote ? -1 : 1;
                  const balance = inv.status === 'void' ? 0 : sign * (inv.total - inv.amount_paid);
                  return (
                    <tr key={inv.id} className="hover:bg-slate-50 transition-colors">
                      <td className="py-3 px-4 whitespace-nowrap">
                        <Link href={`/invoices/view?id=${inv.id}`} className="font-mono text-blue-600 hover:text-blue-800 font-medium">
                          {inv.invoice_number}
                        </Link>
                        {inv.source === 'quickbooks' && (
                          <span className="ml-2 text-xs text-slate-400" title="Imported from QuickBooks">QB</span>
                        )}
                        {inv.vat_for_invoice_id && (
                          <span className="ml-2 text-xs text-slate-400" title="Charges only the VAT on an earlier invoice">VAT only</span>
                        )}
                        {creditNote && <span className="ml-2 text-xs text-slate-400">Credit note</span>}
                        {inv.vat_treatment === 'outside_scope' && (
                          <span className="ml-2 text-xs text-slate-400" title="Outside the scope of UK VAT: a customer outside the UK">No UK VAT</span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-slate-700">{inv.client_name}</td>
                      <td className="py-3 px-4 text-slate-500 tabular-nums whitespace-nowrap">{formatDate(inv.issue_date)}</td>
                      <td className="py-3 px-4 text-slate-500 tabular-nums whitespace-nowrap">{formatDate(inv.due_date)}</td>
                      <td className="py-3 px-4">
                        <span className={`badge ${statusBadgeClass[inv.status] ?? 'badge-gray'}`}>
                          {creditNote ? creditStatusLabel[inv.status] ?? inv.status
                            : inv.credited >= inv.total && inv.status !== 'void' ? 'Credited'
                            : statusLabel[inv.status] ?? inv.status}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right tabular-nums font-medium text-slate-900">{formatPence(sign * inv.total)}</td>
                      <td className={`py-3 px-4 text-right tabular-nums ${balance !== 0 ? 'text-slate-900' : 'text-slate-400'}`}>
                        {formatPence(balance)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}
