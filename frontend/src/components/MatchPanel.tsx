'use client';

import { useState, useEffect, useLayoutEffect, useRef, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatPence, formatDate } from '@/lib/formatters';

// Height the popover needs to show the search box and a few results
const POPOVER_HEIGHT = 320;
const POPOVER_WIDTH = 288; // .popover is 18rem
const GAP = 8;

type Placement = { style: CSSProperties; above: boolean; listMax: number };

/**
 * Where to put the popover for a trigger at `rect`. It sits over the trigger and grows down, or
 * up when there isn't room below (the last rows of a table), keeping inside the window.
 */
function place(rect: DOMRect): Placement {
  const below = window.innerHeight - rect.top - GAP;
  const above = rect.bottom - GAP;
  const up = below < POPOVER_HEIGHT && above > below;
  const left = Math.max(GAP, Math.min(rect.left, window.innerWidth - POPOVER_WIDTH - GAP));
  // Room left for the results once the search box and the amount line (~90px) are drawn
  const listMax = Math.max(120, Math.min(208, (up ? above : below) - 90));
  return {
    above: up,
    listMax,
    style: up
      ? { position: 'fixed', left, bottom: window.innerHeight - rect.bottom, top: 'auto', zIndex: 50 }
      : { position: 'fixed', left, top: rect.top, zIndex: 50 },
  };
}

type MatchResult = {
  type: 'invoice' | 'bill';
  id: string;
  label: string;
  total: number;
  outstanding: number;
  date: string | null;
  /** Paid invoice imported from QuickBooks: `outstanding` is its payment not yet linked to the bank */
  link?: boolean;
};

interface Props {
  txn: {
    id: string;
    amount: number;
    match_id?: string | null;
    match_status?: 'suggested' | 'pending' | 'posted' | null;
    match_label?: string | null;
    match_kind?: 'payment' | 'link' | null;
    match_allocated?: number | null;
    allocated_total?: number;
  };
}

/**
 * The match cell of a line in For Review: shows a suggested or chosen invoice/bill (the row's
 * Match/Post button acts on it), or lets you find one. QuickBooks links are posted straight away.
 */
