'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSearchParams, useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import Link from 'next/link';
import { Suspense, useState } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { RoleGuard } from '@/components/RoleGuard';
import { api } from '@/lib/api';
import { formatPence, formatDate, statusBadgeClass, statusLabel } from '@/lib/formatters';
import { vendorTotals } from '@/lib/bills';

type Vendor = {
  id: string; name: string; email: string | null; phone: string | null;
  address: string | null; tax_id: string | null; notes: string | null;
  is_active: number; created_at: string;
};
type Bill = {
  id: string; bill_number: string | null; status: string; issue_date: string | null;
  due_date: string | null; total: number; amount_paid: number; flagged: number; refund_due?: number;
};

const Schema = z.object({
  name:    z.string().trim().min(1, 'Required').max(200),
  email:   z.string().trim().email('Not an email address').or(z.literal('')),
  phone:   z.string().trim().max(30),
  address: z.string().trim().max(500),
  tax_id:  z.string().trim().max(50),
  notes:   z.string().trim().max(1000),
});
type FormData = z.infer<typeof Schema>;

export default function VendorDetailPage() {
  return (
    <AppShell>
      <RoleGuard allowedRoles={['owner']}>
        <Suspense>
          <VendorDetailRoute />
        </Suspense>
      </RoleGuard>
    </AppShell>
  );
}

// Static export can't pre-render one page per id, so the id comes from ?id=
function VendorDetailRoute() {
  const id = useSearchParams().get('id');
  if (!id) return <p className="text-sm text-slate-500">No vendor selected.</p>;
  return <VendorDetail id={id} />;
}

