'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { AppShell } from '@/components/layout/AppShell';
import { api } from '@/lib/api';
import { formatPence } from '@/lib/formatters';

type PlResponse = {
  income: Array<{ client_name: string; total: number }>;
  expenses: Array<{ category: string; total: number }>;
  totalIncome: number;
  totalExpenses: number;
  net: number;
};

export default function ReportsPage() {
  return (
    <AppShell>
      <ReportsContent />
    </AppShell>
  );
}

function ReportsContent() {
  const today = useMemo(() => new Date(), []);
  const [from, setFrom] = useState(() => {
    const year = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1;
    return `${year}-04-06`;
  });
  const [to, setTo] = useState(() => today.toISOString().slice(0, 10));

  const { data: pl, isLoading, isError, error } = useQuery<PlResponse>({
    queryKey: ['reports-pl', from, to],
    queryFn: () => api<PlResponse>(`/api/v1/reports/pl?from=${from}&to=${to}`),
    enabled: !!from && !!to,
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Profit &amp; Loss</h1>
          <p className="mt-1 text-sm text-slate-500">Income and expenses for your selected period.</p>
        </div>
        <Link href="/reports/year-end" className="btn-secondary">Year-end export</Link>
      </div>

      <div className="card">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-xl">
          <div>
            <label className="field-label">From</label>
            <input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <label className="field-label">To</label>
            <input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>
      </div>

      {isLoading && <div className="h-40 rounded bg-slate-100 animate-pulse" />}
      {isError && <p className="text-sm text-red-600">{(error as Error).message}</p>}

      {pl && (
        <div className="space-y-6">
          <div className="card">
            <h2 className="text-base font-semibold text-green-700 mb-3">Income</h2>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100">
                  <th className="text-left pb-2 text-xs uppercase tracking-wide text-slate-500">Client</th>
                  <th className="text-right pb-2 text-xs uppercase tracking-wide text-slate-500">Total</th>
                </tr>
              </thead>
              <tbody>
                {pl.income.map((row) => (
                  <tr key={row.client_name} className="border-t border-slate-50">
                    <td className="py-2">{row.client_name}</td>
                    <td className="py-2 text-right tabular-nums">{formatPence(row.total)}</td>
                  </tr>
                ))}
                <tr className="border-t border-slate-200 font-semibold">
                  <td className="py-2">Total income</td>
                  <td className="py-2 text-right tabular-nums text-green-700">{formatPence(pl.totalIncome)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="card">
            <h2 className="text-base font-semibold text-red-700 mb-3">Expenses</h2>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100">
                  <th className="text-left pb-2 text-xs uppercase tracking-wide text-slate-500">Category</th>
                  <th className="text-right pb-2 text-xs uppercase tracking-wide text-slate-500">Total</th>
                </tr>
              </thead>
              <tbody>
                {pl.expenses.map((row) => (
                  <tr key={row.category} className="border-t border-slate-50">
                    <td className="py-2">{row.category}</td>
                    <td className="py-2 text-right tabular-nums">{formatPence(row.total)}</td>
                  </tr>
                ))}
                <tr className="border-t border-slate-200 font-semibold">
                  <td className="py-2">Total expenses</td>
                  <td className="py-2 text-right tabular-nums text-red-700">{formatPence(pl.totalExpenses)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="card flex justify-between items-center">
            <span className="text-lg font-bold text-slate-900">Net profit</span>
            <span className={`text-2xl font-bold tabular-nums ${pl.net >= 0 ? 'text-green-700' : 'text-red-700'}`}>
              {formatPence(pl.net)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
