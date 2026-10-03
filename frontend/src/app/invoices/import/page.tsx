'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppShell } from '@/components/layout/AppShell';
import { RoleGuard } from '@/components/RoleGuard';
import { api, API_BASE } from '@/lib/api';
import { useAuthStore } from '@/lib/auth';
import { formatPence, statusLabel, statusBadgeClass } from '@/lib/formatters';
import {
  FIELDS, findHeader, matchPdfToInvoice, prepareRows, readTable, type Field, type Mapping,
} from '@/lib/quickbooksImport';

type Outcome =
  | { row: number; invoiceNumber: string; action: 'create'; status: string; customer: string; newCustomer: boolean; warnings: string[] }
  | { row: number; invoiceNumber: string; action: 'skip'; reason: string };
type ImportResult = {
  dryRun: boolean;
  summary: { toImport: number; skipped: number; newCustomers: number; total: number; outstanding: number };
  outcomes: Outcome[];
  numbering: { prefix: string; next: number } | null;
};

export default function InvoiceImportPage() {
  return (
    <AppShell>
      <RoleGuard allowedRoles={['owner']}>
        <div className="max-w-4xl space-y-8">
          <div>
            <Link href="/invoices" className="text-sm text-slate-500 hover:text-slate-700">← Invoices</Link>
            <h1 className="mt-1 text-2xl font-bold text-slate-900">Import from QuickBooks</h1>
            <p className="mt-1 text-sm text-slate-500">
              Bring your past invoices across with their original numbers, customers, amounts and payment status.
              Imported invoices are kept exactly as they were: they can be paid or voided, but not edited.
            </p>
          </div>
          <ImportInvoices />
          <AttachPdfs />
        </div>
      </RoleGuard>
    </AppShell>
  );
}

// ── Step 1: the invoice list ───────────────────────────────────────────────────

