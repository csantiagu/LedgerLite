'use client';

import { useState } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { useAuthStore } from '@/lib/auth';

// UK tax year starts 6 April. Returns e.g. '2026-27' for dates after 6 Apr 2026.
function currentTaxYearStart(): number {
  const now = new Date();
  const y = now.getFullYear();
  const afterApril6 = now.getMonth() > 3 || (now.getMonth() === 3 && now.getDate() >= 6);
  return afterApril6 ? y : y - 1;
}

const taxYearLabel = (start: number) => `${start}-${String((start + 1) % 100).padStart(2, '0')}`;

// Current tax year and the three before it, oldest first
const TAX_YEARS = [3, 2, 1, 0].map((back) => taxYearLabel(currentTaxYearStart() - back));

const ZIP_CONTENTS = [
  {
    file: 'summary.pdf',
    desc: 'Profit & loss summary for the tax year',
  },
  {
    file: 'income.csv',
    desc: 'Payments received, grouped by client',
  },
  {
    file: 'expenses.csv',
    desc: 'Bills and categorised expenses summary',
  },
  {
    file: 'invoices-register.csv',
    desc: 'All invoices with dates, status, amounts, balances and notes',
  },
  {
    file: 'bills-register.csv',
    desc: 'All bills with vendor, category, amounts, flagged status and accountant notes',
  },
  {
    file: 'transactions/<account>.csv',
    desc: 'One CSV per bank account — includes category, notes and reconciliation status',
  },
  {
    file: 'flagged-items.csv',
    desc: 'Flagged transactions and bills with accountant notes',
  },
  {
    file: 'invoices-sent/',
    desc: 'PDF copies of all finalised invoices',
  },
  {
    file: 'bills-received/',
    desc: 'Attached PDFs of supplier invoices received',
  },
  {
    file: 'expense-receipts/',
    desc: 'Receipts and invoices attached directly to bank transactions',
  },
];

export default function YearEndPage() {
  return (
    <AppShell>
      <YearEndContent />
    </AppShell>
  );
}

function YearEndContent() {
  const token = useAuthStore((s) => s.accessToken);
  const [taxYear, setTaxYear] = useState(() => TAX_YEARS[TAX_YEARS.length - 1]);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState('');
  const [lastDownloaded, setLastDownloaded] = useState<Date | null>(null);

  const download = async () => {
    if (!token) return;
    setDownloading(true);
    setError('');
    try {
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL}/api/v1/reports/year-end?tax_year=${taxYear}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'X-Requested-With': 'XMLHttpRequest',
          },
          credentials: 'include',
        }
      );
      if (!res.ok) {
        const payload = await res.json().catch(() => ({ error: 'Export failed' }));
        throw new Error(payload.error || 'Export failed');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `year-end-${taxYear}.zip`;
      a.click();
      URL.revokeObjectURL(url);
      setLastDownloaded(new Date());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="max-w-2xl space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Year-end export</h1>
        <p className="mt-1 text-sm text-slate-500">
          Download a ZIP package for your accountant or self-assessment filing.
        </p>
      </div>

      {/* Tax year selector + download */}
      <div className="card space-y-5">
        <div>
          <p className="field-label">UK tax year</p>
          <div className="flex flex-wrap gap-2 mt-2" role="group" aria-label="Select tax year">
            {TAX_YEARS.map((y) => (
              <button
                key={y}
                type="button"
                onClick={() => setTaxYear(y)}
                aria-pressed={taxYear === y}
                className={[
                  'px-4 py-2 rounded-full text-sm font-medium border transition-all duration-150 cursor-pointer',
                  taxYear === y
                    ? 'bg-blue-600 text-white border-blue-600 shadow-sm'
                    : 'bg-white text-slate-600 border-slate-200 hover:border-blue-300 hover:text-slate-900',
                ].join(' ')}
              >
                {y}
              </button>
            ))}
          </div>
        </div>

        <button
          type="button"
          className="btn-primary w-full"
          onClick={download}
          disabled={downloading}
        >
          {downloading ? (
            <>
              <svg
                className="animate-spin h-4 w-4"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden="true"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
              Generating ZIP…
            </>
          ) : (
            <>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 20 20"
                fill="currentColor"
                className="h-4 w-4"
                aria-hidden="true"
              >
                <path d="M10.75 2.75a.75.75 0 0 0-1.5 0v8.614L6.295 8.235a.75.75 0 1 0-1.09 1.03l4.25 4.5a.75.75 0 0 0 1.09 0l4.25-4.5a.75.75 0 0 0-1.09-1.03l-2.955 3.129V2.75Z" />
                <path d="M3.5 12.75a.75.75 0 0 0-1.5 0v2.5A2.75 2.75 0 0 0 4.75 18h10.5A2.75 2.75 0 0 0 18 15.25v-2.5a.75.75 0 0 0-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5Z" />
              </svg>
              Download {taxYear} package
            </>
          )}
        </button>

        {error && (
          <p className="text-sm text-red-600" role="alert">
            {error}
          </p>
        )}

        {lastDownloaded && !error && (
          <p className="text-xs text-slate-500 text-center">
            Last downloaded:{' '}
            {lastDownloaded.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
          </p>
        )}
      </div>

      {/* ZIP contents */}
      <div className="card">
        <h2 className="text-sm font-semibold text-slate-700 mb-4">What&apos;s included</h2>
        <ul className="space-y-3">
          {ZIP_CONTENTS.map(({ file, desc }) => (
            <li key={file} className="flex items-start gap-3">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 20 20"
                fill="currentColor"
                className="h-5 w-5 text-green-500 shrink-0 mt-0.5"
                aria-hidden="true"
              >
                <path
                  fillRule="evenodd"
                  d="M16.704 4.153a.75.75 0 0 1 .143 1.052l-8 10.5a.75.75 0 0 1-1.127.075l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 0 1 1.05-.143Z"
                  clipRule="evenodd"
                />
              </svg>
              <div>
                <code className="text-xs font-mono bg-slate-100 px-1.5 py-0.5 rounded text-slate-700">
                  {file}
                </code>
                <p className="text-xs text-slate-500 mt-0.5">{desc}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
