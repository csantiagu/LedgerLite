'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { AppShell } from '@/components/layout/AppShell';
import { api, API_BASE } from '@/lib/api';
import { useAuthStore } from '@/lib/auth';
import { formatDate } from '@/lib/formatters';

// VAT "stagger" decides which months your VAT quarters end in.
const STAGGERS = [
  { value: 0, label: 'Mar / Jun / Sep / Dec' },
  { value: 1, label: 'Apr / Jul / Oct / Jan' },
  { value: 2, label: 'May / Aug / Nov / Feb' },
];
const STAGGER_KEY = 'ledgerlite.vatStagger';

type Period = { label: string; from: string; to: string };

const pad = (n: number) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Most recent quarters (including the one in progress) for a stagger, newest first
function vatQuarters(stagger: number, count = 5): Period[] {
  const today = new Date();
  let y = today.getFullYear();
  let m = today.getMonth() + 1; // 1-12
  while (m % 3 !== stagger) { m += 1; if (m > 12) { m = 1; y += 1; } }

  const out: Period[] = [];
  for (let i = 0; i < count; i++) {
    const endLastDay = new Date(y, m, 0).getDate();
    let sm = m - 2, sy = y;
    if (sm < 1) { sm += 12; sy -= 1; }
    out.push({
      label: `${MONTHS[sm - 1]} ${sy !== y ? sy + ' ' : ''}– ${MONTHS[m - 1]} ${y}`,
      from: `${sy}-${pad(sm)}-01`,
      to: `${y}-${pad(m)}-${pad(endLastDay)}`,
    });
    m -= 3;
    if (m < 1) { m += 12; y -= 1; }
  }
  return out;
}

function readStagger(): number {
  try {
    const v = Number(localStorage.getItem(STAGGER_KEY));
    return [0, 1, 2].includes(v) ? v : 0;
  } catch {
    return 0;
  }
}

export default function ExportPage() {
  return (
    <AppShell>
      <ExportContent />
    </AppShell>
  );
}

