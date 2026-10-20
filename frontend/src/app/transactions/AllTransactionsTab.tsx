'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatDate, formatPence } from '@/lib/formatters';
import { amountClass, compactControl, Pager, type Category, type Page, type Txn } from './shared';
import { TransactionDetails } from './TransactionDetails';

export type AllFilters = {
  q: string;
  from: string;
  to: string;
  direction: '' | 'in' | 'out';
  category: string;          // '' | category id | 'matched' | 'none'
  receipt: '' | 'missing' | 'attached';
  status: 'posted' | 'review' | 'all';
};

export const EMPTY_FILTERS: AllFilters = { q: '', from: '', to: '', direction: '', category: '', receipt: '', status: 'posted' };

export function AllTransactionsTab({
  accountId, role, token, categories, initialFilters,
}: {
  accountId: string;
  role: string | null;
  token: string | null;
  categories: Category[];
  initialFilters: AllFilters;
}) {
  const [filters, setFilters] = useState<AllFilters>(initialFilters);
  const [search, setSearch] = useState(initialFilters.q);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => { setFilters(initialFilters); setSearch(initialFilters.q); }, [initialFilters]);
  // Search as you type, without a request per keystroke
  useEffect(() => {
    const t = setTimeout(() => setFilters(f => (f.q === search ? f : { ...f, q: search })), 300);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => { setPage(1); }, [filters, accountId, pageSize]);

  const params = new URLSearchParams({ bankAccountId: accountId, page: String(page), pageSize: String(pageSize) });
  if (filters.status !== 'all') params.set('reviewed', filters.status === 'posted' ? '1' : '0');
  if (filters.q) params.set('q', filters.q);
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (filters.direction) params.set('direction', filters.direction);
  if (filters.category) params.set('category', filters.category);
  if (filters.receipt) params.set('receipt', filters.receipt);

  const { data, isLoading } = useQuery({
    queryKey: ['transactions', 'all', accountId, filters, page, pageSize],
    queryFn: () => api<Page<Txn>>(`/api/v1/transactions?${params.toString()}`),
  });
  const rows = data?.rows ?? [];
  const set = <K extends keyof AllFilters>(key: K, value: AllFilters[K]) => setFilters(f => ({ ...f, [key]: value }));
  const filtered = (Object.keys(EMPTY_FILTERS) as Array<keyof AllFilters>).some(k => filters[k] !== EMPTY_FILTERS[k]);

  return (
    <div className="space-y-3">
      <div className="card px-3 py-2.5 grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
        <label className="text-xs text-slate-500 sm:col-span-2">
          Search
          <input className={`input mt-0.5 ${compactControl}`} placeholder="Description, reference or amount (e.g. 120.50)"
            value={search} onChange={e => setSearch(e.target.value)} />
        </label>
        <label className="text-xs text-slate-500">
          From
          <input type="date" className={`input mt-0.5 ${compactControl}`} value={filters.from} onChange={e => set('from', e.target.value)} />
        </label>
        <label className="text-xs text-slate-500">
          To
          <input type="date" className={`input mt-0.5 ${compactControl}`} value={filters.to} onChange={e => set('to', e.target.value)} />
        </label>
        <label className="text-xs text-slate-500">
          Money
          <select className={`input mt-0.5 ${compactControl}`} value={filters.direction} onChange={e => set('direction', e.target.value as AllFilters['direction'])}>
            <option value="">In and out</option>
            <option value="in">Money in</option>
            <option value="out">Money out</option>
          </select>
        </label>
        <label className="text-xs text-slate-500">
          Category
          <select className={`input mt-0.5 ${compactControl}`} value={filters.category} onChange={e => set('category', e.target.value)}>
            <option value="">Any</option>
            <option value="matched">Matched to an invoice or bill</option>
            <option value="none">No category or match</option>
            {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className="text-xs text-slate-500">
          Receipt
          <select className={`input mt-0.5 ${compactControl}`} value={filters.receipt} onChange={e => set('receipt', e.target.value as AllFilters['receipt'])}>
            <option value="">Any</option>
            <option value="missing">Payments with no receipt</option>
            <option value="attached">Payments with a receipt</option>
          </select>
        </label>
        <label className="text-xs text-slate-500">
          Status
          <select className={`input mt-0.5 ${compactControl}`} value={filters.status} onChange={e => set('status', e.target.value as AllFilters['status'])}>
            <option value="posted">Posted</option>
            <option value="review">In review</option>
            <option value="all">All</option>
          </select>
        </label>
      </div>

      <div className="flex items-center gap-3 text-sm text-slate-600">
        <span>{data ? `${data.total} line${data.total === 1 ? '' : 's'}` : '…'}</span>
        {filtered && (
          <button type="button" className="text-xs text-blue-600 hover:underline"
            onClick={() => { setFilters(EMPTY_FILTERS); setSearch(''); }}>
            Clear filters
          </button>
        )}
        <label className="ml-auto text-xs text-slate-500 flex items-center gap-1">
          Per page
          <select className={`input w-20 ${compactControl}`} value={pageSize} onChange={e => setPageSize(Number(e.target.value))}>
            {[25, 50, 100, 200].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      </div>

      <div className="card overflow-auto p-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50">
            <tr>
              {['Date', 'Description', 'Amount', 'Category / match', 'Receipt', 'Status'].map(h => (
                <th key={h} className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoading && <tr><td colSpan={6} className="p-8 text-center text-sm text-slate-400">Loading…</td></tr>}
            {!isLoading && rows.length === 0 && (
              <tr>
                <td colSpan={6} className="p-8 text-center text-sm text-slate-400">
                  {filtered ? 'No lines match these filters.' : 'Nothing posted in this account yet. Post lines from For Review.'}
                </td>
              </tr>
            )}
            {rows.map(t => (
              <tr
                key={t.id}
                tabIndex={0}
                onClick={() => setOpenId(t.id)}
                onKeyDown={e => { if (e.key === 'Enter') setOpenId(t.id); }}
                className={`border-t border-slate-100 cursor-pointer ${t.flagged ? 'bg-amber-50' : 'hover:bg-slate-50'} ${openId === t.id ? 'bg-blue-50' : ''}`}
              >
                <td className="px-3 py-2 whitespace-nowrap">{formatDate(t.date)}</td>
                <td className="px-3 py-2 min-w-56 max-w-md">
                  <span className="font-medium text-slate-800 line-clamp-2 break-words" title={t.description}>{t.description}</span>
                  {t.notes && <span className="truncate block text-xs text-slate-400" title={t.notes}>{t.notes}</span>}
                </td>
                <td className={`p-3 ${amountClass(t.amount)}`}>{t.amount < 0 ? '−' : '+'}{formatPence(Math.abs(t.amount))}</td>
                <td className="px-3 py-2 text-xs text-slate-600 max-w-56">
                  {t.match_status && t.match_status !== 'suggested' && t.match_label ? (
                    <span className="truncate block" title={t.match_label}>
                      {t.match_kind === 'link' ? 'Paid in QuickBooks · ' : ''}{t.match_label}
                    </span>
                  ) : null}
                  <span className="truncate block text-slate-500">{t.category_name ?? (t.match_label ? '' : '—')}</span>
                </td>
                <td className="px-3 py-2 text-xs">
                  {t.attachment_r2_key ? <span className="text-slate-600">Attached</span>
                    : t.amount < 0 ? <span className="text-slate-400">None</span> : <span className="text-slate-300">—</span>}
                </td>
                <td className="px-3 py-2 text-xs whitespace-nowrap">
                  {t.is_reconciled ? <span className="badge badge-green">Posted</span> : <span className="badge badge-yellow">In review</span>}
                  {!!t.flagged && <span className="badge badge-red ml-1">Flagged</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && data.total > 0 && <Pager page={page} pageSize={pageSize} total={data.total} onPage={setPage} />}
      </div>

      {openId && (
        <TransactionDetails key={openId} id={openId} role={role} token={token} onClose={() => setOpenId(null)} />
      )}
    </div>
  );
}
