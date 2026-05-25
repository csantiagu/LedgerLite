'use client';

import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppShell } from '@/components/layout/AppShell';
import { api } from '@/lib/api';
import { useAuthStore } from '@/lib/auth';
import { formatDate, formatPence } from '@/lib/formatters';

const BANK_FORMATS = ['barclays', 'hsbc', 'lloyds', 'natwest', 'monzo', 'starling'] as const;

type Txn = {
  id: string;
  date: string;
  description: string;
  amount: number;
  expense_category_id: string | null;
  category_name?: string | null;
  matched_invoice_id: string | null;
  matched_bill_id: string | null;
  is_reconciled: number;
  flagged: number;
  notes: string | null;
  accountant_notes: string | null;
};

type Category = { id: string; name: string };

export default function TransactionsPage() {
  return (
    <AppShell>
      <TransactionsContent />
    </AppShell>
  );
}

function TransactionsContent() {
  const role = useAuthStore(s => s.role);
  const token = useAuthStore(s => s.accessToken);
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [bankFormat, setBankFormat] = useState<(typeof BANK_FORMATS)[number]>('monzo');
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState('');

  const { data: txns = [] } = useQuery<Txn[]>({
    queryKey: ['transactions'],
    queryFn: () => api<Txn[]>('/api/v1/transactions'),
  });

  const { data: categories = [] } = useQuery<Category[]>({
    queryKey: ['expense-categories'],
    queryFn: () => api<Category[]>('/api/v1/expense-categories'),
  });

  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api(`/api/v1/transactions/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['transactions'] }),
  });

  const uploadCSV = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file || !token) return;
    setUploading(true);
    setUploadMsg('');
    const fd = new FormData();
    fd.append('file', file);
    fd.append('format', bankFormat);
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/bank-imports`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Requested-With': 'XMLHttpRequest',
        },
        credentials: 'include',
        body: fd,
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || 'Import failed');
      setUploadMsg(`Imported ${payload.rowCount ?? 0} new transactions.`);
      qc.invalidateQueries({ queryKey: ['transactions'] });
    } catch (err) {
      setUploadMsg((err as Error).message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Bank transactions</h1>
        <p className="mt-1 text-sm text-slate-500">Import CSVs, categorise entries, and reconcile activity.</p>
      </div>

      {role === 'owner' && (
        <div className="card flex flex-wrap items-center gap-3">
          <select value={bankFormat} onChange={e => setBankFormat(e.target.value as (typeof BANK_FORMATS)[number])} className="input max-w-52">
            {BANK_FORMATS.map(f => <option key={f} value={f}>{f.charAt(0).toUpperCase() + f.slice(1)}</option>)}
          </select>
          <input ref={fileRef} type="file" accept=".csv,text/csv" className="text-sm" />
          <button onClick={uploadCSV} disabled={uploading} className="btn-primary">
            {uploading ? 'Importing…' : 'Import CSV'}
          </button>
          {uploadMsg && <p className="text-sm text-slate-600">{uploadMsg}</p>}
        </div>
      )}

      <div className="card overflow-auto p-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50">
            <tr>
              {['Date', 'Description', 'Amount', 'Category', 'Match', 'Reconciled', 'Flag', 'Notes'].map(h =>
                <th key={h} className="p-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 whitespace-nowrap">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {txns.map((t) => (
              <tr key={t.id} className={`border-t ${t.flagged ? 'bg-amber-50' : 'hover:bg-slate-50'}`}>
                <td className="p-3 whitespace-nowrap">{formatDate(t.date)}</td>
                <td className="p-3 max-w-xs truncate">{t.description}</td>
                <td className={`p-3 font-medium whitespace-nowrap ${t.amount < 0 ? 'text-red-600' : 'text-green-600'}`}>
                  {t.amount < 0 ? '-' : '+'}{formatPence(Math.abs(t.amount))}
                </td>
                <td className="p-3">
                  {role === 'owner' ? (
                    <select
                      value={t.expense_category_id ?? ''}
                      onChange={e => patch.mutate({ id: t.id, body: { expenseCategoryId: e.target.value || null } })}
                      className="input py-1 text-xs max-w-48"
                    >
                      <option value="">— none —</option>
                      {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  ) : (
                    <span className="text-xs text-slate-500">{t.category_name ?? '—'}</span>
                  )}
                </td>
                <td className="p-3 text-xs">
                  {t.matched_invoice_id && <span className="text-green-600">Invoice</span>}
                  {t.matched_bill_id && <span className="text-blue-600">Bill</span>}
                  {!t.matched_invoice_id && !t.matched_bill_id && '—'}
                </td>
                <td className="p-3 text-center">
                  {role === 'owner'
                    ? <input type="checkbox" checked={!!t.is_reconciled}
                        onChange={e => patch.mutate({ id: t.id, body: { isReconciled: e.target.checked } })} />
                    : (t.is_reconciled ? '✓' : '—')}
                </td>
                <td className="p-3 text-center">
                  {role === 'accountant' ? (
                    <input
                      type="checkbox"
                      checked={!!t.flagged}
                      onChange={e => patch.mutate({ id: t.id, body: { flagged: e.target.checked } })}
                    />
                  ) : (
                    t.flagged ? '✓' : '—'
                  )}
                </td>
                <td className="p-3">
                  <input
                    className="border-b border-transparent hover:border-slate-300 focus:border-slate-400 text-xs w-36 bg-transparent outline-none"
                    defaultValue={role === 'owner' ? (t.notes ?? '') : (t.accountant_notes ?? '')}
                    onBlur={e => {
                      const key = role === 'owner' ? 'notes' : 'accountantNotes';
                      patch.mutate({ id: t.id, body: { [key]: e.target.value } });
                    }}
                  />
                </td>
              </tr>
            ))}
            {txns.length === 0 && (
              <tr>
                <td colSpan={8} className="p-8 text-center text-sm text-slate-500">No transactions imported yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
