'use client';

import { useState } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { useAuthStore } from '@/lib/auth';

const TAX_YEARS = ['2024-25', '2025-26', '2026-27'];

export default function YearEndPage() {
  return (
    <AppShell>
      <YearEndContent />
    </AppShell>
  );
}

function YearEndContent() {
  const token = useAuthStore((s) => s.accessToken);
  const [taxYear, setTaxYear] = useState('2025-26');
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState('');

  const download = async () => {
    if (!token) return;
    setDownloading(true);
    setError('');
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/reports/year-end?tax_year=${taxYear}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Requested-With': 'XMLHttpRequest',
        },
        credentials: 'include',
      });
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
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="max-w-lg space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Year-end export</h1>
        <p className="mt-1 text-sm text-slate-500">
          Download ZIP with CSVs, summary PDF, and invoice PDFs for the selected UK tax year.
        </p>
      </div>

      <div className="card space-y-4">
        <div>
          <label className="field-label">UK tax year</label>
          <select value={taxYear} onChange={(e) => setTaxYear(e.target.value)} className="input">
            {TAX_YEARS.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        <button type="button" className="btn-primary w-full" onClick={download} disabled={downloading}>
          {downloading ? 'Generating ZIP…' : 'Download year-end package'}
        </button>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
    </div>
  );
}
