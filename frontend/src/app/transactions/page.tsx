'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { AppShell } from '@/components/layout/AppShell';
import { api, API_BASE } from '@/lib/api';
import { useAuthStore } from '@/lib/auth';
import { formatDate, formatPence } from '@/lib/formatters';
import { parsePence } from '@/lib/quickbooksImport';
import { ReviewTab } from './ReviewTab';
import { ImportHistory } from './ImportHistory';
import { importSummary, type ImportResult } from '@/lib/bankImport';
import { AllTransactionsTab, EMPTY_FILTERS, type AllFilters } from './AllTransactionsTab';
import { compactControl, type Category } from './shared';

type BankAccount = {
  id: string;
  name: string;
  bank_name: string;
  last_four: string | null;
};

type Balance = {
  total_credits: number | null;
  total_debits: number | null;
  net: number | null;
  transaction_count: number;
  earliest_date: string | null;
  latest_date: string | null;
  last_known_balance: number | null;
  opening_balance: number;
  computed_balance: number;
};

type InnerTab = 'review' | 'all';

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

  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [innerTab, setInnerTab] = useState<InnerTab>('review');
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState('');
  const [showImports, setShowImports] = useState(false);
  const [reviewRange, setReviewRange] = useState<{ from: string | null; to: string | null }>({ from: null, to: null });
  const [allFilters, setAllFilters] = useState<AllFilters>(EMPTY_FILTERS);

  // Deep links from the export page: ?unexplained=1&from&to opens For Review for that period;
  // ?noReceipt=1&from&to lists that period's payments without a receipt
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const from = p.get('from');
    const to = p.get('to');
    if (p.get('noReceipt') === '1') {
      setAllFilters({ ...EMPTY_FILTERS, receipt: 'missing', status: 'all', from: from ?? '', to: to ?? '' });
      setInnerTab('all');
    } else if (p.get('unexplained') === '1') {
      setReviewRange({ from, to });
      setInnerTab('review');
    }
  }, []);

  const { data: accounts = [] } = useQuery<BankAccount[]>({
    queryKey: ['bank-accounts'],
    queryFn: () => api<BankAccount[]>('/api/v1/bank-accounts'),
  });

  const { data: reviewCounts = {}, isSuccess: countsLoaded } = useQuery<Record<string, number>>({
    queryKey: ['review-counts'],
    queryFn: () => api<Record<string, number>>('/api/v1/transactions/review-counts'),
  });

  // Start on the first account, or the first with lines waiting when arriving from the export page
  const pickedAccount = useRef(false);
  useEffect(() => {
    if (pickedAccount.current || accounts.length === 0) return;
    const fromExport = !!(reviewRange.from || reviewRange.to);
    if (fromExport && !countsLoaded) return;
    pickedAccount.current = true;
    const waiting = fromExport ? accounts.find(a => reviewCounts[a.id]) : undefined;
    setSelectedAccountId((waiting ?? accounts[0]).id);
  }, [accounts, reviewCounts, countsLoaded, reviewRange]);

  const activeAccount = accounts.find(a => a.id === selectedAccountId);

  const { data: balance } = useQuery<Balance>({
    queryKey: ['account-balance', selectedAccountId],
    queryFn: () => api<Balance>(`/api/v1/bank-accounts/${selectedAccountId}/balance`),
    enabled: !!selectedAccountId,
  });

  const { data: categories = [] } = useQuery<Category[]>({
    queryKey: ['expense-categories'],
    queryFn: () => api<Category[]>('/api/v1/expense-categories'),
  });

  const uploadCSV = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file || !selectedAccountId || !token) return;
    setUploading(true);
    setUploadMsg('');
    const fd = new FormData();
    fd.append('file', file);
    fd.append('bankAccountId', selectedAccountId);
    try {
      const res = await fetch(`${API_BASE}/api/v1/bank-imports`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' },
        credentials: 'include',
        body: fd,
      });
      const payload = await res.json().catch(() => ({})) as ImportResult & { error?: string };
      if (!res.ok) throw new Error(payload.error || 'Import failed');
      setUploadMsg(importSummary(payload));
      qc.invalidateQueries({ queryKey: ['bank-imports', selectedAccountId] });
      if (payload.openingBalanceSet) qc.invalidateQueries({ queryKey: ['bank-accounts'] });
      if (fileRef.current) fileRef.current.value = '';
      qc.invalidateQueries({ queryKey: ['transactions'] });
      qc.invalidateQueries({ queryKey: ['review-counts'] });
      qc.invalidateQueries({ queryKey: ['account-balance', selectedAccountId] });
      setInnerTab('review');
    } catch (err) {
      setUploadMsg((err as Error).message);
    } finally {
      setUploading(false);
    }
  };

  const reviewCount = selectedAccountId ? reviewCounts[selectedAccountId] ?? 0 : 0;
  const tabClass = (active: boolean) => `px-3 py-1.5 text-sm font-medium border-b-2 transition-colors ${
    active ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-800'
  }`;
  const countBadge = (n: number) => n > 0 && (
    <span className="ml-1.5 inline-flex items-center justify-center min-w-5 h-5 px-1 rounded-full bg-amber-100 text-amber-700 text-xs font-semibold">
      {n}
    </span>
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
        <h1 className="text-xl font-bold text-slate-900" title="Import statements, review each line, then post it to your books.">
          Bank transactions
        </h1>
        {accounts.length > 0 && (
          <div className="flex gap-1">
            {accounts.map(a => (
              <button key={a.id} onClick={() => setSelectedAccountId(a.id)} className={tabClass(a.id === selectedAccountId)}>
                {a.name}
                {a.last_four && <span className="ml-1 text-xs text-slate-400">···{a.last_four}</span>}
                {countBadge(reviewCounts[a.id] ?? 0)}
              </button>
            ))}
          </div>
        )}
      </div>

      {accounts.length === 0 && (
        <div className="card border-amber-200 bg-amber-50 text-sm text-amber-800">
          No bank accounts registered yet.{' '}
          {role === 'owner' ? (
            <Link href="/settings/bank-accounts" className="font-medium underline">
              Add one in Settings → Bank accounts
            </Link>
          ) : 'Ask the owner to add bank accounts in Settings.'}
        </div>
      )}

      {selectedAccountId && activeAccount && (
        <>
          {/* Balance summary + CSV upload, one line */}
          <div className="card px-4 py-2.5 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
            <div
              className="flex items-baseline gap-2"
              title={`Opening ${formatPence(balance?.opening_balance ?? 0)} + movements ${formatPence(balance?.net ?? 0)}`}
            >
              <span className="text-xs text-slate-500">Balance</span>
              <span className="text-base font-bold text-slate-900 tabular-nums">
                {balance ? formatPence(balance.computed_balance ?? 0) : '—'}
              </span>
            </div>
            <span className="text-xs text-slate-500">
              {balance?.transaction_count ?? 0} txns
              {balance?.earliest_date && balance?.latest_date
                ? ` · ${formatDate(balance.earliest_date)} – ${formatDate(balance.latest_date)}`
                : ''}
              {balance?.last_known_balance != null && ` · last CSV balance ${formatPence(balance.last_known_balance)}`}
            </span>

            {role === 'owner' && (balance?.transaction_count ?? 0) > 0 && (
              <BalanceCheck computedBalance={balance?.computed_balance ?? 0} />
            )}

            {role === 'owner' && (
              <div className="flex items-center gap-2 ml-auto">
                {uploadMsg && <p className="text-xs text-slate-600" role="status">{uploadMsg}</p>}
                <input ref={fileRef} type="file" accept=".csv,text/csv" className="sr-only" onChange={uploadCSV} />
                <button
                  type="button"
                  onClick={() => setShowImports(v => !v)}
                  aria-expanded={showImports}
                  className={`btn-secondary whitespace-nowrap ${compactControl}`}
                >
                  Imports
                </button>
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  disabled={uploading}
                  className={`btn-primary whitespace-nowrap ${compactControl}`}
                >
                  {uploading ? 'Importing…' : `Import ${activeAccount.bank_name} CSV`}
                </button>
              </div>
            )}
          </div>

          {showImports && (
            <div className="card">
              <h2 className="text-sm font-semibold text-slate-900 mb-2">Statement imports</h2>
              <ImportHistory accountId={selectedAccountId} owner={role === 'owner'} />
            </div>
          )}

          <div className="flex gap-1 border-b border-slate-200">
            <button onClick={() => setInnerTab('review')} className={tabClass(innerTab === 'review')}>
              For Review{countBadge(reviewCount)}
            </button>
            <button onClick={() => setInnerTab('all')} className={tabClass(innerTab === 'all')}>
              All Transactions
            </button>
          </div>

          {innerTab === 'review' ? (
            <ReviewTab
              accountId={selectedAccountId}
              role={role}
              token={token}
              categories={categories}
              range={reviewRange}
              onClearRange={() => setReviewRange({ from: null, to: null })}
            />
          ) : (
            <AllTransactionsTab
              accountId={selectedAccountId}
              role={role}
              token={token}
              categories={categories}
              initialFilters={allFilters}
            />
          )}
        </>
      )}
    </div>
  );
}

