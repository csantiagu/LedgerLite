'use client';

import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Suspense } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { RoleGuard } from '@/components/RoleGuard';
import { api } from '@/lib/api';
import { bankLineProblem, type BankLine } from '@/lib/billFromBank';
import { BillForm, type Vendor } from '../BillForm';

export default function NewBillPage() {
  return (
    <AppShell>
      <RoleGuard allowedRoles={['owner']}>
        <Suspense>
          <NewBillRoute />
        </Suspense>
      </RoleGuard>
    </AppShell>
  );
}

// ?vendor=<id> preselects the vendor; ?transaction=<id> fills the bill from a bank payment and
// matches the saved bill to it
function NewBillRoute() {
  const params = useSearchParams();
  const vendorId = params.get('vendor');
  const transactionId = params.get('transaction');

  const vendorsQuery = useQuery<Vendor[]>({
    queryKey: ['vendors'],
    queryFn: () => api<Vendor[]>('/api/v1/vendors'),
  });
  const lineQuery = useQuery<BankLine>({
    queryKey: ['transaction', transactionId],
    queryFn: () => api<BankLine>(`/api/v1/transactions/${transactionId}`),
    enabled: !!transactionId,
  });

  if (vendorsQuery.isLoading || (transactionId && lineQuery.isLoading)) {
    return <div className="card h-40 max-w-4xl animate-pulse bg-slate-50" />;
  }
  if (transactionId) {
    const line = lineQuery.data;
    const problem = bankLineProblem(line);
    if (problem || !line) {
      return (
        <div className="max-w-4xl space-y-3">
          <h1 className="text-2xl font-bold text-slate-900">New bill</h1>
          <p className="text-sm text-slate-600">{problem}</p>
          <Link href="/transactions" className="btn-secondary">Back to bank</Link>
        </div>
      );
    }
    return <BillForm vendors={vendorsQuery.data ?? []} vendorId={vendorId} line={line} />;
  }
  return <BillForm vendors={vendorsQuery.data ?? []} vendorId={vendorId} line={null} />;
}

