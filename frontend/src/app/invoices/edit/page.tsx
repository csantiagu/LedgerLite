'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { RoleGuard } from '@/components/RoleGuard';
import { api } from '@/lib/api';
import { penceToPounds } from '@/lib/formatters';
import { InvoiceForm } from '../InvoiceForm';

type Draft = {
  id: string; invoice_number: string; status: string; client_id: string;
  issue_date: string; due_date: string; notes: string | null;
  items: Array<{ description: string; quantity: number; unit_price: number; tax_rate: number }>;
};

export default function EditInvoicePage() {
  return (
    <AppShell>
      <RoleGuard allowedRoles={['owner']}>
        <Suspense>
          <EditInvoiceRoute />
        </Suspense>
      </RoleGuard>
    </AppShell>
  );
}

// Static export can't pre-render one page per id, so the id comes from ?id=
function EditInvoiceRoute() {
  const id = useSearchParams().get('id');
  if (!id) return <p className="text-sm text-slate-500">No invoice selected.</p>;
  return <EditInvoice id={id} />;
}

function EditInvoice({ id }: { id: string }) {
  const { data: invoice, isLoading } = useQuery<Draft>({
    queryKey: ['invoice', id],
    queryFn: () => api<Draft>(`/api/v1/invoices/${id}`),
  });

  if (isLoading) return <div className="card h-48 max-w-3xl animate-pulse bg-slate-50" />;
  if (!invoice) return <p className="text-sm text-slate-500">Invoice not found.</p>;
  if (invoice.status !== 'draft') {
    return (
      <div className="card max-w-3xl space-y-2">
        <p className="text-sm text-slate-700">
          {invoice.invoice_number} has been finalised, so it can&rsquo;t be edited. Void it and raise a new one instead.
        </p>
        <Link href={`/invoices/view?id=${id}`} className="text-sm text-blue-600 hover:text-blue-800">Back to the invoice</Link>
      </div>
    );
  }

  return (
    <InvoiceForm
      key={invoice.id}
      invoiceId={invoice.id}
      title={`Edit ${invoice.invoice_number}`}
      subtitle="This invoice is still a draft. Saving keeps it as a draft until you finalise it."
      initial={{
        client_id: invoice.client_id,
        issue_date: invoice.issue_date,
        due_date: invoice.due_date,
        notes: invoice.notes ?? '',
        items: invoice.items.map(i => ({
          description: i.description, quantity: i.quantity,
          unit_price: penceToPounds(i.unit_price), tax_rate: i.tax_rate,
        })),
      }}
    />
  );
}
