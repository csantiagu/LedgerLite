'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { AuditHistory } from '@/components/AuditHistory';
import { LockedBadge } from '@/components/PeriodLock';
import { formatDate, formatPence } from '@/lib/formatters';
import { amountClass, openReceipt, ReceiptField } from './shared';
import { vatInGross, vatLabel } from '@/lib/vat';

type DetailMatch = {
  id: string;
  kind: 'payment' | 'link';
  status: 'suggested' | 'pending' | 'posted';
  match_type: 'invoice' | 'bill';
  allocated_amount: number;
  posted_at: string | null;
  posted_by_name: string | null;
  label: string | null;
  /** held = extra on this payment; refund = money the supplier returned */
  overpayment_role: 'held' | 'refund' | null;
  overpayment_total: number | null;
  overpayment_refunded: number | null;
};

function heldNote(m: DetailMatch): string {
  const back = m.overpayment_refunded ?? 0;
  const total = m.overpayment_total ?? 0;
  const offBooks = 'It stays off the profit and loss.';
  if (total > 0 && back >= total) return `The supplier has returned this extra. ${offBooks}`;
  if (back > 0) {
    return `The supplier has returned ${formatPence(back)} of this extra. ${formatPence(total - back)} is still to come back. ${offBooks}`;
  }
  return `Extra paid — the supplier owes this back. ${offBooks}`;
}

type Detail = {
  id: string;
  account_name: string | null;
  date: string;
  description: string;
  reference: string | null;
  amount: number;
  category_name: string | null;
  vat_rate: number | null;
  categorised_by_rule_id: string | null;
  rule_text: string | null;
  notes: string | null;
  accountant_notes: string | null;
  flagged: number;
  attachment_r2_key: string | null;
  attachment_filename: string | null;
  is_reconciled: number;
  reviewed_at: string | null;
  reviewed_by_name: string | null;
  matches: DetailMatch[];
};

type UndoResult = { reopened: Array<{ type: string; amount: number }>; alsoReturned: string[] };

const MATCH_STATUS: Record<DetailMatch['status'], string> = { posted: 'Posted', pending: 'Matched, not posted', suggested: 'Suggested' };

