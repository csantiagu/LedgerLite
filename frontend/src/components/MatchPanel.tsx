'use client';

import { useState, useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatPence, formatDate } from '@/lib/formatters';

type MatchResult = {
  type: 'invoice' | 'bill';
  id: string;
  label: string;
  total: number;
  outstanding: number;
  date: string | null;
};

interface Props {
  txn: {
    id: string;
    amount: number;
    is_reconciled: number;
    match_status?: 'suggested' | 'pending' | 'posted' | null;
    match_label?: string | null;
  };
  accountId: string;
}

export function MatchPanel({ txn, accountId }: Props) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MatchResult[]>([]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['transactions', accountId] });
    qc.invalidateQueries({ queryKey: ['for-review'] });
  };

  const createMatch = useMutation({
    mutationFn: (body: { transactionId: string; type: string; targetId: string; allocatedAmount: number }) =>
      api('/api/v1/transaction-matches', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => { invalidate(); setOpen(false); setQuery(''); setResults([]); },
  });

  useEffect(() => {
    if (!open || !query) { setResults([]); return; }
    const t = setTimeout(async () => {
      const absAmount = Math.abs(txn.amount);
      const params = new URLSearchParams({ amount: String(absAmount), q: query });
      const data = await api<MatchResult[]>(`/api/v1/match-search?${params}`);
      setResults(data);
    }, 300);
    return () => clearTimeout(t);
  }, [query, open, txn.amount]);

  if (txn.is_reconciled) {
    return <span className="text-xs text-green-600 font-medium">✓ Posted</span>;
  }

  if (txn.match_status) {
    const cls: Record<string, string> = {
      suggested: 'bg-amber-100 text-amber-700',
      pending:   'bg-blue-100 text-blue-700',
    };
    return (
      <div className="text-xs">
        <span className={`px-2 py-0.5 rounded-full font-medium ${cls[txn.match_status] ?? ''}`}>
          {txn.match_status === 'suggested' ? '~ Suggested' : '⏳ Pending'}
        </span>
        {txn.match_label && (
          <p className="text-slate-400 truncate max-w-28 mt-0.5" title={txn.match_label}>
            {txn.match_label}
          </p>
        )}
        <p className="text-slate-400 mt-0.5">Review in For Review tab</p>
      </div>
    );
  }

  return (
    <div className="relative">
      {!open ? (
        <button onClick={() => setOpen(true)} className="text-xs text-slate-400 hover:text-blue-600 hover:underline">
          + Find match
        </button>
      ) : (
        <div className="absolute z-20 left-0 top-0 w-72 bg-white border border-slate-200 rounded-lg shadow-lg">
          <div className="flex gap-2 p-2 border-b border-slate-100">
            <input
              autoFocus
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Invoice #, client, vendor…"
              className="flex-1 text-xs border border-slate-200 rounded px-2 py-1"
            />
            <button onClick={() => { setOpen(false); setQuery(''); setResults([]); }} className="text-slate-400 text-xs">✕</button>
          </div>
          <p className="text-xs text-slate-400 px-3 py-1">
            {txn.amount > 0 ? 'Incoming' : 'Outgoing'} {formatPence(Math.abs(txn.amount))}
          </p>
          <div className="max-h-52 overflow-y-auto">
            {results.length === 0 && query && (
              <p className="text-xs text-slate-400 px-3 py-2">No results.</p>
            )}
            {results.map(r => (
              <button
                key={`${r.type}-${r.id}`}
                onClick={() => createMatch.mutate({
                  transactionId: txn.id,
                  type: r.type,
                  targetId: r.id,
                  allocatedAmount: Math.abs(txn.amount),
                })}
                className="w-full text-left px-3 py-2 hover:bg-slate-50 border-t border-slate-50 flex gap-2"
              >
                <span className={`text-xs px-1.5 py-0.5 rounded font-medium shrink-0 mt-0.5 ${r.type === 'invoice' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}`}>
                  {r.type}
                </span>
                <div className="min-w-0">
                  <p className="text-xs font-medium truncate">{r.label}</p>
                  <p className="text-xs text-slate-500">
                    Outstanding {formatPence(r.outstanding)}{r.date ? ` · Due ${formatDate(r.date)}` : ''}
                  </p>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
