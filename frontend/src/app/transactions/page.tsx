'use client';

import { Fragment, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { AppShell } from '@/components/layout/AppShell';
import { MatchPanel } from '@/components/MatchPanel';
import { ForReviewPanel } from './ForReviewPanel';
import { api, API_BASE } from '@/lib/api';
import { useAuthStore } from '@/lib/auth';
import { formatDate, formatPence } from '@/lib/formatters';

type BankAccount = {
  id: string;
  name: string;
  bank_name: string;
  last_four: string | null;
};

type Txn = {
  id: string;
  bank_account_id: string;
  date: string;
  description: string;
  amount: number;
  expense_category_id: string | null;
  category_name?: string | null;
  is_reconciled: number;
  flagged: number;
  notes: string | null;
  accountant_notes: string | null;
  attachment_r2_key: string | null;
  attachment_filename: string | null;
  categorised_by_rule_id: string | null;
  match_status?: 'suggested' | 'pending' | 'posted' | null;
  match_label?: string | null;
};

type Category = { id: string; name: string };

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

type Filter = { unexplained: boolean; noReceipt: boolean; from: string | null; to: string | null };

// "HMRC VAT 123456789 DD" → "HMRC VAT", "STARLING ACCOUNT , TRANSFER , ..." → "STARLING ACCOUNT":
// up to 3 leading words of the first comma-separated part, stopping at the first word with digits
function suggestRuleText(description: string): string {
  const out: string[] = [];
  for (const w of description.split(',')[0].trim().split(/\s+/)) {
    if (/\d/.test(w) && out.length) break;
    out.push(w);
    if (out.length === 3) break;
  }
  return out.join(' ');
}

function ruleHref(t: Txn): string {
  const p = new URLSearchParams({
    text: suggestRuleText(t.description),
    category: t.expense_category_id ?? '',
    direction: t.amount < 0 ? 'out' : 'in',
  });
  if (t.notes) p.set('explanation', t.notes);
  return `/settings/rules?${p.toString()}`;
}

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
  const [attachPanelTxnId, setAttachPanelTxnId] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>({ unexplained: false, noReceipt: false, from: null, to: null });
  // Rows explained while "Unexplained only" is on stay visible (for Make rule / receipts) until the filter changes
  const [explainedHere, setExplainedHere] = useState<Record<string, Txn>>({});
  useEffect(() => { setExplainedHere({}); }, [filter, selectedAccountId]);

  // Deep link from the export page: /transactions?unexplained=1&from=...&to=... (or noReceipt=1)
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const unexplained = p.get('unexplained') === '1';
    const noReceipt = p.get('noReceipt') === '1';
    if (!unexplained && !noReceipt) return;
    setFilter({ unexplained, noReceipt, from: p.get('from'), to: p.get('to') });
    setInnerTab('all');
  }, []);

  const { data: accounts = [] } = useQuery<BankAccount[]>({
    queryKey: ['bank-accounts'],
    queryFn: () => api<BankAccount[]>('/api/v1/bank-accounts'),
  });

  // TanStack Query v5 has no onSuccess on queries; pick the first account once loaded
  useEffect(() => {
    if (!selectedAccountId && accounts.length > 0) setSelectedAccountId(accounts[0].id);
  }, [accounts, selectedAccountId]);

  const activeAccount = accounts.find(a => a.id === selectedAccountId);

  // Unexplained counts across every account, shown on the account tabs while the filter is on
  const { data: unexplainedAll = [] } = useQuery<Txn[]>({
    queryKey: ['transactions', 'unexplained-all', filter.from, filter.to],
    queryFn: () => {
      const p = new URLSearchParams({ unexplained: '1' });
      if (filter.from) p.set('from', filter.from);
      if (filter.to) p.set('to', filter.to);
      return api<Txn[]>(`/api/v1/transactions?${p.toString()}`);
    },
    enabled: filter.unexplained,
  });
  const unexplainedByAccount = unexplainedAll.reduce<Record<string, number>>((acc, t) => {
    acc[t.bank_account_id] = (acc[t.bank_account_id] ?? 0) + 1;
    return acc;
  }, {});

  // When arriving from the export page, jump to the first account that has something to explain
  const jumpedToUnexplained = useRef(false);
  useEffect(() => {
    if (jumpedToUnexplained.current || !filter.unexplained || unexplainedAll.length === 0 || !selectedAccountId) return;
    jumpedToUnexplained.current = true;
    if (!unexplainedByAccount[selectedAccountId]) {
      const first = accounts.find(a => unexplainedByAccount[a.id]);
      if (first) setSelectedAccountId(first.id);
    }
  }, [filter.unexplained, unexplainedAll, unexplainedByAccount, selectedAccountId, accounts]);

  const { data: balance } = useQuery<Balance>({
    queryKey: ['account-balance', selectedAccountId],
    queryFn: () => api<Balance>(`/api/v1/bank-accounts/${selectedAccountId}/balance`),
    enabled: !!selectedAccountId,
  });

  const { data: forReviewGroups = [] } = useQuery<unknown[]>({
    queryKey: ['for-review'],
    queryFn: () => api<unknown[]>('/api/v1/for-review'),
    enabled: !!selectedAccountId,
  });

  const txnQuery = new URLSearchParams({ bankAccountId: selectedAccountId ?? '' });
  if (filter.unexplained) txnQuery.set('unexplained', '1');
  if (filter.noReceipt) txnQuery.set('noReceipt', '1');
  if (filter.from) txnQuery.set('from', filter.from);
  if (filter.to) txnQuery.set('to', filter.to);

  const { data: txns = [] } = useQuery<Txn[]>({
    queryKey: ['transactions', selectedAccountId, filter],
    queryFn: () => api<Txn[]>(`/api/v1/transactions?${txnQuery.toString()}`),
    enabled: !!selectedAccountId,
  });

  const rows = filter.unexplained
    ? [...txns, ...Object.values(explainedHere).filter(r => !txns.some(x => x.id === r.id))]
        .sort((a, b) => b.date.localeCompare(a.date))
    : txns;

  const { data: categories = [] } = useQuery<Category[]>({
    queryKey: ['expense-categories'],
    queryFn: () => api<Category[]>('/api/v1/expense-categories'),
  });

  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api(`/api/v1/transactions/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['transactions', selectedAccountId] });
      qc.invalidateQueries({ queryKey: ['transactions', 'unexplained-all'] });
      qc.invalidateQueries({ queryKey: ['account-balance', selectedAccountId] });
    },
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
      const payload = await res.json().catch(() => ({})) as { newRowCount?: number; suggested?: number; categorised?: number; openingBalanceSet?: boolean; error?: string };
      if (!res.ok) throw new Error(payload.error || 'Import failed');
      const parts = [`Imported ${payload.newRowCount ?? 0} new transactions`];
      if (payload.suggested) parts.push(`${payload.suggested} match suggestions queued`);
      if (payload.categorised) parts.push(`${payload.categorised} categorised by rules`);
      if (payload.openingBalanceSet) parts.push('opening balance auto-detected from CSV');
      setUploadMsg(parts.join(' · ') + '.');
      if (payload.openingBalanceSet) qc.invalidateQueries({ queryKey: ['bank-accounts'] });
      if (fileRef.current) fileRef.current.value = '';
      qc.invalidateQueries({ queryKey: ['transactions', selectedAccountId] });
      qc.invalidateQueries({ queryKey: ['account-balance', selectedAccountId] });
      qc.invalidateQueries({ queryKey: ['for-review'] });
    } catch (err) {
      setUploadMsg((err as Error).message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Bank transactions</h1>
        <p className="mt-1 text-sm text-slate-500">Import CSVs, match to invoices and bills, reconcile.</p>
      </div>

      {/* Account tabs */}
      {accounts.length === 0 ? (
        <div className="card border-amber-200 bg-amber-50 text-sm text-amber-800">
          No bank accounts registered yet.{' '}
          {role === 'owner' ? (
            <Link href="/settings/bank-accounts" className="font-medium underline">
              Add one in Settings → Bank accounts
            </Link>
          ) : 'Ask the owner to add bank accounts in Settings.'}
        </div>
      ) : (
        <div className="flex gap-1 border-b border-slate-200">
          {accounts.map(a => (
            <button
              key={a.id}
              onClick={() => { setSelectedAccountId(a.id); setInnerTab(filter.unexplained ? 'all' : 'review'); }}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                a.id === selectedAccountId
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
            >
              {a.name}
              {a.last_four && <span className="ml-1 text-xs text-slate-400">···{a.last_four}</span>}
              {filter.unexplained && (unexplainedByAccount[a.id] ?? 0) > 0 && (
                <span className="ml-1.5 inline-flex items-center justify-center min-w-5 h-5 px-1 rounded-full bg-amber-100 text-amber-700 text-xs font-semibold">
                  {unexplainedByAccount[a.id]}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {selectedAccountId && activeAccount && (
        <>
          {/* Balance summary + CSV upload */}
          <div className="card flex flex-wrap items-start gap-4">
            <div className="flex-1 min-w-44">
              <p className="text-xs text-slate-500">Computed balance ({balance?.transaction_count ?? 0} txns)</p>
              <p className="text-lg font-bold text-slate-900">
                {balance ? formatPence(balance.computed_balance ?? 0) : '—'}
              </p>
              <p className="text-xs text-slate-400">
                Opening {formatPence(balance?.opening_balance ?? 0)} + movements {formatPence(balance?.net ?? 0)}
              </p>
              {balance?.last_known_balance != null && (
                <p className="text-xs text-slate-400">Last CSV balance: {formatPence(balance.last_known_balance)}</p>
              )}
              <p className="text-xs text-slate-400">
                {balance?.earliest_date && balance?.latest_date
                  ? `${formatDate(balance.earliest_date)} – ${formatDate(balance.latest_date)}`
                  : 'No transactions yet'}
              </p>
            </div>

            {role === 'owner' && (balance?.transaction_count ?? 0) > 0 && (
              <BalanceCheck computedBalance={balance?.computed_balance ?? 0} />
            )}

            {role === 'owner' && (
              <div className="flex items-center gap-2 ml-auto">
                <input ref={fileRef} type="file" accept=".csv,text/csv" className="text-sm" />
                <button onClick={uploadCSV} disabled={uploading} className="btn-primary whitespace-nowrap">
                  {uploading ? 'Importing…' : `Import ${activeAccount.bank_name} CSV`}
                </button>
                {uploadMsg && <p className="text-sm text-slate-600">{uploadMsg}</p>}
              </div>
            )}
          </div>

          {/* Inner tabs: For Review / All Transactions */}
          <div className="flex gap-1 border-b border-slate-200">
            <button
              onClick={() => setInnerTab('review')}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                innerTab === 'review'
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
            >
              For Review
              {forReviewGroups.length > 0 && (
                <span className="ml-1.5 inline-flex items-center justify-center w-5 h-5 rounded-full bg-amber-100 text-amber-700 text-xs font-semibold">
                  {forReviewGroups.length}
                </span>
              )}
            </button>
            <button
              onClick={() => setInnerTab('all')}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                innerTab === 'all'
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
            >
              All Transactions
            </button>
          </div>

          {innerTab === 'review' && <ForReviewPanel />}

          {innerTab === 'all' && (
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <label className="flex items-center gap-2 text-slate-700">
                <input
                  type="checkbox"
                  checked={filter.unexplained}
                  onChange={e => setFilter(f => ({ ...f, unexplained: e.target.checked }))}
                />
                Unexplained only
              </label>
              <label className="flex items-center gap-2 text-slate-700">
                <input
                  type="checkbox"
                  checked={filter.noReceipt}
                  onChange={e => setFilter(f => ({ ...f, noReceipt: e.target.checked }))}
                />
                No receipt
              </label>
              {(filter.from || filter.to) && (
                <span className="inline-flex items-center gap-2 rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600">
                  {filter.from ? formatDate(filter.from) : '…'} – {filter.to ? formatDate(filter.to) : '…'}
                  <button
                    type="button"
                    aria-label="Clear date filter"
                    className="text-slate-400 hover:text-slate-700"
                    onClick={() => setFilter(f => ({ ...f, from: null, to: null }))}
                  >
                    ✕
                  </button>
                </span>
              )}
              {filter.unexplained && !filter.noReceipt && <span className="text-xs text-slate-500">{txns.length} to explain in this account</span>}
              {filter.noReceipt && <span className="text-xs text-slate-500">{txns.length} payment{txns.length === 1 ? '' : 's'} without a receipt in this account</span>}
            </div>
          )}

          {innerTab === 'all' && (
            <div className="card overflow-auto p-0">
              <table className="w-full text-sm">
                <thead className="bg-slate-50">
                  <tr>
                    {['Date', 'Description', 'Amount', 'Category', 'Match', 'Reconciled', 'Flag', 'Notes'].map(h => (
                      <th key={h} className="p-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={8} className="p-8 text-center text-sm text-slate-400">
                        {filter.noReceipt
                          ? 'Every payment in this account has a receipt.'
                          : filter.unexplained
                          ? 'Nothing left to explain in this account.'
                          : 'No transactions for this account yet. Upload a CSV above.'}
                      </td>
                    </tr>
                  )}
                  {rows.map(t => (<Fragment key={t.id}>
                    <tr key={t.id} className={`border-t border-slate-100 ${t.flagged ? 'bg-amber-50' : 'hover:bg-slate-50'}`}>
                      <td className="p-3 whitespace-nowrap">{formatDate(t.date)}</td>
                      <td className="p-3 max-w-xs" title={t.description}>
                        <span className="truncate block">{t.description}</span>
                        {t.attachment_r2_key && (
                          <button
                            type="button"
                            onClick={async () => {
                              if (!token) return;
                              const res = await fetch(`${API_BASE}/api/v1/transactions/${t.id}/attachments`, {
                                headers: { Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' },
                                credentials: 'include',
                              });
                              if (!res.ok) return;
                              const blob = await res.blob();
                              const url = URL.createObjectURL(blob);
                              window.open(url, '_blank', 'noopener,noreferrer');
                              setTimeout(() => URL.revokeObjectURL(url), 60_000);
                            }}
                            className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 mt-0.5"
                          >
                            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                            {t.attachment_filename ?? 'attachment'}
                          </button>
                        )}
                        {role === 'owner' && t.amount < 0 && (
                          <button
                            type="button"
                            onClick={() => setAttachPanelTxnId(id => (id === t.id ? null : t.id))}
                            className={`block mt-0.5 text-xs ${t.attachment_r2_key ? 'text-slate-400 hover:text-slate-700' : 'text-blue-600 hover:text-blue-800'}`}
                          >
                            {t.attachment_r2_key ? 'Change receipt' : '+ Attach receipt'}
                          </button>
                        )}
                      </td>
                      <td className={`p-3 font-medium whitespace-nowrap tabular-nums ${t.amount < 0 ? 'text-red-600' : 'text-green-600'}`}>
                        {t.amount < 0 ? '−' : '+'}{formatPence(Math.abs(t.amount))}
                      </td>
                      <td className="p-3">
                        {role === 'owner' ? (<>
                          <select
                            value={t.expense_category_id ?? ''}
                            onChange={e => {
                              const catId = e.target.value || null;
                              patch.mutate({ id: t.id, body: { expenseCategoryId: catId } });
                              if (filter.unexplained) {
                                setExplainedHere(prev => ({
                                  ...prev,
                                  [t.id]: { ...t, expense_category_id: catId, categorised_by_rule_id: null },
                                }));
                              }
                              // Prompt for bill if professional/sub-contract category on a debit with no posted match
                              // Only show panel for expenses (debits), not income
                              if (catId && t.amount < 0) {
                                setAttachPanelTxnId(t.id);
                              } else {
                                setAttachPanelTxnId(null);
                              }
                            }}
                            className="input py-1 text-xs min-w-40 max-w-48"
                          >
                            <option value="">— none —</option>
                            {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                          </select>
                          {t.categorised_by_rule_id ? (
                            <span className="block mt-0.5 text-[11px] text-slate-400">auto: rule</span>
                          ) : t.expense_category_id ? (
                            <Link href={ruleHref(t)} className="block mt-0.5 text-[11px] text-blue-600 hover:text-blue-800">
                              Make rule
                            </Link>
                          ) : null}
                        </>) : (
                          <span className="text-xs text-slate-500">{t.category_name ?? '—'}</span>
                        )}
                      </td>
                      <td className="p-3 relative">
                        {role === 'owner' ? (
                          <MatchPanel txn={t} accountId={selectedAccountId!} />
                        ) : (
                          <span className="text-xs text-slate-500">
                            {t.match_status === 'posted' ? '✓ Posted'
                              : t.match_status === 'pending' ? '⏳ Pending'
                              : t.match_status === 'suggested' ? '~ Suggested'
                              : '—'}
                          </span>
                        )}
                      </td>
                      <td className="p-3 text-center">
                        {role === 'owner' ? (
                          <input
                            type="checkbox"
                            checked={!!t.is_reconciled}
                            onChange={e => patch.mutate({ id: t.id, body: { isReconciled: e.target.checked } })}
                          />
                        ) : (t.is_reconciled ? '✓' : '—')}
                      </td>
                      <td className="p-3 text-center">
                        {role === 'accountant' ? (
                          <input
                            type="checkbox"
                            checked={!!t.flagged}
                            onChange={e => patch.mutate({ id: t.id, body: { flagged: e.target.checked } })}
                          />
                        ) : (t.flagged ? '✓' : '—')}
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
                    {attachPanelTxnId === t.id && (
                      <tr key={`${t.id}-attach`} className="bg-slate-50 border-t border-slate-200">
                        <td colSpan={8} className="px-4 py-3">
                          <TxnAttachPanel
                            txn={t}
                            token={token}
                            onSaved={() => {
                              setAttachPanelTxnId(null);
                              qc.invalidateQueries({ queryKey: ['transactions', selectedAccountId] });
                            }}
                            onDismiss={() => setAttachPanelTxnId(null)}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function TxnAttachPanel({
  txn, token, onSaved, onDismiss,
}: {
  txn: Txn;
  token: string | null;
  onSaved: () => void;
  onDismiss: () => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState('');
  const [notes, setNotes] = useState(txn.notes ?? '');
  const fileRef = useRef<HTMLInputElement>(null);

  const openAttachment = async () => {
    if (!token) return;
    const res = await fetch(`${API_BASE}/api/v1/transactions/${txn.id}/attachments`, {
      headers: { Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' },
      credentials: 'include',
    });
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener,noreferrer');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  const upload = async (file: File) => {
    if (!token) return;
    setUploading(true);
    setErr('');
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(`${API_BASE}/api/v1/transactions/${txn.id}/attachments`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' },
        credentials: 'include',
        body: form,
      });
      if (!res.ok) throw new Error('Upload failed');
      // Save notes at same time
      await fetch(`${API_BASE}/api/v1/transactions/${txn.id}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Requested-With': 'XMLHttpRequest',
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({ notes }),
      });
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setUploading(false);
    }
  };

  const saveNotes = async () => {
    if (!token) return;
    await fetch(`${API_BASE}/api/v1/transactions/${txn.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Requested-With': 'XMLHttpRequest',
        'Content-Type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify({ notes }),
    });
    onSaved();
  };

  return (
    <div className="flex flex-wrap items-start gap-4">
      {/* Attachment */}
      <div className="flex-1 min-w-64">
        <p className="text-xs font-medium text-slate-600 mb-1.5">Supplier invoice / receipt</p>
        {txn.attachment_r2_key ? (
          <div className="flex items-center gap-2 p-2.5 rounded-lg border border-slate-200 bg-white text-sm">
            <svg className="h-4 w-4 text-blue-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
            </svg>
            <span className="flex-1 truncate text-slate-700">{txn.attachment_filename ?? 'Attached'}</span>
            <button type="button" onClick={openAttachment} className="text-blue-600 hover:text-blue-800 text-xs shrink-0">View</button>
            <label className="text-xs text-slate-500 hover:text-slate-700 cursor-pointer shrink-0">
              Replace
              <input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp" className="sr-only"
                onChange={e => { const f = e.target.files?.[0]; if (f) upload(f); }} />
            </label>
          </div>
        ) : (
          <label className={`flex items-center gap-2 p-2.5 rounded-lg border-2 border-dashed cursor-pointer transition-colors ${
            uploading ? 'border-blue-300 bg-blue-50' : 'border-red-300 bg-red-50 hover:border-blue-400 hover:bg-blue-50'
          }`}>
            {uploading ? (
              <span className="text-xs text-blue-600">Uploading…</span>
            ) : (
              <>
                <svg className="h-4 w-4 text-red-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                </svg>
                <span className="text-xs font-medium text-red-700">Attach supplier invoice (PDF / image)</span>
              </>
            )}
            <input ref={fileRef} type="file" accept=".pdf,.png,.jpg,.jpeg,.webp" className="sr-only" disabled={uploading}
              onChange={e => { const f = e.target.files?.[0]; if (f) upload(f); }} />
          </label>
        )}
        {err && <p className="text-xs text-red-600 mt-1">{err}</p>}
      </div>

      {/* Notes */}
      <div className="flex-1 min-w-48">
        <p className="text-xs font-medium text-slate-600 mb-1.5">Notes</p>
        <textarea
          rows={2}
          className="input resize-none text-xs w-full"
          placeholder="Description, reference, or reason for payment…"
          value={notes}
          onChange={e => setNotes(e.target.value)}
        />
      </div>

      {/* Actions */}
      <div className="flex flex-col gap-2 justify-start pt-5">
        <button type="button" className="btn-primary text-xs px-3 py-1.5" onClick={saveNotes}>
          Save notes
        </button>
        <button type="button" className="btn-secondary text-xs px-3 py-1.5" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

function BalanceCheck({ computedBalance }: { computedBalance: number }) {
  const [actual, setActual] = useState('');
  const actualPence = actual ? Math.round(parseFloat(actual) * 100) : null;
  const diff = actualPence !== null ? actualPence - computedBalance : null;

  return (
    <div className="border-l border-slate-200 pl-4 min-w-48">
      <p className="text-xs text-slate-500 mb-1">Balance check</p>
      <p className="text-xs text-slate-400 mb-1">Enter balance from your bank&apos;s online portal</p>
      <div className="flex items-center gap-1">
        <span className="text-sm text-slate-500">£</span>
        <input
          type="number"
          step="0.01"
          placeholder="0.00"
          value={actual}
          onChange={e => setActual(e.target.value)}
          className="input py-1 text-sm w-28"
        />
      </div>
      {diff !== null && (
        <p className={`text-xs mt-1 font-medium ${Math.abs(diff) < 1 ? 'text-green-600' : 'text-red-600'}`}>
          {Math.abs(diff) < 1
            ? '✓ Balances match'
            : `Gap: ${diff > 0 ? '+' : ''}${formatPence(diff)} — check opening balance or missing imports`}
        </p>
      )}
    </div>
  );
}