/** Side panel with everything about one bank line, and (for the owner) undo back to review. */
export function TransactionDetails({
  id, role, token, onClose,
}: {
  id: string;
  role: string | null;
  token: string | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const owner = role === 'owner';
  const closeRef = useRef<HTMLButtonElement>(null);
  const [notes, setNotes] = useState<string | null>(null);
  const [confirmUndo, setConfirmUndo] = useState(false);
  const [message, setMessage] = useState('');

  const { data: t, isLoading } = useQuery({
    queryKey: ['transactions', 'detail', id],
    queryFn: () => api<Detail>(`/api/v1/transactions/${id}`),
  });

  // The parent passes a new onClose each render; keep the latest without re-running effects
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  // Focus the panel once when it opens, not on every re-render (that would pull focus out of the notes)
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCloseRef.current(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['transactions'] });
    qc.invalidateQueries({ queryKey: ['review-counts'] });
  };

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api(`/api/v1/transactions/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => { setMessage('Saved.'); refresh(); },
    onError: (err: Error) => setMessage(err.message),
  });

  const undo = useMutation({
    mutationFn: () => api<UndoResult>(`/api/v1/transactions/${id}/undo`, { method: 'POST' }),
    onSuccess: (res) => {
      setConfirmUndo(false);
      const parts = ['Sent back to For Review.'];
      if (res.reopened.length) {
        parts.push(`${res.reopened.length === 1 ? 'The payment was' : `${res.reopened.length} payments were`} removed and reopened.`);
      }
      if (res.alsoReturned.length) {
        parts.push(`${res.alsoReturned.length} other line${res.alsoReturned.length === 1 ? '' : 's'} in the same payment went back too.`);
      }
      setMessage(parts.join(' '));
      refresh();
    },
    onError: (err: Error) => { setConfirmUndo(false); setMessage(err.message); },
  });

  const postedPayments = t?.matches.filter(m => m.status === 'posted' && m.kind === 'payment') ?? [];

  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true" aria-label="Transaction details">
      <button type="button" aria-label="Close details" className="absolute inset-0 bg-slate-900/20 cursor-default" onClick={onClose} />
      <aside className="drawer relative h-full w-full max-w-md overflow-y-auto p-5 space-y-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="eyebrow">{t ? `${formatDate(t.date)}${t.account_name ? ` · ${t.account_name}` : ''}` : 'Transaction'}</p>
            {t && <LockedBadge date={t.date} className="mt-1" />}
            <h2 className="mt-1 text-lg text-slate-900 break-words">{t?.description ?? '…'}</h2>
            {t && <p className={`mt-1 text-xl ${amountClass(t.amount)}`}>{t.amount < 0 ? '−' : '+'}{formatPence(Math.abs(t.amount))}</p>}
          </div>
          <button ref={closeRef} type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700" aria-label="Close">✕</button>
        </div>

        {isLoading || !t ? <div className="h-32 animate-pulse rounded bg-slate-100" /> : (<>
          <div className="text-sm">
            {t.is_reconciled ? (
              <p><span className="badge badge-green">Posted</span>
                <span className="ml-2 text-slate-500">
                  {t.reviewed_by_name ? `by ${t.reviewed_by_name}` : ''}{t.reviewed_at ? ` on ${formatDate(t.reviewed_at.slice(0, 10))}` : ''}
                </span>
              </p>
            ) : <span className="badge badge-yellow">In review</span>}
            {!!t.flagged && <span className="badge badge-red ml-2">Flagged by accountant</span>}
          </div>

          <dl className="grid grid-cols-3 gap-x-3 gap-y-2 text-sm">
            {t.reference && (<><dt className="text-slate-500">Reference</dt><dd className="col-span-2 break-words">{t.reference}</dd></>)}
            <dt className="text-slate-500">Category</dt>
            <dd className="col-span-2">
              {t.category_name ?? '—'}
              {t.categorised_by_rule_id && (
                <span className="block text-xs text-slate-400">Set by the rule &ldquo;{t.rule_text}&rdquo;</span>
              )}
            </dd>
            {t.category_name && (<>
              <dt className="text-slate-500">VAT</dt>
              <dd className={`col-span-2 ${t.vat_rate == null ? 'text-amber-700' : ''}`}>
                {vatLabel(t.vat_rate)}
                {!!t.vat_rate && <span className="text-slate-500"> · {formatPence(Math.abs(vatInGross(t.amount, t.vat_rate)))} included</span>}
              </dd>
            </>)}
          </dl>

          {t.matches.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1.5">Matched to</h3>
              <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 text-sm">
                {t.matches.map(m => (
                  <li key={m.id} className="px-3 py-2">
                    <div className="flex justify-between gap-2">
                      <span className="truncate">{m.label ?? (m.match_type === 'invoice' ? 'Invoice' : 'Bill')}</span>
                      <span className="tabular-nums shrink-0">{formatPence(m.allocated_amount)}</span>
                    </div>
                    <p className="text-xs text-slate-500">
                      {m.kind === 'link' ? 'Linked to the payment recorded in QuickBooks' : MATCH_STATUS[m.status]}
                      {m.posted_at ? ` · ${formatDate(m.posted_at.slice(0, 10))}` : ''}
                      {m.posted_by_name ? ` by ${m.posted_by_name}` : ''}
                    </p>
                    {m.overpayment_role === 'held' && (
                      <p className="text-xs text-amber-700">{heldNote(m)}</p>
                    )}
                    {m.overpayment_role === 'refund' && (
                      <p className="text-xs text-amber-700">Refund of that extra. It stays off the profit and loss.</p>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {t.amount < 0 && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1.5">Supplier invoice / receipt</h3>
              {owner ? <ReceiptField txn={t} token={token} onSaved={refresh} />
                : t.attachment_r2_key ? (
                  <button type="button" className="text-sm text-blue-600 hover:underline" onClick={() => openReceipt(token, t.id)}>
                    {t.attachment_filename ?? 'View receipt'}
                  </button>
                ) : <p className="text-sm text-slate-400">None attached</p>}
            </section>
          )}

          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1.5">Notes</h3>
            {owner ? (<>
              <textarea rows={3} className="input text-sm w-full resize-none" placeholder="Why this payment was made…"
                value={notes ?? t.notes ?? ''} onChange={e => setNotes(e.target.value)} />
              <button type="button" className="btn-secondary text-xs px-3 py-1 mt-1.5"
                disabled={notes === null || notes === (t.notes ?? '') || patch.isPending}
                onClick={() => patch.mutate({ notes })}>
                Save notes
              </button>
            </>) : <p className="text-sm text-slate-700 whitespace-pre-wrap">{t.notes || '—'}</p>}
          </section>

          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1.5">Accountant</h3>
            {role === 'accountant' ? (<>
              <label className="flex items-center gap-2 text-sm mb-2">
                <input type="checkbox" checked={!!t.flagged} onChange={e => patch.mutate({ flagged: e.target.checked })} />
                Flag for the owner
              </label>
              <textarea rows={2} className="input text-sm w-full resize-none" placeholder="Note for the owner…"
                defaultValue={t.accountant_notes ?? ''}
                onBlur={e => { if (e.target.value !== (t.accountant_notes ?? '')) patch.mutate({ accountantNotes: e.target.value }); }} />
            </>) : <p className="text-sm text-slate-700 whitespace-pre-wrap">{t.accountant_notes || '—'}</p>}
          </section>

          {message && <p className="text-sm text-slate-700" role="status">{message}</p>}

          {owner && !!t.is_reconciled && (
            <section className="border-t border-slate-200 pt-4">
              {!confirmUndo ? (
                <button type="button" className="btn-secondary text-sm" onClick={() => setConfirmUndo(true)}>
                  Undo — send back to For Review
                </button>
              ) : (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 space-y-2">
                  <p>
                    This line goes back to For Review with its category, notes and receipt.
                    {postedPayments.length > 0 && (
                      <> The payment it made to {postedPayments.map(m => m.label).join(', ')} is removed, so
                        {postedPayments.length === 1 ? ' that invoice/bill reopens' : ' they reopen'} until you post it again.</>
                    )}
                    {t.matches.some(m => m.kind === 'link') && ' Its QuickBooks link is removed.'}
                  </p>
                  <div className="flex gap-2">
                    <button type="button" className="btn-danger text-xs px-3 py-1" disabled={undo.isPending} onClick={() => undo.mutate()}>
                      {undo.isPending ? 'Undoing…' : 'Undo'}
                    </button>
                    <button type="button" className="btn-secondary text-xs px-3 py-1" onClick={() => setConfirmUndo(false)}>Cancel</button>
                  </div>
                </div>
              )}
            </section>
          )}

          <AuditHistory type="transaction" id={t.id} className="border-t border-slate-200 pt-4" />
        </>)}
      </aside>
    </div>
  );
}
