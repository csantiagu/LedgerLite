'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { AppShell } from '@/components/layout/AppShell';
import { api } from '@/lib/api';
import { useAuthStore } from '@/lib/auth';
import { formatPence, formatDate, statusBadgeClass, statusLabel } from '@/lib/formatters';

type BillRow = {
  id: string;
  bill_number: string | null;
  status: string;
  issue_date: string | null;
  due_date: string | null;
  total: number;
  amount_paid: number;
  vendor_id: string;
  vendor_name: string;
  flagged: number;
  refund_due?: number;
};

export default function BillsPage() {
  return (
    <AppShell>
      <BillsContent />
    </AppShell>
  );
}

function BillsContent() {
  const isOwner = useAuthStore(s => s.role) === 'owner';
  const { data: bills = [], isLoading } = useQuery<BillRow[]>({
    queryKey: ['bills'],
    queryFn: () => api<BillRow[]>('/api/v1/bills'),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Bills</h1>
          <p className="mt-1 text-sm text-slate-500">Track supplier bills, payments, and flagged issues.</p>
        </div>
        {isOwner && <Link href="/bills/new" className="btn-primary">New bill</Link>}
      </div>

      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="space-y-3 p-1">
            {[1, 2, 3, 4].map(i => <div key={i} className="h-14 animate-pulse rounded-lg bg-slate-100" />)}
          </div>
        ) : bills.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <p className="text-sm font-medium text-slate-500">No bills yet</p>
            {isOwner && <Link href="/bills/new" className="btn-primary mt-4">Create first bill</Link>}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100">
                <th className="py-3 px-4 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Bill</th>
                <th className="py-3 px-4 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Vendor</th>
                <th className="py-3 px-4 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Due date</th>
                <th className="py-3 px-4 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Status</th>
                <th className="py-3 px-4 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {bills.map(bill => (
                <tr key={bill.id} className="hover:bg-slate-50 transition-colors">
                  <td className="py-3 px-4">
                    <Link href={`/bills/view?id=${bill.id}`} className="font-medium text-blue-600 hover:text-blue-800">
                      {bill.bill_number || bill.id.slice(0, 8).toUpperCase()}
                    </Link>
                    {bill.flagged === 1 && <span className="ml-2 badge badge-red">Flagged</span>}
                  </td>
                  <td className="py-3 px-4 text-slate-700">
                    {isOwner
                      ? <Link href={`/vendors/view?id=${bill.vendor_id}`} className="hover:text-blue-700">{bill.vendor_name}</Link>
                      : bill.vendor_name}
                  </td>
                  <td className="py-3 px-4 text-slate-500 tabular-nums">{bill.due_date ? formatDate(bill.due_date) : '—'}</td>
                  <td className="py-3 px-4">
                    <span className={`badge ${statusBadgeClass[bill.status] ?? 'badge-gray'}`}>
                      {statusLabel[bill.status] ?? bill.status}
                    </span>
                    {(bill.refund_due ?? 0) > 0 && (
                      <span className="mt-1 block text-xs text-amber-700">−{formatPence(bill.refund_due!)} to refund</span>
                    )}
                  </td>
                  <td className="py-3 px-4 text-right tabular-nums font-medium text-slate-900">{formatPence(bill.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
