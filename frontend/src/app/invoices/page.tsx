'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { AppShell } from '@/components/layout/AppShell';
import { api } from '@/lib/api';
import { formatPence, formatDate, statusBadgeClass, statusLabel } from '@/lib/formatters';

type InvoiceRow = {
  id: string;
  invoice_number: string;
  status: string;
  source: 'ledgerlite' | 'quickbooks';
  issue_date: string;
  due_date: string;
  total: number;
  amount_paid: number;
  client_name: string;
};

export default function InvoicesPage() {
  return (
    <AppShell>
      <InvoicesContent />
    </AppShell>
  );
}

function InvoicesContent() {
  const { data: invoices = [], isLoading } = useQuery<InvoiceRow[]>({
    queryKey: ['invoices'],
    queryFn: () => api<InvoiceRow[]>('/api/v1/invoices'),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Invoices</h1>
          <p className="mt-1 text-sm text-slate-500">Track and manage your invoices.</p>
        </div>
        <div className="flex gap-2">
          <Link href="/invoices/import" className="btn-secondary">Import from QuickBooks</Link>
          <Link href="/invoices/new" className="btn-primary">New invoice</Link>
        </div>
      </div>

      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="space-y-3 p-1">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="h-14 animate-pulse rounded-lg bg-slate-100" />
            ))}
          </div>
        ) : invoices.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <svg className="h-10 w-10 text-slate-300 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
            </svg>
            <p className="text-sm font-medium text-slate-500">No invoices yet</p>
            <p className="text-xs text-slate-400 mt-1">Create your first invoice to get started.</p>
            <Link href="/invoices/new" className="btn-primary mt-4">New invoice</Link>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100">
                <th className="py-3 px-4 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Number</th>
                <th className="py-3 px-4 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Client</th>
                <th className="py-3 px-4 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Due date</th>
                <th className="py-3 px-4 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Status</th>
                <th className="py-3 px-4 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {invoices.map(inv => (
                <tr key={inv.id} className="hover:bg-slate-50 transition-colors">
                  <td className="py-3 px-4">
                    <Link href={`/invoices/view?id=${inv.id}`} className="font-mono text-blue-600 hover:text-blue-800 font-medium">
                      {inv.invoice_number}
                    </Link>
                    {inv.source === 'quickbooks' && (
                      <span className="ml-2 text-xs text-slate-400" title="Imported from QuickBooks">QB</span>
                    )}
                  </td>
                  <td className="py-3 px-4 text-slate-700">{inv.client_name}</td>
                  <td className="py-3 px-4 text-slate-500 tabular-nums">{formatDate(inv.due_date)}</td>
                  <td className="py-3 px-4">
                    <span className={`badge ${statusBadgeClass[inv.status] ?? 'badge-gray'}`}>
                      {statusLabel[inv.status] ?? inv.status}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-right tabular-nums font-medium text-slate-900">
                    {formatPence(inv.total)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