function VendorDetail({ id }: { id: string }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);

  const { data: vendor, isLoading } = useQuery<Vendor>({
    queryKey: ['vendor', id],
    queryFn: () => api<Vendor>(`/api/v1/vendors/${id}`),
  });

  const { data: bills = [] } = useQuery<Bill[]>({
    queryKey: ['bills', { vendor_id: id }],
    queryFn: () => api<Bill[]>(`/api/v1/bills?vendor_id=${encodeURIComponent(id)}`),
  });

  const deactivate = useMutation({
    mutationFn: () => api(`/api/v1/vendors/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['vendors'] });
      router.push('/settings/vendors');
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-48 animate-pulse rounded bg-slate-100" />
        <div className="card h-40 animate-pulse bg-slate-50" />
      </div>
    );
  }

  if (!vendor) return <p className="text-sm text-slate-500">Vendor not found.</p>;

  const active = vendor.is_active === 1;
  const { owed, openCount, paid, refundDue } = vendorTotals(bills);

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link href="/settings/vendors" className="text-sm text-slate-500 hover:text-slate-700">← Vendors</Link>
          <h1 className="mt-1 text-2xl font-bold text-slate-900">{vendor.name}</h1>
          {vendor.email && <p className="mt-1 text-sm text-slate-500">{vendor.email}</p>}
          {!active && <span className="badge badge-gray mt-2">Inactive</span>}
        </div>
        {active && (
          <div className="flex gap-2 shrink-0">
            <Link href={`/bills/new?vendor=${id}`} className="btn-primary">New bill</Link>
            <button
              onClick={() => {
                if (confirm(`Deactivate ${vendor.name}? Existing bills are not affected.`)) deactivate.mutate();
              }}
              className="btn-danger"
              disabled={deactivate.isPending}
            >
              Deactivate
            </button>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="card">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Owed to vendor</p>
          <p className="mt-1 text-xl font-semibold tabular-nums text-slate-900">{formatPence(owed)}</p>
          <p className="text-xs text-slate-500">{openCount} open {openCount === 1 ? 'bill' : 'bills'}</p>
          {refundDue > 0 && (
            <p className="text-xs text-amber-700 mt-1">−{formatPence(refundDue)} to be refunded</p>
          )}
        </div>
        <div className="card">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Paid to date</p>
          <p className="mt-1 text-xl font-semibold tabular-nums text-slate-900">
            {formatPence(paid)}
          </p>
          <p className="text-xs text-slate-500">{bills.length} {bills.length === 1 ? 'bill' : 'bills'} in total</p>
        </div>
      </div>

      {editing
        ? <EditVendor vendor={vendor} onDone={() => setEditing(false)} />
        : (
          <div className="card">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold text-slate-900">Details</h2>
              {active && (
                <button type="button" onClick={() => setEditing(true)} className="text-sm text-blue-600 hover:text-blue-800 font-medium">
                  Edit
                </button>
              )}
            </div>
            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 text-sm">
              <dt className="text-slate-500">Email</dt>
              <dd className="text-slate-900">{vendor.email || '—'}</dd>
              <dt className="text-slate-500">Phone</dt>
              <dd className="text-slate-900">{vendor.phone || '—'}</dd>
              <dt className="text-slate-500">Address</dt>
              <dd className="text-slate-900 whitespace-pre-line">{vendor.address || '—'}</dd>
              <dt className="text-slate-500">VAT number</dt>
              <dd className="text-slate-900 font-mono">{vendor.tax_id || '—'}</dd>
              {vendor.notes && (
                <>
                  <dt className="text-slate-500">Notes</dt>
                  <dd className="text-slate-900 whitespace-pre-line">{vendor.notes}</dd>
                </>
              )}
              <dt className="text-slate-500">Vendor since</dt>
              <dd className="text-slate-900">{formatDate(vendor.created_at)}</dd>
            </dl>
          </div>
        )}

      <div className="card">
        <h2 className="text-base font-semibold text-slate-900 mb-4">Bills</h2>
        {bills.length === 0 ? (
          <div className="py-4 text-center">
            <p className="text-sm text-slate-500">No bills yet.</p>
            <p className="mt-1 text-xs text-slate-400">
              Add one here, or from a bank payment in For Review (Find match → Create bill).
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {bills.map(bill => (
              <li key={bill.id}>
                <Link
                  href={`/bills/view?id=${bill.id}`}
                  className="flex items-center justify-between py-3 first:pt-0 last:pb-0 hover:bg-slate-50 -mx-5 px-5 rounded-lg transition-colors"
                >
                  <div>
                    <p className="text-sm font-medium text-slate-900 font-mono">
                      {bill.bill_number || bill.id.slice(0, 8).toUpperCase()}
                      {bill.flagged === 1 && <span className="ml-2 badge badge-red">Flagged</span>}
                    </p>
                    <p className="text-xs text-slate-500">
                      {bill.issue_date ? formatDate(bill.issue_date) : 'No date'}
                      {bill.due_date && ` · Due ${formatDate(bill.due_date)}`}
                      {(bill.refund_due ?? 0) > 0 && (
                        <span className="text-amber-700"> · −{formatPence(bill.refund_due!)} to refund</span>
                      )}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={`badge ${statusBadgeClass[bill.status] ?? 'badge-gray'}`}>
                      {statusLabel[bill.status] ?? bill.status}
                    </span>
                    <span className="text-sm font-semibold tabular-nums text-slate-900">{formatPence(bill.total)}</span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function EditVendor({ vendor, onDone }: { vendor: Vendor; onDone: () => void }) {
  const qc = useQueryClient();
  const { register, handleSubmit, formState: { errors } } = useForm<FormData>({
    resolver: zodResolver(Schema),
    defaultValues: {
      name: vendor.name,
      email: vendor.email ?? '',
      phone: vendor.phone ?? '',
      address: vendor.address ?? '',
      tax_id: vendor.tax_id ?? '',
      notes: vendor.notes ?? '',
    },
  });

  const save = useMutation({
    mutationFn: (d: FormData) => api(`/api/v1/vendors/${vendor.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        name: d.name,
        email: d.email || null,
        phone: d.phone || null,
        address: d.address || null,
        tax_id: d.tax_id || null,
        notes: d.notes || null,
      }),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['vendor', vendor.id] });
      qc.invalidateQueries({ queryKey: ['vendors'] });
      qc.invalidateQueries({ queryKey: ['bills'] });
      onDone();
    },
  });

  return (
    <form onSubmit={handleSubmit(d => save.mutate(d))} noValidate className="card space-y-4">
      <h2 className="text-base font-semibold text-slate-900">Edit details</h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className="field-label" htmlFor="v-name">Name</label>
          <input id="v-name" {...register('name')} className={`input ${errors.name ? 'input-error' : ''}`} />
          {errors.name && <p className="field-error">{errors.name.message}</p>}
        </div>
        <div>
          <label className="field-label" htmlFor="v-email">Email</label>
          <input id="v-email" type="email" {...register('email')} className={`input ${errors.email ? 'input-error' : ''}`} />
          {errors.email && <p className="field-error">{errors.email.message}</p>}
        </div>
        <div>
          <label className="field-label" htmlFor="v-phone">Phone</label>
          <input id="v-phone" {...register('phone')} className="input" />
        </div>
        <div>
          <label className="field-label" htmlFor="v-tax">VAT number</label>
          <input id="v-tax" {...register('tax_id')} className="input" />
        </div>
      </div>
      <div>
        <label className="field-label" htmlFor="v-address">Address</label>
        <textarea id="v-address" {...register('address')} rows={3} className="input resize-none" />
      </div>
      <div>
        <label className="field-label" htmlFor="v-notes">Notes</label>
        <textarea id="v-notes" {...register('notes')} rows={2} className="input resize-none" />
      </div>
      {save.isError && <p className="text-sm text-red-600">{(save.error as Error).message}</p>}
      <div className="flex gap-3">
        <button type="submit" className="btn-primary" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</button>
        <button type="button" className="btn-secondary" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}
