'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { AppShell } from '@/components/layout/AppShell';
import { RoleGuard } from '@/components/RoleGuard';
import { api } from '@/lib/api';
import { formatDate, formatPence } from '@/lib/formatters';

type FlaggedBill = {
  id: string;
  bill_number: string | null;
  vendor_name: string;
  due_date: string | null;
  total: number;
  accountant_notes: string | null;
  flagged: number;
};

type FlaggedTxn = {
  id: string;
  date: string;
  description: string;
  amount: number;
  accountant_notes: string | null;
  flagged: number;
};

export default function ReviewPage() {
  return (
    <AppShell>
      <RoleGuard allowedRoles={['accountant']}>
        <ReviewContent />
      </RoleGuard>
    </AppShell>
  );
}

function ReviewContent() {
  const { data: bills = [], isLoading } = useQuery<FlaggedBill[]>({
    queryKey: ['bills-flagged'],
    queryFn: () => api<FlaggedBill[]>('/api/v1/bills?flagged=1'),
  });
  const { data: txns = [], isLoading: txnsLoading } = useQuery<FlaggedTxn[]>({
    queryKey: ['transactions-flagged'],
    queryFn: () => api<FlaggedTxn[]>('/api/v1/transactions?flagged=1'),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Flagged items</h1>
        <p className="mt-1 text-sm text-slate-500">Bills requiring owner attention.</p>
      </div>

      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="space-y-3 p-1">
            {[1, 2, 3].map(i => <div key={i} className="h-14 animate-pulse rounded-lg bg-slate-100" />)}
          </div>
        ) : bills.length === 0 ? (
          <p className="text-sm text-slate-500 py-8 text-center">No flagged bills right now.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100">
                <th className="py-3 px-4 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Bill</th>
                <th className="py-3 px-4 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Vendor</th>
                <th className="py-3 px-4 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Due date</th>
                <th className="py-3 px-4 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">Amount</th>
                <th className="py-3 px-4 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {bills.map(bill => (
                <tr key={bill.id} className="hover:bg-slate-50">
                  <td className="py-3 px-4">
                    <Link href={`/bills/view?id=${bill.id}`} className="text-blue-600 hover:text-blue-800 font-medium">
                      {bill.bill_number || bill.id.slice(0, 8).toUpperCase()}
                    </Link>
                  </td>
                  <td className="py-3 px-4">{bill.vendor_name}</td>
                  <td className="py-3 px-4">{bill.due_date ? formatDate(bill.due_date) : '—'}</td>
                  <td className="py-3 px-4 text-right tabular-nums">{formatPence(bill.total)}</td>
                  <td className="py-3 px-4 text-slate-500">{bill.accountant_notes || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card overflow-hidden">
        <h2 className="text-base font-semibold text-slate-900 px-4 pt-4">Flagged transactions</h2>
        {txnsLoading ? (
          <div className="space-y-3 p-4">
            {[1, 2].map(i => <div key={i} className="h-14 animate-pulse rounded-lg bg-slate-100" />)}
          </div>
        ) : txns.length === 0 ? (
          <p className="text-sm text-slate-500 py-8 text-center">No flagged transactions right now.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100">
                <th className="py-3 px-4 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Date</th>
                <th className="py-3 px-4 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Description</th>
                <th className="py-3 px-4 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">Amount</th>
                <th className="py-3 px-4 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {txns.map(t => (
                <tr key={t.id} className="hover:bg-slate-50">
                  <td className="py-3 px-4">{formatDate(t.date)}</td>
                  <td className="py-3 px-4">{t.description}</td>
                  <td className="py-3 px-4 text-right tabular-nums">{formatPence(t.amount)}</td>
                  <td className="py-3 px-4 text-slate-500">{t.accountant_notes || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
