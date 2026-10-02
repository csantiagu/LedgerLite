'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatPence, formatDate } from '@/lib/formatters';

type Match = {
  matchId: string;
  status: 'suggested' | 'pending';
  transactionId: string;
  date: string;
  description: string;
  amount: number;
  allocatedAmount: number;
  accountName: string | null;
};

type ReviewGroup = {
  type: 'invoice' | 'bill';
  targetId: string;
  label: string;
  total: number;
  alreadyPaid: number;
  dueDate: string | null;
  matches: Match[];
};

export function ForReviewPanel() {
  const qc = useQueryClient();

  const { data: groups = [], isLoading } = useQuery({
    queryKey: ['for-review'],
    queryFn: () => api<ReviewGroup[]>('/api/v1/for-review'),
    refetchInterval: 30_000,
  });

  const removeMatch = useMutation({
    mutationFn: (matchId: string) =>
      api(`/api/v1/transaction-matches/${matchId}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['for-review'] }),
  });

  const [postError, setPostError] = useState<string | null>(null);
  const postGroup = useMutation({
    mutationFn: (matchIds: string[]) =>
      api('/api/v1/transaction-matches/post', { method: 'POST', body: JSON.stringify({ matchIds }) }),
    onSuccess: () => {
      setPostError(null);
      qc.invalidateQueries({ queryKey: ['for-review'] });
      qc.invalidateQueries({ queryKey: ['transactions'] });
    },
    onError: (err: Error) => setPostError(err.message),
  });

  const acceptMatch = useMutation({
    mutationFn: (body: { transactionId: string; type: string; targetId: string; allocatedAmount: number }) =>
      api('/api/v1/transaction-matches', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['for-review'] }),
  });

  if (isLoading) return <div className="h-24 w-full animate-pulse rounded bg-slate-100" />;
  if (groups.length === 0) {
    return (
      <div className="text-center py-12 text-slate-400">
        <p className="text-base font-medium mb-1">All clear</p>
        <p className="text-sm">No transactions waiting for review.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {postError && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          Post failed: {postError}
        </div>
      )}
      {groups.map(group => {
        const pendingMatches   = group.matches.filter(m => m.status === 'pending');
        const suggestedMatches = group.matches.filter(m => m.status === 'suggested');
        const allPendingIds    = pendingMatches.map(m => m.matchId);
        const totalAllocated   = pendingMatches.reduce((s, m) => s + m.allocatedAmount, 0);
        const outstanding      = group.total - group.alreadyPaid;
        const remainingAfter   = outstanding - totalAllocated;
        const isFullyCovered   = remainingAfter <= 0;
        const progressPct      = outstanding > 0 ? Math.min(100, Math.round((totalAllocated / outstanding) * 100)) : 0;

        return (
          <div key={group.targetId} className="card overflow-hidden p-0">
            {/* Header */}
            <div className="p-4 border-b border-slate-100 bg-slate-50 flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className={`badge ${group.type === 'invoice' ? 'badge-green' : 'badge-blue'}`}>
                    {group.type}
                  </span>
                  <span className="font-semibold text-slate-900 truncate">{group.label}</span>
                </div>
                <div className="flex items-center gap-4 text-sm text-slate-600">
                  <span>Total: <strong>{formatPence(group.total)}</strong></span>
                  {group.alreadyPaid > 0 && <span>Paid: {formatPence(group.alreadyPaid)}</span>}
                  <span>Outstanding: <strong>{formatPence(outstanding)}</strong></span>
                  {group.dueDate && <span className="text-slate-400">Due {formatDate(group.dueDate)}</span>}
                </div>
                {totalAllocated > 0 && (
                  <div className="mt-2">
                    <div className="flex items-center justify-between text-xs text-slate-500 mb-1">
                      <span>Matched: {formatPence(totalAllocated)}</span>
                      <span className={isFullyCovered ? 'text-green-600 font-medium' : ''}>
                        {isFullyCovered ? 'Fully covered ✓' : `${formatPence(remainingAfter)} remaining`}
                      </span>
                    </div>
                    <div className="w-full bg-slate-200 rounded-full h-1.5">
                      <div
                        className={`h-1.5 rounded-full transition-all ${isFullyCovered ? 'bg-green-500' : 'bg-blue-500'}`}
                        style={{ width: `${progressPct}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>
              <button
                disabled={pendingMatches.length === 0 || postGroup.isPending}
                onClick={() => postGroup.mutate(allPendingIds)}
                className={`shrink-0 btn-primary text-sm ${pendingMatches.length === 0 ? 'opacity-40 cursor-not-allowed' : isFullyCovered ? 'bg-green-600 hover:bg-green-700' : ''}`}
              >
                {postGroup.isPending ? 'Posting…' : isFullyCovered ? 'Post payment' : `Post partial (${formatPence(totalAllocated)})`}
              </button>
            </div>

            {/* Pending matches */}
            {pendingMatches.length > 0 && (
              <ul className="divide-y divide-slate-50">
                {pendingMatches.map(m => (
                  <li key={m.matchId} className="flex items-center gap-3 px-4 py-3">
                    <div className="w-2 h-2 rounded-full bg-blue-500 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate text-slate-900">{m.description}</p>
                      <p className="text-xs text-slate-500">{formatDate(m.date)}{m.accountName ? ` · ${m.accountName}` : ''}</p>
                    </div>
                    <span className="text-sm font-medium text-blue-700 whitespace-nowrap">{formatPence(m.allocatedAmount)}</span>
                    <button onClick={() => removeMatch.mutate(m.matchId)} className="text-slate-300 hover:text-red-500 text-xs shrink-0">✕</button>
                  </li>
                ))}
              </ul>
            )}

            {/* Suggested matches */}
            {suggestedMatches.length > 0 && (
              <div className="bg-amber-50 border-t border-amber-100">
                <p className="px-4 py-2 text-xs font-medium text-amber-700 uppercase tracking-wide">
                  Suggested — review and accept
                </p>
                <ul className="divide-y divide-amber-100">
                  {suggestedMatches.map(m => (
                    <li key={m.matchId} className="flex items-center gap-3 px-4 py-3">
                      <div className="w-2 h-2 rounded-full bg-amber-400 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm truncate text-slate-900">{m.description}</p>
                        <p className="text-xs text-slate-500">{formatDate(m.date)}{m.accountName ? ` · ${m.accountName}` : ''}</p>
                      </div>
                      <span className="text-sm font-medium text-amber-700 whitespace-nowrap">{formatPence(m.allocatedAmount)}</span>
                      <div className="flex gap-2 shrink-0">
                        <button
                          onClick={() => acceptMatch.mutate({
                            transactionId: m.transactionId,
                            type: group.type,
                            targetId: group.targetId,
                            allocatedAmount: m.allocatedAmount,
                          })}
                          className="text-xs text-green-600 hover:underline font-medium"
                        >
                          Accept
                        </button>
                        <button onClick={() => removeMatch.mutate(m.matchId)} className="text-xs text-slate-400 hover:underline">
                          Dismiss
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <AddTransactionToGroup
              group={group}
              onAdd={(transactionId, allocatedAmount) =>
                acceptMatch.mutate({ transactionId, type: group.type, targetId: group.targetId, allocatedAmount })
              }
            />
          </div>
        );
      })}
    </div>
  );
}

type TxnResult = { id: string; description: string; date: string; amount: number };

function AddTransactionToGroup({
  group,
  onAdd,
}: {
  group: ReviewGroup;
  onAdd: (transactionId: string, allocatedAmount: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<TxnResult[]>([]);

  const search = async (query: string) => {
    setQ(query);
    if (!query) { setResults([]); return; }
    const data = await api<TxnResult[]>(`/api/v1/transactions?q=${encodeURIComponent(query)}&reconciled=0`);
    const existingTxnIds = new Set(group.matches.map(m => m.transactionId));
    setResults(data.filter(t => !existingTxnIds.has(t.id)));
  };

  if (!open) {
    return (
      <div className="px-4 py-2 border-t border-slate-100">
        <button onClick={() => setOpen(true)} className="text-xs text-blue-500 hover:underline">
          + Add another transaction to this {group.type}
        </button>
      </div>
    );
  }

  return (
    <div className="border-t border-slate-100 p-3 bg-slate-50">
      <input
        autoFocus
        value={q}
        onChange={e => search(e.target.value)}
        placeholder="Search by description or date…"
        className="input text-xs mb-2"
      />
      {results.length === 0 && q && <p className="text-xs text-slate-400 px-1">No results.</p>}
      <ul>
        {results.map(t => (
          <li key={t.id} className="flex items-center justify-between py-1.5 border-b border-slate-100 last:border-0">
            <div>
              <p className="text-xs font-medium text-slate-900">{t.description}</p>
              <p className="text-xs text-slate-500">{formatDate(t.date)} · {formatPence(Math.abs(t.amount))}</p>
            </div>
            <button
              onClick={() => { onAdd(t.id, Math.abs(t.amount)); setOpen(false); setQ(''); setResults([]); }}
              className="text-xs text-blue-600 hover:underline ml-3 shrink-0"
            >
              Add
            </button>
          </li>
        ))}
      </ul>
      <button onClick={() => { setOpen(false); setQ(''); setResults([]); }} className="text-xs text-slate-400 hover:underline mt-2">
        Cancel
      </button>
    </div>
  );
}
