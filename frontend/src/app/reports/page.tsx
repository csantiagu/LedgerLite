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

type AgedDebtors = {
  '0_30': number;
  '31_60': number;
  '61_90': number;
  '90_plus': number;
};

type CashFlowRow = {
  month: string;
  in: number;
  out: number;
  net: number;
};

type Tab = 'pl' | 'aged' | 'cashflow';

const TABS: { id: Tab; label: string }[] = [
  { id: 'pl', label: 'P&L' },
  { id: 'aged', label: 'Aged Debtors' },
  { id: 'cashflow', label: 'Cash Flow' },
];

function formatMonth(ym: string) {
  const [year, month] = ym.split('-');
  return new Date(parseInt(year), parseInt(month) - 1, 1).toLocaleDateString('en-GB', {
    month: 'short',
    year: 'numeric',
  });
}

export default function ReportsPage() {
  return (
    <AppShell>
      <ReportsContent />
    </AppShell>
  );
}

function ReportsContent() {
  const [activeTab, setActiveTab] = useState<Tab>('pl');
  const today = useMemo(() => new Date(), []);
  const [from, setFrom] = useState(() => {
    const year = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1;
    return `${year}-04-06`;
  });
  const [to, setTo] = useState(() => today.toISOString().slice(0, 10));

  const { data: pl, isLoading: plLoading, isError: plError, error: plErr } = useQuery<PlResponse>({
    queryKey: ['reports-pl', from, to],
    queryFn: () => api<PlResponse>(`/api/v1/reports/pl?from=${from}&to=${to}`),
    enabled: activeTab === 'pl' && !!from && !!to,
  });

  const { data: aged, isLoading: agedLoading } = useQuery<AgedDebtors>({
    queryKey: ['reports-aged'],
    queryFn: () => api<AgedDebtors>('/api/v1/reports/aged-debtors'),
    enabled: activeTab === 'aged',
  });

  const { data: cashflow, isLoading: cfLoading } = useQuery<CashFlowRow[]>({
    queryKey: ['reports-cashflow', from, to],
    queryFn: () => api<CashFlowRow[]>(`/api/v1/reports/cash-flow?from=${from}&to=${to}`),
    enabled: activeTab === 'cashflow' && !!from && !!to,
  });

  const showDateRange = activeTab !== 'aged';
  const agedTotal = aged
    ? aged['0_30'] + aged['31_60'] + aged['61_90'] + aged['90_plus']
    : 0;
  const agedMax = aged
    ? Math.max(aged['0_30'], aged['31_60'], aged['61_90'], aged['90_plus'], 1)
    : 1;
  const cfMax = cashflow?.length
    ? Math.max(...cashflow.map((r) => Math.abs(r.net)), 1)
    : 1;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Reports</h1>
          <p className="mt-1 text-sm text-slate-500">Financial summaries and analysis.</p>
        </div>
        <Link href="/reports/year-end" className="btn-secondary">
          Year-end export
        </Link>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 rounded-lg bg-slate-100 p-1 w-fit">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            aria-selected={activeTab === tab.id}
            role="tab"
            className={[
              'px-4 py-1.5 rounded-md text-sm font-medium transition-all duration-150 cursor-pointer',
              activeTab === tab.id
                ? 'bg-white text-slate-900 shadow-sm'
                : 'text-slate-500 hover:text-slate-700',
            ].join(' ')}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Date range — hidden for aged debtors */}
      {showDateRange && (
        <div className="card">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-xl">
            <div>
              <label className="field-label">From</label>
              <input
                type="date"
                className="input"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>
            <div>
              <label className="field-label">To</label>
              <input
                type="date"
                className="input"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
          </div>
        </div>
      )}

      {/* ── P&L TAB ── */}
      {activeTab === 'pl' && (
        <>
          {plLoading && <div className="h-48 rounded-xl bg-slate-100 animate-pulse" />}
          {plError && (
            <p className="text-sm text-red-600" role="alert">
              {(plErr as Error).message}
            </p>
          )}
          {pl && (
            <div className="space-y-4">
              {/* KPI cards */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="card border-l-4 border-l-green-500">
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">
                    Total income
                  </p>
                  <p className="mt-2 text-2xl font-bold tabular-nums text-green-700">
                    {formatPence(pl.totalIncome)}
                  </p>
                </div>
                <div className="card border-l-4 border-l-red-400">
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">
                    Total expenses
                  </p>
                  <p className="mt-2 text-2xl font-bold tabular-nums text-red-600">
                    {formatPence(pl.totalExpenses)}
                  </p>
                </div>
                <div
                  className={`card border-l-4 ${pl.net >= 0 ? 'border-l-blue-500' : 'border-l-orange-500'}`}
                >
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">
                    Net profit
                  </p>
                  <p
                    className={`mt-2 text-2xl font-bold tabular-nums ${
                      pl.net >= 0 ? 'text-blue-700' : 'text-orange-600'
                    }`}
                  >
                    {formatPence(pl.net)}
                  </p>
                </div>
              </div>

              {/* Income */}
              <div className="card">
                <h2 className="text-base font-semibold text-green-700 mb-3">Income</h2>
                {pl.income.length === 0 ? (
                  <p className="py-6 text-center text-sm text-slate-500">
                    No income recorded for this period.
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-slate-100">
                          <th className="text-left pb-2 text-xs uppercase tracking-wide text-slate-500">
                            Client
                          </th>
                          <th className="text-right pb-2 text-xs uppercase tracking-wide text-slate-500">
                            Total received
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {pl.income.map((row) => (
                          <tr
                            key={row.client_name}
                            className="border-t border-slate-50 hover:bg-slate-50/50"
                          >
                            <td className="py-2.5">{row.client_name}</td>
                            <td className="py-2.5 text-right tabular-nums font-medium">
                              {formatPence(row.total)}
                            </td>
                          </tr>
                        ))}
                        <tr className="border-t-2 border-slate-200 font-semibold">
                          <td className="py-2.5">Total income</td>
                          <td className="py-2.5 text-right tabular-nums text-green-700">
                            {formatPence(pl.totalIncome)}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Expenses */}
              <div className="card">
                <h2 className="text-base font-semibold text-red-700 mb-3">Expenses</h2>
                {pl.expenses.length === 0 ? (
                  <p className="py-6 text-center text-sm text-slate-500">
                    No expenses recorded for this period.
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-slate-100">
                          <th className="text-left pb-2 text-xs uppercase tracking-wide text-slate-500">
                            Category
                          </th>
                          <th className="text-right pb-2 text-xs uppercase tracking-wide text-slate-500">
                            Total
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {pl.expenses.map((row) => (
                          <tr
                            key={row.category}
                            className="border-t border-slate-50 hover:bg-slate-50/50"
                          >
                            <td className="py-2.5">{row.category}</td>
                            <td className="py-2.5 text-right tabular-nums font-medium">
                              {formatPence(row.total)}
                            </td>
                          </tr>
                        ))}
                        <tr className="border-t-2 border-slate-200 font-semibold">
                          <td className="py-2.5">Total expenses</td>
                          <td className="py-2.5 text-right tabular-nums text-red-700">
                            {formatPence(pl.totalExpenses)}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {/* ── AGED DEBTORS TAB ── */}
      {activeTab === 'aged' && (
        <>
          {agedLoading && <div className="h-48 rounded-xl bg-slate-100 animate-pulse" />}
          {aged && (
            <div className="space-y-4">
              <p className="text-sm text-slate-500">
                Outstanding invoice balances by days overdue, as of today.
              </p>

              {/* Bucket cards */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                {(
                  [
                    { label: '0–30 days', key: '0_30', borderColor: 'border-l-green-500', textColor: 'text-green-700' },
                    { label: '31–60 days', key: '31_60', borderColor: 'border-l-amber-400', textColor: 'text-amber-700' },
                    { label: '61–90 days', key: '61_90', borderColor: 'border-l-orange-500', textColor: 'text-orange-700' },
                    { label: '90+ days', key: '90_plus', borderColor: 'border-l-red-500', textColor: 'text-red-700' },
                  ] as const
                ).map(({ label, key, borderColor, textColor }) => (
                  <div key={key} className={`card border-l-4 ${borderColor}`}>
                    <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">
                      {label}
                    </p>
                    <p className={`mt-2 text-xl font-bold tabular-nums ${textColor}`}>
                      {formatPence(aged[key])}
                    </p>
                  </div>
                ))}
              </div>

              {/* Total row */}
              {agedTotal > 0 && (
                <div className="card flex justify-between items-center">
                  <span className="text-sm font-semibold text-slate-700">Total outstanding</span>
                  <span className="text-xl font-bold tabular-nums text-slate-900">
                    {formatPence(agedTotal)}
                  </span>
                </div>
              )}

              {/* Distribution bar chart */}
              {agedTotal > 0 ? (
                <div className="card space-y-3">
                  <h3 className="text-sm font-semibold text-slate-700 mb-1">Distribution</h3>
                  {(
                    [
                      { label: '0–30 days', key: '0_30', barColor: 'bg-green-400' },
                      { label: '31–60 days', key: '31_60', barColor: 'bg-amber-400' },
                      { label: '61–90 days', key: '61_90', barColor: 'bg-orange-400' },
                      { label: '90+ days', key: '90_plus', barColor: 'bg-red-400' },
                    ] as const
                  ).map(({ label, key, barColor }) => (
                    <div key={key} className="flex items-center gap-3">
                      <span className="text-xs text-slate-500 w-20 shrink-0">{label}</span>
                      <div className="flex-1 h-5 rounded bg-slate-100 overflow-hidden">
                        <div
                          className={`h-full rounded transition-all duration-500 ${barColor}`}
                          style={{ width: `${Math.round((aged[key] / agedMax) * 100)}%` }}
                          role="progressbar"
                          aria-valuenow={aged[key]}
                          aria-valuemin={0}
                          aria-valuemax={agedMax}
                          aria-label={`${label}: ${formatPence(aged[key])}`}
                        />
                      </div>
                      <span className="text-xs tabular-nums text-slate-700 w-20 text-right shrink-0">
                        {formatPence(aged[key])}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="card py-8 text-center">
                  <p className="text-slate-500 text-sm">No outstanding invoices. All caught up!</p>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* ── CASH FLOW TAB ── */}
      {activeTab === 'cashflow' && (
        <>
          {cfLoading && <div className="h-48 rounded-xl bg-slate-100 animate-pulse" />}
          {cashflow && (
            <div className="space-y-4">
              {cashflow.length === 0 ? (
                <div className="card py-8 text-center">
                  <p className="text-sm text-slate-500">No payments recorded for this period.</p>
                </div>
              ) : (
                <>
                  {/* Net cash flow bar chart */}
                  <div className="card space-y-3">
                    <h3 className="text-sm font-semibold text-slate-700 mb-1">
                      Net cash flow by month
                    </h3>
                    {cashflow.map((row) => {
                      const positive = row.net >= 0;
                      const pct = Math.round((Math.abs(row.net) / cfMax) * 100);
                      return (
                        <div key={row.month} className="flex items-center gap-3">
                          <span className="text-xs text-slate-500 w-16 shrink-0">
                            {formatMonth(row.month)}
                          </span>
                          <div className="flex-1 h-5 rounded bg-slate-100 overflow-hidden">
                            <div
                              className={`h-full rounded transition-all duration-500 ${
                                positive ? 'bg-blue-400' : 'bg-red-400'
                              }`}
                              style={{ width: `${pct}%` }}
                              role="progressbar"
                              aria-valuenow={row.net}
                              aria-valuemin={-cfMax}
                              aria-valuemax={cfMax}
                              aria-label={`${formatMonth(row.month)}: ${formatPence(row.net)}`}
                            />
                          </div>
                          <span
                            className={`text-xs tabular-nums w-20 text-right shrink-0 font-medium ${
                              positive ? 'text-blue-700' : 'text-red-600'
                            }`}
                          >
                            {positive ? '' : '−'}
                            {formatPence(Math.abs(row.net))}
                          </span>
                        </div>
                      );
                    })}
                  </div>

                  {/* Monthly breakdown table */}
                  <div className="card">
                    <h3 className="text-sm font-semibold text-slate-700 mb-3">
                      Monthly breakdown
                    </h3>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-slate-100">
                            <th className="text-left pb-2 text-xs uppercase tracking-wide text-slate-500">
                              Month
                            </th>
                            <th className="text-right pb-2 text-xs uppercase tracking-wide text-slate-500">
                              Money in
                            </th>
                            <th className="text-right pb-2 text-xs uppercase tracking-wide text-slate-500">
                              Money out
                            </th>
                            <th className="text-right pb-2 text-xs uppercase tracking-wide text-slate-500">
                              Net
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {cashflow.map((row) => (
                            <tr
                              key={row.month}
                              className="border-t border-slate-50 hover:bg-slate-50/50"
                            >
                              <td className="py-2.5 font-medium">{formatMonth(row.month)}</td>
                              <td className="py-2.5 text-right tabular-nums text-green-700">
                                {formatPence(row.in)}
                              </td>
                              <td className="py-2.5 text-right tabular-nums text-red-600">
                                {formatPence(row.out)}
                              </td>
                              <td
                                className={`py-2.5 text-right tabular-nums font-semibold ${
                                  row.net >= 0 ? 'text-blue-700' : 'text-red-600'
                                }`}
                              >
                                {formatPence(row.net)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