function ImportInvoices() {
  const qc = useQueryClient();
  const [fileName, setFileName] = useState<string | null>(null);
  const [table, setTable] = useState<string[][] | null>(null);
  const [headerRow, setHeaderRow] = useState(0);
  const [mapping, setMapping] = useState<Mapping>({});
  const [allPaid, setAllPaid] = useState(false);
  const [fileError, setFileError] = useState('');

  const prepared = useMemo(
    () => (table ? prepareRows(table, headerRow, mapping, allPaid) : null),
    [table, headerRow, mapping, allPaid],
  );
  const headers = table?.[headerRow] ?? [];
  const missing = FIELDS.filter(f => f.required && mapping[f.field] === undefined);
  const needsPaidChoice = mapping.openBalance === undefined && !allPaid;

  const send = (dryRun: boolean) =>
    api<ImportResult>('/api/v1/invoice-imports', { method: 'POST', body: JSON.stringify({ rows: prepared!.rows, dryRun }) });
  const check = useMutation({ mutationFn: () => send(true) });
  const run = useMutation({
    mutationFn: () => send(false),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['invoices'] });
      qc.invalidateQueries({ queryKey: ['imported-invoices'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
  const reset = () => { check.reset(); run.reset(); };

  async function onFile(file: File | undefined) {
    reset();
    setFileError(''); setTable(null); setFileName(file?.name ?? null);
    if (!file) return;
    try {
      const rows = await readTable(file);
      const found = findHeader(rows);
      if (!found) {
        setFileError("Couldn't find the column headings. The file needs at least an invoice number column (\"No.\") and a \"Customer\" column.");
        return;
      }
      setTable(rows); setHeaderRow(found.headerRow); setMapping(found.mapping); setAllPaid(false);
    } catch {
      setFileError("Couldn't read this file. Export the report from QuickBooks as CSV or Excel (.xlsx).");
    }
  }

  const result = run.data ?? check.data;
  const lineOf = (row: number) => prepared?.lines[row - 1];

  return (
    <section className="card space-y-5">
      <div>
        <h2 className="text-base font-semibold text-slate-900">1. Invoices</h2>
        <details className="mt-2 text-sm text-slate-600">
          <summary className="cursor-pointer text-blue-700">How to export them from QuickBooks Online</summary>
          <ol className="mt-2 list-decimal space-y-1 pl-5">
            <li>Go to <b>Reports</b> and open the <b>Invoice List</b> report (search for it).</li>
            <li>Set the date range to <b>All dates</b> (or the period you want to bring across).</li>
            <li>Optionally use <b>Customise → Rows/Columns</b> to add <b>Due date</b>, <b>Open balance</b> and, if offered, the VAT/tax and net amounts.</li>
            <li>Use the export button to save it as <b>Excel</b> or <b>CSV</b>, and choose that file below.</li>
          </ol>
          <p className="mt-2">Other QuickBooks lists work too, as long as they have an invoice number, customer, date and amount column.</p>
        </details>
      </div>

      <div>
        <label className="btn-secondary cursor-pointer">
          {fileName ? 'Choose a different file' : 'Choose CSV or Excel file'}
          <input type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="sr-only" onChange={e => { onFile(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
        {fileName && <span className="ml-3 text-sm text-slate-600">{fileName}</span>}
        {fileError && <p className="mt-2 text-sm text-red-700" role="alert">{fileError}</p>}
      </div>

      {table && prepared && (
        <>
          <div>
            <h3 className="text-sm font-semibold text-slate-700">Columns</h3>
            <p className="text-xs text-slate-500">Matched automatically from the headings on line {headerRow + 1}. Change any that are wrong.</p>
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {FIELDS.map(({ field, label, required }) => (
                <label key={field} className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-slate-700">{label}{required && <span className="text-red-600"> *</span>}</span>
                  <select
                    className="input max-w-[14rem]"
                    value={mapping[field] ?? ''}
                    onChange={e => {
                      reset();
                      const value = e.target.value === '' ? undefined : Number(e.target.value);
                      setMapping(m => ({ ...m, [field]: value } as Mapping));
                    }}
                  >
                    <option value="">— not in file —</option>
                    {headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                  </select>
                </label>
              ))}
            </div>
            {missing.length > 0 && (
              <p className="mt-3 text-sm text-red-700" role="alert">Choose a column for: {missing.map(f => f.label).join(', ')}.</p>
            )}
            {mapping.openBalance === undefined && (
              <label className="mt-3 flex items-start gap-2 text-sm text-slate-700">
                <input type="checkbox" checked={allPaid} onChange={e => { reset(); setAllPaid(e.target.checked); }} className="mt-0.5" />
                <span>There&apos;s no open balance column: <b>every invoice in this file has been paid in full.</b> (If some are still owed, add the Open balance column in QuickBooks and export again.)</span>
              </label>
            )}
          </div>

          <div className="text-sm text-slate-600">
            {prepared.rows.length} invoice row{prepared.rows.length === 1 ? '' : 's'} found
            {prepared.excluded.length > 0 && <>, {prepared.excluded.length} other row{prepared.excluded.length === 1 ? '' : 's'} left out</>}.
            {prepared.excluded.length > 0 && (
              <details className="mt-1">
                <summary className="cursor-pointer text-blue-700">Show rows left out</summary>
                <ul className="mt-1 list-disc pl-5 text-xs">
                  {prepared.excluded.map(x => <li key={x.line}>Line {x.line}: {x.reason}</li>)}
                </ul>
              </details>
            )}
          </div>

          {!run.data && (
            <button
              type="button"
              className="btn-primary"
              disabled={missing.length > 0 || needsPaidChoice || prepared.rows.length === 0 || check.isPending}
              onClick={() => check.mutate()}
            >
              {check.isPending ? 'Checking…' : 'Check before importing'}
            </button>
          )}
          {(check.error || run.error) && (
            <p className="text-sm text-red-700" role="alert">{((check.error ?? run.error) as Error).message}</p>
          )}
        </>
      )}

      {result && (
        <div className="space-y-4 border-t border-slate-100 pt-4">
          <Summary result={result} />
          <div className="max-h-96 overflow-auto rounded-lg border border-slate-200">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-slate-50 text-left text-xs uppercase text-slate-500">
                <tr><th className="px-3 py-2">Line</th><th className="px-3 py-2">Invoice</th><th className="px-3 py-2">Result</th><th className="px-3 py-2">Notes</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {result.outcomes.map(o => (
                  <tr key={o.row}>
                    <td className="px-3 py-1.5 tabular-nums text-slate-400">{lineOf(o.row)}</td>
                    <td className="px-3 py-1.5 font-mono">{o.invoiceNumber || '—'}</td>
                    <td className="px-3 py-1.5">
                      {o.action === 'create'
                        ? <span className={`badge ${statusBadgeClass[o.status] ?? 'badge-gray'}`}>{statusLabel[o.status] ?? o.status}</span>
                        : <span className="badge badge-gray">Skipped</span>}
                    </td>
                    <td className="px-3 py-1.5 text-slate-600">
                      {o.action === 'skip'
                        ? o.reason
                        : [o.customer + (o.newCustomer ? ' (new customer)' : ''), ...o.warnings].join(' · ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {!run.data && result.summary.toImport > 0 && (
            <button type="button" className="btn-primary" disabled={run.isPending} onClick={() => run.mutate()}>
              {run.isPending ? 'Importing…' : `Import ${result.summary.toImport} invoice${result.summary.toImport === 1 ? '' : 's'}`}
            </button>
          )}
          {run.data && (
            <>
              <div className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800" role="status">
                Imported {run.data.summary.toImport} invoice{run.data.summary.toImport === 1 ? '' : 's'}.
                Paid ones count as income in your reports; unpaid ones show as outstanding and can be matched to bank payments.
              </div>
              {run.data.numbering && <ContinueNumbering suggestion={run.data.numbering} />}
            </>
          )}
        </div>
      )}
    </section>
  );
}

function Summary({ result }: { result: ImportResult }) {
  const s = result.summary;
  return (
    <p className="text-sm text-slate-700">
      {result.dryRun ? 'Ready to import' : 'Imported'} <b>{s.toImport}</b> invoice{s.toImport === 1 ? '' : 's'} worth{' '}
      <b>{formatPence(s.total)}</b>
      {s.outstanding > 0 && <>, of which <b>{formatPence(s.outstanding)}</b> is still owed</>}
      {s.newCustomers > 0 && <>, creating <b>{s.newCustomers}</b> new customer{s.newCustomers === 1 ? '' : 's'}</>}.
      {s.skipped > 0 && <> {s.skipped} row{s.skipped === 1 ? ' is' : 's are'} skipped (see notes).</>}
    </p>
  );
}

const formatNumber = (prefix: string, seq: number) => (prefix ? `${prefix}-${String(seq).padStart(4, '0')}` : String(seq));

function ContinueNumbering({ suggestion }: { suggestion: { prefix: string; next: number } }) {
  const qc = useQueryClient();
  const { data: settings } = useQuery({
    queryKey: ['company-settings'],
    queryFn: () => api<{ invoice_prefix: string; invoice_next_sequence: number }>('/api/v1/settings/company'),
  });
  const apply = useMutation({
    mutationFn: () => api('/api/v1/settings/company', {
      method: 'PATCH',
      body: JSON.stringify({ invoice_prefix: suggestion.prefix, invoice_next_sequence: suggestion.next }),
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['company-settings'] }),
  });
  if (!settings) return null;
  const current = formatNumber(settings.invoice_prefix, settings.invoice_next_sequence);
  const proposed = formatNumber(suggestion.prefix, suggestion.next);
  if (current === proposed) return null;

  return (
    <div className="rounded-lg border border-slate-200 px-3 py-3 text-sm">
      <p className="text-slate-700">
        Your next new invoice will be numbered <b className="font-mono">{current}</b>.
        To carry on from QuickBooks it should be <b className="font-mono">{proposed}</b>.
      </p>
      {apply.isSuccess
        ? <p className="mt-2 text-green-700" role="status">Done: the next invoice will be {proposed}.</p>
        : (
          <button type="button" className="btn-secondary mt-2" disabled={apply.isPending} onClick={() => apply.mutate()}>
            {apply.isPending ? 'Saving…' : `Continue numbering at ${proposed}`}
          </button>
        )}
      {apply.isError && <p className="mt-2 text-red-700" role="alert">{(apply.error as Error).message}</p>}
    </div>
  );
}

// ── Step 2: original PDFs ──────────────────────────────────────────────────────

type ImportedInvoice = { id: string; invoice_number: string; has_pdf: number };
type Upload = { file: File; invoice: ImportedInvoice | null; state: 'ready' | 'uploading' | 'done' | 'error'; error?: string };

function AttachPdfs() {
  const qc = useQueryClient();
  const token = useAuthStore(s => s.accessToken);
  const { data: imported = [] } = useQuery({
    queryKey: ['imported-invoices'],
    queryFn: () => api<ImportedInvoice[]>('/api/v1/invoices?source=quickbooks'),
  });
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [busy, setBusy] = useState(false);

  const missing = imported.filter(i => !i.has_pdf).length;
  const byNumber = new Map(imported.map(i => [i.invoice_number, i]));

  function choose(files: FileList | null) {
    if (!files) return;
    const numbers = [...byNumber.keys()];
    setUploads(Array.from(files, file => {
      const n = matchPdfToInvoice(file.name, numbers);
      return { file, invoice: n ? byNumber.get(n)! : null, state: 'ready' as const };
    }));
  }

  async function uploadAll() {
    setBusy(true);
    for (let i = 0; i < uploads.length; i++) {
      const u = uploads[i];
      if (!u.invoice || u.state === 'done') continue;
      setUploads(list => list.map((x, j) => (j === i ? { ...x, state: 'uploading' } : x)));
      const form = new FormData();
      form.append('file', u.file);
      const res = await fetch(`${API_BASE}/api/v1/invoices/${u.invoice.id}/original-pdf`, {
        method: 'POST',
        credentials: 'include',
        headers: { Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' },
        body: form,
      }).catch(() => null);
      const error = res?.ok ? undefined : ((await res?.json().catch(() => null)) as { error?: string } | null)?.error ?? 'Upload failed';
      setUploads(list => list.map((x, j) => (j === i ? { ...x, state: error ? 'error' : 'done', error } : x)));
    }
    setBusy(false);
    qc.invalidateQueries({ queryKey: ['imported-invoices'] });
  }

  const matched = uploads.filter(u => u.invoice && u.state !== 'done').length;

  return (
    <section className="card space-y-4">
      <div>
        <h2 className="text-base font-semibold text-slate-900">2. Original PDFs <span className="font-normal text-slate-400">(optional, any time)</span></h2>
        <p className="mt-1 text-sm text-slate-600">
          Attach the PDFs your customers received, so each imported invoice shows exactly what was sent.
          Each file is matched by the invoice number in its name, e.g. <span className="font-mono">Invoice_1043.pdf</span>.
          You can also attach one from the invoice&apos;s own page.
        </p>
        <p className="mt-1 text-sm text-slate-500">
          {imported.length === 0
            ? 'No imported invoices yet.'
            : `${imported.length} imported invoice${imported.length === 1 ? '' : 's'}, ${missing} without a PDF.`}
        </p>
      </div>

      {imported.length > 0 && (
        <label className="btn-secondary cursor-pointer">
          Choose PDFs
          <input type="file" accept="application/pdf,.pdf" multiple className="sr-only"
            onChange={e => { choose(e.target.files); e.target.value = ''; }} />
        </label>
      )}

      {uploads.length > 0 && (
        <>
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 text-sm">
            {uploads.map((u, i) => (
              <li key={i} className="flex items-center justify-between gap-3 px-3 py-1.5">
                <span className="truncate text-slate-700">{u.file.name}</span>
                <span className="shrink-0 text-slate-500">
                  {!u.invoice ? <span className="text-amber-700">No matching invoice</span>
                    : u.state === 'done' ? <span className="text-green-700">Attached to {u.invoice.invoice_number}</span>
                    : u.state === 'error' ? <span className="text-red-700">{u.error}</span>
                    : u.state === 'uploading' ? 'Uploading…'
                    : <>→ <span className="font-mono">{u.invoice.invoice_number}</span>{u.invoice.has_pdf ? ' (replaces its PDF)' : ''}</>}
                </span>
              </li>
            ))}
          </ul>
          {matched > 0 && (
            <button type="button" className="btn-primary" disabled={busy} onClick={uploadAll}>
              {busy ? 'Uploading…' : `Attach ${matched} PDF${matched === 1 ? '' : 's'}`}
            </button>
          )}
        </>
      )}
    </section>
  );
}