export function MatchPanel({ txn }: Props) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MatchResult[]>([]);
  const anchorRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['transactions'] });
    qc.invalidateQueries({ queryKey: ['review-counts'] });
  };
  const reset = () => { setOpen(false); setQuery(''); setResults([]); };

  // The table scrolls inside its card, which would clip a popover drawn in the cell, so it is
  // drawn over the page and follows its row when the page or the table scrolls
  useLayoutEffect(() => {
    if (!open) { setPlacement(null); return; }
    const update = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (rect) setPlacement(place(rect));
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open]);

  // Escape or a click elsewhere closes it
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') reset(); };
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!popoverRef.current?.contains(target) && !anchorRef.current?.contains(target)) reset();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  const createMatch = useMutation({
    mutationFn: (body: { transactionId: string; type: string; targetId: string; allocatedAmount: number }) =>
      api('/api/v1/transaction-matches', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => { invalidate(); reset(); },
  });
  const linkPayment = useMutation({
    mutationFn: (body: { transactionId: string; invoiceId: string }) =>
      api('/api/v1/transaction-matches/link', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => { invalidate(); reset(); },
  });
  const removeMatch = useMutation({
    mutationFn: (matchId: string) => api(`/api/v1/transaction-matches/${matchId}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });
  const unlink = useMutation({
    mutationFn: () =>
      api('/api/v1/transaction-matches/unlink', { method: 'POST', body: JSON.stringify({ transactionId: txn.id }) }),
    onSuccess: invalidate,
  });
  const close = () => { reset(); createMatch.reset(); linkPayment.reset(); };
  const actionError = (createMatch.error ?? linkPayment.error ?? removeMatch.error ?? unlink.error) as Error | null;

  useEffect(() => {
    if (!open || !query) { setResults([]); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      // Money in can only pay invoices; money out can only pay bills
      const params = new URLSearchParams({ q: query, type: txn.amount > 0 ? 'invoice' : 'bill' });
      const data = await api<MatchResult[]>(`/api/v1/match-search?${params}`);
      if (!cancelled) setResults(data);
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, open, txn.amount]);

  const linked = txn.match_kind === 'link';
  // What's left of the bank line once earlier links/matches are taken off
  const remaining = Math.abs(txn.amount) - (txn.allocated_total ?? 0);
  const errorLine = actionError && <p className="text-xs text-red-600 mt-0.5" role="alert">{actionError.message}</p>;

  if (txn.match_id && (txn.match_status === 'suggested' || txn.match_status === 'pending')) {
    const suggested = txn.match_status === 'suggested';
    return (
      <div className="text-xs max-w-44">
        <span className={`badge ${suggested ? 'badge-yellow' : 'badge-blue'}`}>
          {suggested ? 'Suggested' : 'Matched'}
        </span>
        <p className="text-slate-600 truncate mt-0.5" title={txn.match_label ?? undefined}>{txn.match_label}</p>
        <p className="text-slate-400">
          {formatPence(txn.match_allocated ?? 0)} ·{' '}
          <button
            type="button"
            onClick={() => removeMatch.mutate(txn.match_id!)}
            disabled={removeMatch.isPending}
            className="hover:text-red-600 hover:underline"
          >
            {suggested ? 'Dismiss' : 'Remove'}
          </button>
        </p>
        {errorLine}
      </div>
    );
  }

  return (
    <div className="relative" ref={anchorRef}>
      {linked && (
        <div className="text-xs mb-1">
          <p className="text-slate-500 truncate max-w-40" title={txn.match_label ?? undefined}>
            Linked {formatPence(txn.allocated_total ?? 0)}{txn.match_label ? ` · ${txn.match_label}` : ''}
          </p>
          <p className="text-slate-400">
            {formatPence(remaining)} left ·{' '}
            <button type="button" onClick={() => unlink.mutate()} disabled={unlink.isPending}
              className="hover:text-red-600 hover:underline">
              {unlink.isPending ? 'Unlinking…' : 'Unlink'}
            </button>
          </p>
        </div>
      )}
      {/* Stays in place (hidden) while open, so the popover lines up with the row */}
      <button
        onClick={() => setOpen(true)}
        className={`text-xs text-slate-500 hover:text-blue-600 hover:underline ${open ? 'invisible' : ''}`}
        aria-hidden={open}
        tabIndex={open ? -1 : 0}
      >
        + Find match
      </button>
      {open && placement && createPortal(
        // Opening upward, the search box stays at the bottom, next to the row
        <div ref={popoverRef} className={`popover flex ${placement.above ? 'flex-col-reverse' : 'flex-col'}`} style={placement.style}
          role="dialog" aria-label="Find a match">
          <div className={`flex gap-2 p-2 ${placement.above ? 'border-t' : 'border-b'} border-slate-100`}>
            <input
              autoFocus
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Invoice #, client, vendor…"
              className="flex-1 text-xs border border-slate-200 rounded px-2 py-1"
            />
            <button onClick={close} className="text-slate-400 text-xs" aria-label="Close">✕</button>
          </div>
          <p className="text-xs text-slate-400 px-3 py-1">
            {txn.amount > 0 ? 'Incoming' : 'Outgoing'} {formatPence(Math.abs(txn.amount))}
            {remaining !== Math.abs(txn.amount) && ` · ${formatPence(remaining)} left`}
          </p>
          {actionError && <p className="text-xs text-red-600 px-3 py-1" role="alert">{actionError.message}</p>}
          <div className="overflow-y-auto" style={{ maxHeight: placement.listMax }}>
            {results.length === 0 && query && (
              <p className="text-xs text-slate-400 px-3 py-2">No results.</p>
            )}
            {results.map(r => (
              <button
                key={`${r.type}-${r.id}-${r.link ? 'link' : 'pay'}`}
                disabled={createMatch.isPending || linkPayment.isPending}
                onClick={() => r.link
                  ? linkPayment.mutate({ transactionId: txn.id, invoiceId: r.id })
                  : createMatch.mutate({
                      transactionId: txn.id,
                      type: r.type,
                      targetId: r.id,
                      // Pay at most what's outstanding; any remainder can be matched to another invoice/bill
                      allocatedAmount: Math.min(remaining, r.outstanding),
                    })}
                className="w-full text-left px-3 py-2 hover:bg-slate-50 border-t border-slate-50 flex gap-2"
              >
                <span className={`text-xs px-1.5 py-0.5 rounded font-medium shrink-0 mt-0.5 ${r.type === 'invoice' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}`}>
                  {r.link ? 'paid' : r.type}
                </span>
                <div className="min-w-0">
                  <p className="text-xs font-medium truncate">{r.label}</p>
                  <p className="text-xs text-slate-500">
                    {r.link
                      ? `Paid in QuickBooks · link ${formatPence(Math.min(remaining, r.outstanding))}${r.date ? ` · ${formatDate(r.date)}` : ''}`
                      : `Outstanding ${formatPence(r.outstanding)}${r.date ? ` · Due ${formatDate(r.date)}` : ''}`}
                  </p>
                </div>
              </button>
            ))}
          </div>
        </div>,
        document.body,
      )}
      {!open && errorLine}
    </div>
  );
}
