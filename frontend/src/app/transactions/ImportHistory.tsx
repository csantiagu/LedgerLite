'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { formatDate, formatDateTime, formatPence } from '@/lib/formatters';

type BankImport = {
  id: string;
  filename: string;
  row_count: number;
  new_row_count: number;
  imported_at: string;
  imported_by_name: string;
  undone_at: string | null;
  undone_by_name: string | null;
  first_date: string | null;
  last_date: string | null;
};

type Blocked = { id: string; date: string; description: string; amount: number; reasons: string[] };

/** The account's recent statement imports, with Undo for one brought in by mistake. */
export function ImportHistory({ accountId, owner }: { accountId: string; owner: boolean }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ id: string; error: string; blocked: Blocked[] } | null>(null);

  const { data: imports = [], isLoading } = useQuery({
    queryKey: ['bank-imports', accountId],
    queryFn: () => api<BankImport[]>(`/api/v1/bank-imports?bankAccountId=${encodeURIComponent(accountId)}`),
  });

  const undo = useMutation({
    mutationFn: (id: string) =>
      api<{ ok: true; removed: number }>(`/api/v1/bank-imports/${id}/undo`, { method: 'POST' }),
    onSuccess: () => {
      setConfirm(null);
      setProblem(null);
      qc.invalidateQueries({ queryKey: ['bank-imports', accountId] });
      qc.invalidateQueries({ queryKey: ['transactions'] });
      qc.invalidateQueries({ queryKey: ['review-counts'] });
      qc.invalidateQueries({ queryKey: ['account-balance', accountId] });
    },
    onError: (err: Error, id) => {
      setConfirm(null);
      // A refusal lists the lines that have been worked on
      const blocked = err instanceof ApiError ? (err.body as { blocked?: Blocked[] }).blocked ?? [] : [];
      setProblem({ id, error: err.message, blocked });
    },
  });

  if (isLoading) return <p className="text-sm text-slate-500">Loading imports…</p>;
  if (!imports.length) return <p className="text-sm text-slate-500">No statements imported into this account yet.</p>;

  return (
    <ul className="divide-y divide-slate-100 text-sm">
      {imports.map(imp => (
        <li key={imp.id} className="py-2 space-y-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <p className={`font-medium break-all ${imp.undone_at ? 'text-slate-400 line-through' : 'text-slate-800'}`}>{imp.filename}</p>
              <p className="text-xs text-slate-500">
                {formatDateTime(imp.imported_at)} · {imp.imported_by_name}
                {imp.first_date && imp.last_date && ` · lines ${formatDate(imp.first_date)} – ${formatDate(imp.last_date)}`}
                {` · ${imp.new_row_count} new of ${imp.row_count}`}
              </p>
              {imp.undone_at && (
                <p className="text-xs text-slate-500">Undone {formatDateTime(imp.undone_at)}{imp.undone_by_name ? ` by ${imp.undone_by_name}` : ''}</p>
              )}
            </div>
            {owner && !imp.undone_at && (
              confirm === imp.id ? (
                <span className="flex items-center gap-2">
                  <span className="text-xs text-amber-800">Remove its {imp.new_row_count} lines?</span>
                  <button type="button" className="btn-danger text-xs px-2 py-1" disabled={undo.isPending} onClick={() => undo.mutate(imp.id)}>
                    {undo.isPending ? 'Undoing…' : 'Undo import'}
                  </button>
                  <button type="button" className="btn-secondary text-xs px-2 py-1" onClick={() => setConfirm(null)}>Cancel</button>
                </span>
              ) : (
                <button type="button" className="btn-secondary text-xs px-2 py-1" onClick={() => { setProblem(null); setConfirm(imp.id); }}>
                  Undo…
                </button>
              )
            )}
          </div>
          {problem?.id === imp.id && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900" role="alert">
              <p>{problem.error}</p>
              {problem.blocked.length > 0 && (
                <ul className="mt-1 list-disc pl-4">
                  {problem.blocked.slice(0, 10).map(b => (
                    <li key={b.id}>
                      {formatDate(b.date)} {b.description} ({formatPence(b.amount)}): {b.reasons.join(', ')}
                    </li>
                  ))}
                  {problem.blocked.length > 10 && <li>and {problem.blocked.length - 10} more</li>}
                </ul>
              )}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
