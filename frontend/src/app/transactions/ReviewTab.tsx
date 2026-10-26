'use client';

import { Fragment, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { MatchPanel } from '@/components/MatchPanel';
import { api } from '@/lib/api';
import { formatDate, formatPence } from '@/lib/formatters';
import { amountClass, compactControl, openReceipt, Pager, ReceiptField, type Category, type Page, type Txn } from './shared';
import { postAction, ruleHref } from './reviewRules';
import { valueToVat, vatChoicesFor, vatLabel, vatToValue } from '@/lib/vat';

const PAGE_SIZE = 50;
// The API posts at most this many lines per request (D1 query limit per Worker invocation)
const POST_CHUNK = 25;

export function ReviewTab({
  accountId, role, token, categories, range, onClearRange,
}: {
  accountId: string;
  role: string | null;
  token: string | null;
  categories: Category[];
  range: { from: string | null; to: string | null };
  onClearRange: () => void;
}) {
  const qc = useQueryClient();
  const owner = role === 'owner';
  const columns = owner ? 8 : 7;
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [receiptFor, setReceiptFor] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [batchMsg, setBatchMsg] = useState('');

  useEffect(() => { setPage(1); setSelected(new Set()); }, [accountId, range.from, range.to]);

  const params = new URLSearchParams({ bankAccountId: accountId, reviewed: '0', page: String(page), pageSize: String(PAGE_SIZE) });
  if (range.from) params.set('from', range.from);
  if (range.to) params.set('to', range.to);
  const { data, isLoading } = useQuery({
    queryKey: ['transactions', 'review', accountId, page, range.from, range.to],
    queryFn: () => api<Page<Txn>>(`/api/v1/transactions?${params.toString()}`),
  });
  const rows = data?.rows ?? [];

  // Posting the last lines of a page leaves it empty: step back
  useEffect(() => {
    if (data && data.rows.length === 0 && page > 1) setPage(p => p - 1);
  }, [data, page]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['transactions'] });
    qc.invalidateQueries({ queryKey: ['review-counts'] });
    qc.invalidateQueries({ queryKey: ['account-balance', accountId] });
  };

  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api(`/api/v1/transactions/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['transactions'] }),
  });

  const post = useMutation({
    mutationFn: async (t: Txn) => {
      // A suggestion is accepted first, then posted with the line
      if (t.match_status === 'suggested' && t.match_id) {
        await api('/api/v1/transaction-matches', {
          method: 'POST',
          body: JSON.stringify({
            transactionId: t.id, type: t.match_type, targetId: t.match_target_id, allocatedAmount: t.match_allocated,
          }),
        });
      }
      return api(`/api/v1/transactions/${t.id}/post`, { method: 'POST' });
    },
    onMutate: (t) => setRowError(e => ({ ...e, [t.id]: '' })),
    onSuccess: (_, t) => { setSelected(s => { const n = new Set(s); n.delete(t.id); return n; }); refresh(); },
    onError: (err: Error, t) => { setRowError(e => ({ ...e, [t.id]: err.message })); refresh(); },
  });

  const postSelected = useMutation({
    mutationFn: async (ids: string[]) => {
      const total = { posted: 0, failed: [] as Array<{ id: string; error: string }>, stopped: '' };
      for (let i = 0; i < ids.length; i += POST_CHUNK) {
        try {
          const res = await api<{ posted: number; failed: Array<{ id: string; error: string }> }>(
            '/api/v1/transactions/post', { method: 'POST', body: JSON.stringify({ ids: ids.slice(i, i + POST_CHUNK) }) });
          total.posted += res.posted;
          total.failed.push(...res.failed);
        } catch (err) {
          total.stopped = err instanceof Error ? err.message : 'Post failed';
          break;
        }
      }
      return total;
    },
    onSuccess: (res) => {
      setSelected(new Set());
      setRowError(Object.fromEntries(res.failed.map(f => [f.id, f.error])));
      const posted = `Posted ${res.posted} line${res.posted === 1 ? '' : 's'}${res.failed.length ? `; ${res.failed.length} need attention` : ''}.`;
      setBatchMsg(res.stopped ? `${posted} Stopped early: ${res.stopped}` : posted);
      refresh();
    },
  });

  const selectable = rows.filter(t => postAction(t).ready && t.match_status !== 'suggested');
  const allSelected = selectable.length > 0 && selectable.every(t => selected.has(t.id));
  const toggle = (id: string) => setSelected(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 text-sm min-h-8">
        <span className="text-slate-600">
          {data ? `${data.total} line${data.total === 1 ? '' : 's'} to review` : '…'}
        </span>
        {(range.from || range.to) && (
          <span className="inline-flex items-center gap-2 rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600">
            {range.from ? formatDate(range.from) : '…'} – {range.to ? formatDate(range.to) : '…'}
            <button type="button" aria-label="Clear date filter" className="text-slate-400 hover:text-slate-700" onClick={onClearRange}>✕</button>
          </span>
        )}
        {owner && (
          <button
            type="button"
            className={`btn-primary ml-auto ${compactControl}`}
            disabled={selected.size === 0 || postSelected.isPending}
            onClick={() => { setBatchMsg(''); postSelected.mutate([...selected]); }}
          >
            {postSelected.isPending ? 'Posting…' : `Post selected (${selected.size})`}
          </button>
        )}
      </div>
      {batchMsg && <p className="text-sm text-slate-600" role="status">{batchMsg}</p>}

      <div className="card overflow-auto p-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50">
            <tr>
              {owner && (
                <th className="px-3 py-2 w-8">
                  <input
                    type="checkbox"
                    aria-label="Select every line ready to post"
                    checked={allSelected}
                    disabled={selectable.length === 0}
                    onChange={e => setSelected(e.target.checked ? new Set(selectable.map(t => t.id)) : new Set())}
                  />
                </th>
              )}
              {['Date', 'Description', 'Amount', 'Category', 'Match', 'Notes', ''].map((h, i) => (
                <th key={i} className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr><td colSpan={columns} className="p-8 text-center text-sm text-slate-400">Loading…</td></tr>
            )}
            {!isLoading && rows.length === 0 && (
              <tr>
                <td colSpan={columns} className="p-8 text-center text-sm text-slate-400">
                  Nothing to review in this account. New lines appear here after each CSV import.
                </td>
              </tr>
            )}
            {rows.map(t => {
              const action = postAction(t);
              const canSelect = selectable.some(s => s.id === t.id);
              return (
                <Fragment key={t.id}>
                  <tr className={`border-t border-slate-100 align-top ${t.flagged ? 'bg-amber-50' : 'hover:bg-slate-50'}`}>
                    {owner && (
                      <td className="px-3 py-2">
                        <input type="checkbox" aria-label={`Select ${t.description}`} disabled={!canSelect}
                          checked={selected.has(t.id)} onChange={() => toggle(t.id)} />
                      </td>
                    )}
                    <td className="px-3 py-2 whitespace-nowrap">{formatDate(t.date)}</td>
                    <td className="px-3 py-2 min-w-56 max-w-md" title={t.description}>
                      <span className="font-medium text-slate-800 line-clamp-2 break-words">{t.description}</span>
                      {t.reference && t.reference !== t.description && (
                        <span className="block truncate text-xs text-slate-400">{t.reference}</span>
                      )}
                      {t.attachment_r2_key && (
                        <button type="button" onClick={() => openReceipt(token, t.id)}
                          className="block text-xs text-blue-600 hover:text-blue-800 mt-0.5 hover:underline">
                          {t.attachment_filename ?? 'attachment'}
                        </button>
                      )}
                      {owner && t.amount < 0 && (
                        <button
                          type="button"
                          onClick={() => setReceiptFor(id => (id === t.id ? null : t.id))}
                          className={`block mt-0.5 text-xs ${t.attachment_r2_key ? 'text-slate-400 hover:text-slate-700' : 'text-blue-600 hover:text-blue-800'}`}
                        >
                          {t.attachment_r2_key ? 'Change receipt' : '+ Attach receipt'}
                        </button>
                      )}
                    </td>
                    <td className={`p-3 ${amountClass(t.amount)}`}>
                      {t.amount < 0 ? '−' : '+'}{formatPence(Math.abs(t.amount))}
                      {(t.overpayment_amount ?? 0) > 0 && (
                        <span className="block text-xs font-medium text-amber-700">−{formatPence(t.overpayment_amount!)} due back</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {owner ? (<>
                        <select
                          aria-label="Category"
                          value={t.expense_category_id ?? ''}
                          onChange={e => patch.mutate({ id: t.id, body: { expenseCategoryId: e.target.value || null } })}
                          className={`input min-w-36 max-w-44 ${compactControl}`}
                        >
                          <option value="">— none —</option>
                          {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                        {t.expense_category_id && (
                          <select
                            aria-label="VAT included"
                            value={vatToValue(t.vat_rate)}
                            onChange={e => patch.mutate({ id: t.id, body: { vatRate: valueToVat(e.target.value) } })}
                            className={`input mt-1 min-w-36 max-w-44 ${compactControl} ${t.vat_rate == null ? 'border-amber-400 text-amber-700' : ''}`}
                          >
                            <option value="">VAT? choose…</option>
                            {vatChoicesFor(t.vat_rate).map(v => <option key={v.value} value={v.value}>{v.label}</option>)}
                          </select>
                        )}
                        {t.categorised_by_rule_id ? (
                          <span className="block mt-0.5 text-[11px] text-slate-400">auto: rule</span>
                        ) : t.expense_category_id ? (
                          <Link href={ruleHref(t)} className="block mt-0.5 text-[11px] text-blue-600 hover:text-blue-800">Make rule</Link>
                        ) : null}
                      </>) : (
                        <span className="text-xs text-slate-500">
                          {t.category_name ?? '—'}
                          {t.expense_category_id && <span className="block text-[11px] text-slate-400">{vatLabel(t.vat_rate)}</span>}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 relative whitespace-nowrap">
                      {owner ? <MatchPanel txn={t} /> : (
                        <span className="text-xs text-slate-500">{t.match_label ?? '—'}</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <input
                        aria-label="Notes"
                        placeholder={owner ? 'Add note' : 'Accountant note'}
                        className="border-b border-transparent hover:border-slate-300 focus:border-slate-400 text-xs w-32 bg-transparent outline-none placeholder:text-slate-300"
                        defaultValue={owner ? (t.notes ?? '') : (t.accountant_notes ?? '')}
                        onBlur={e => {
                          const key = owner ? 'notes' : 'accountantNotes';
                          const before = owner ? (t.notes ?? '') : (t.accountant_notes ?? '');
                          if (e.target.value !== before) patch.mutate({ id: t.id, body: { [key]: e.target.value } });
                        }}
                      />
                    </td>
                    <td className="px-3 py-2 text-right">
                      {owner && (
                        <button
                          type="button"
                          className={`btn-primary ${compactControl}`}
                          disabled={!action.ready || (post.isPending && post.variables?.id === t.id)}
                          title={action.hint}
                          onClick={() => post.mutate(t)}
                        >
                          {post.isPending && post.variables?.id === t.id ? '…' : action.label}
                        </button>
                      )}
                      {rowError[t.id] && <p className="text-xs text-red-600 mt-1 max-w-48 text-left" role="alert">{rowError[t.id]}</p>}
                    </td>
                  </tr>
                  {receiptFor === t.id && (
                    <tr className="bg-slate-50 border-t border-slate-200">
                      <td colSpan={columns} className="px-4 py-3">
                        <div className="max-w-md">
                          <p className="text-xs font-medium text-slate-600 mb-1.5">Supplier invoice / receipt</p>
                          <ReceiptField txn={t} token={token} onSaved={() => { setReceiptFor(null); refresh(); }} />
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {data && data.total > PAGE_SIZE && (
          <Pager page={page} pageSize={PAGE_SIZE} total={data.total} onPage={setPage} />
        )}
      </div>
    </div>
  );
}