function ExportContent() {
  const token = useAuthStore((s) => s.accessToken);
  const [stagger, setStagger] = useState(readStagger);
  const quarters = useMemo(() => vatQuarters(stagger), [stagger]);
  // Default to the last completed quarter
  const [period, setPeriod] = useState<Period>(() => vatQuarters(readStagger())[1]);
  const [includeReceipts, setIncludeReceipts] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState('');

  const validRange = /^\d{4}-\d{2}-\d{2}$/.test(period.from) && /^\d{4}-\d{2}-\d{2}$/.test(period.to) && period.from <= period.to;

  const { data: inPeriod = [], isLoading } = useQuery<Array<{ id: string }>>({
    queryKey: ['transactions', 'period', period.from, period.to],
    queryFn: () => api(`/api/v1/transactions?from=${period.from}&to=${period.to}`),
    enabled: validRange,
  });

  const { data: unexplained = [] } = useQuery<Array<{ id: string }>>({
    queryKey: ['transactions', 'unexplained', period.from, period.to],
    queryFn: () => api(`/api/v1/transactions?unexplained=1&from=${period.from}&to=${period.to}`),
    enabled: validRange,
  });

  const { data: noReceipt = [] } = useQuery<Array<{ id: string }>>({
    queryKey: ['transactions', 'no-receipt', period.from, period.to],
    queryFn: () => api(`/api/v1/transactions?noReceipt=1&from=${period.from}&to=${period.to}`),
    enabled: validRange,
  });

  const changeStagger = (v: number) => {
    setStagger(v);
    try { localStorage.setItem(STAGGER_KEY, String(v)); } catch { /* storage unavailable */ }
    setPeriod(vatQuarters(v)[1]);
  };

  const download = async () => {
    if (!token || !validRange) return;
    setDownloading(true);
    setError('');
    try {
      const qs = `from=${period.from}&to=${period.to}${includeReceipts ? '&receipts=1' : ''}`;
      const res = await fetch(`${API_BASE}/api/v1/reports/accountant-export?${qs}`, {
        headers: { Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' },
        credentials: 'include',
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({ error: 'Export failed' }));
        throw new Error(payload.error || 'Export failed');
      }
      const filename = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1]
        ?? `accounts-${period.from}-to-${period.to}.${includeReceipts ? 'zip' : 'xlsx'}`;
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Export for accountant</h1>
        <p className="mt-1 text-sm text-slate-500">
          A spreadsheet of every bank line with its category and explanation, plus invoices and bills, for one period.
        </p>
      </div>

      <div className="card space-y-5">
        <div>
          <label className="field-label" htmlFor="stagger">Your VAT quarters end in</label>
          <select id="stagger" className="input mt-1" value={stagger} onChange={(e) => changeStagger(Number(e.target.value))}>
            {STAGGERS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </div>

        <div>
          <p className="field-label">Period</p>
          <div className="flex flex-wrap gap-2 mt-2" role="group" aria-label="Select period">
            {quarters.map((q, i) => {
              const active = q.from === period.from && q.to === period.to;
              return (
                <button
                  key={q.from}
                  type="button"
                  onClick={() => setPeriod(q)}
                  aria-pressed={active}
                  className={[
                    'px-4 py-2 rounded-full text-sm font-medium border transition-colors',
                    active
                      ? 'bg-blue-600 text-white border-blue-600 shadow-sm'
                      : 'bg-white text-slate-600 border-slate-200 hover:border-blue-300 hover:text-slate-900',
                  ].join(' ')}
                >
                  {q.label}{i === 0 ? ' (current)' : ''}
                </button>
              );
            })}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-slate-500" htmlFor="from">From</label>
              <input id="from" type="date" className="input" value={period.from}
                onChange={(e) => setPeriod({ label: 'Custom', from: e.target.value, to: period.to })} />
            </div>
            <div>
              <label className="text-xs text-slate-500" htmlFor="to">To</label>
              <input id="to" type="date" className="input" value={period.to}
                onChange={(e) => setPeriod({ label: 'Custom', from: period.from, to: e.target.value })} />
            </div>
          </div>
          {!validRange && <p className="field-error">Pick a start date on or before the end date.</p>}
        </div>

        {validRange && !isLoading && (
          inPeriod.length === 0 ? (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
              No bank transactions imported between {formatDate(period.from)} and {formatDate(period.to)}.{' '}
              <Link href="/transactions" className="font-medium underline">Import your statements</Link> first.
            </div>
          ) : unexplained.length > 0 ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              <strong>{unexplained.length} bank line{unexplained.length === 1 ? '' : 's'}</strong> between{' '}
              {formatDate(period.from)} and {formatDate(period.to)} still {unexplained.length === 1 ? 'has' : 'have'} no category.{' '}
              <Link href={`/transactions?unexplained=1&from=${period.from}&to=${period.to}`} className="font-medium underline">
                Explain them
              </Link>{' '}
              first, or export anyway. They&apos;ll be listed on an &ldquo;Unexplained&rdquo; sheet.
            </div>
          ) : (
            <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800">
              All {inPeriod.length} bank lines in this period are explained.
            </div>
          )
        )}

        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={includeReceipts} onChange={(e) => setIncludeReceipts(e.target.checked)} />
          Include attached receipts and bill PDFs (downloads a ZIP)
        </label>
        {validRange && noReceipt.length > 0 && (
          <p className="-mt-3 text-xs text-slate-500">
            {noReceipt.length} payment{noReceipt.length === 1 ? '' : 's'} in this period {noReceipt.length === 1 ? 'has' : 'have'} no receipt attached.{' '}
            <Link href={`/transactions?noReceipt=1&from=${period.from}&to=${period.to}`} className="font-medium text-blue-600 underline">
              Attach them
            </Link>
          </p>
        )}

        <button type="button" className="btn-primary w-full" onClick={download} disabled={downloading || !validRange}>
          {downloading ? 'Building…' : `Download ${includeReceipts ? 'ZIP' : 'spreadsheet'}`}
        </button>
        {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
      </div>

      <div className="card text-sm text-slate-600 space-y-1">
        <h2 className="text-sm font-semibold text-slate-700 mb-2">Sheets in the workbook</h2>
        <p><strong>Summary</strong>: totals in and out by category, with VAT from invoices and bills raised in the period</p>
        <p><strong>Bank transactions</strong>: every line, its category, your explanation, what it matched and its receipt</p>
        <p><strong>Unexplained</strong>: only if anything is still uncategorised</p>
        <p><strong>Sales invoices</strong> and <strong>Supplier bills</strong>: net, VAT, gross and paid status</p>
      </div>
    </div>
  );
}
