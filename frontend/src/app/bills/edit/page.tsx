'use client';

import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Suspense } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { RoleGuard } from '@/components/RoleGuard';
import { api } from '@/lib/api';
import { BillForm, type EditableBill, type Vendor } from '../BillForm';

type Bill = EditableBill & { status: string; payments: unknown[] };

export default function EditBillPage() {
  return (
    <AppShell>
      <RoleGuard allowedRoles={['owner']}>
        <Suspense>
          <EditBillRoute />
        </Suspense>
      </RoleGuard>
    </AppShell>
  );
}

// Static export: the bill's id comes from ?id=
function EditBillRoute() {
  const id = useSearchParams().get('id');
  const vendorsQuery = useQuery<Vendor[]>({ queryKey: ['vendors'], queryFn: () => api<Vendor[]>('/api/v1/vendors') });
  const billQuery = useQuery<Bill>({
    queryKey: ['bill', id],
    queryFn: () => api<Bill>(`/api/v1/bills/${id}`),
    enabled: !!id,
  });

  if (!id) return <p className="text-sm text-slate-500">No bill selected.</p>;
  if (vendorsQuery.isLoading || billQuery.isLoading) return <div className="card h-40 max-w-4xl animate-pulse bg-slate-50" />;
  const bill = billQuery.data;
  if (!bill) return <p className="text-sm text-red-700" role="alert">{(billQuery.error as Error)?.message ?? 'Bill not found'}</p>;

  // The amounts of a paid or void bill stay as they were; its categories can still be changed
  const blocked = bill.status === 'void' ? 'This bill is void, so it can’t be edited.'
    : bill.payments.length ? 'This bill has payments, so its amounts can’t be changed. You can still change its categories on the bill page.'
    : null;
  if (blocked) {
    return (
      <div className="max-w-4xl space-y-3">
        <h1 className="text-2xl font-bold text-slate-900">Edit bill</h1>
        <p className="text-sm text-slate-600">{blocked}</p>
        <Link href={`/bills/view?id=${bill.id}`} className="btn-secondary">Back to the bill</Link>
      </div>
    );
  }
  return <BillForm vendors={vendorsQuery.data ?? []} vendorId={bill.vendor_id} line={null} bill={bill} />;
}