function BalanceCheck({ computedBalance }: { computedBalance: number }) {
  const [actual, setActual] = useState('');
  // Parsed as text into pence, never through a float
  const parsed = actual ? parsePence(actual) : null;
  const actualPence = parsed === null || Number.isNaN(parsed) ? null : parsed;
  const diff = actualPence !== null ? actualPence - computedBalance : null;

  return (
    <div className="flex items-center gap-2 border-l border-slate-200 pl-5">
      <label htmlFor="balance-check" className="text-xs text-slate-500" title="Enter the balance from your bank's online portal">
        Bank says
      </label>
      <div className="flex items-center gap-1">
        <span className="text-sm text-slate-500">£</span>
        <input
          id="balance-check"
          inputMode="decimal"
          placeholder="0.00"
          value={actual}
          onChange={e => setActual(e.target.value)}
          className={`input w-28 ${compactControl}`}
        />
      </div>
      {diff !== null && (
        <p className={`text-xs font-medium ${Math.abs(diff) < 1 ? 'text-green-600' : 'text-red-600'}`}>
          {Math.abs(diff) < 1
            ? '✓ Balances match'
            : `Gap: ${diff > 0 ? '+' : ''}${formatPence(diff)} — check opening balance or missing imports`}
        </p>
      )}
    </div>
  );
}
