'use client';

import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { RoleGuard } from '@/components/RoleGuard';
import { api } from '@/lib/api';
import { addDays, localToday } from '@/lib/dates';
import { penceToPounds } from '@/lib/formatters';
import { InvoiceForm, NEW_LINE } from '../InvoiceForm';
import { duplicateInvoice, type SourceInvoice } from './duplicate';


export default function NewInvoicePage() {
  return (
    <AppShell>
      <RoleGuard allowedRoles={['owner']}>
        <Suspense>
          <NewInvoiceContent />
        </Suspense>
      </RoleGuard>
    </AppShell>
  );
}

function NewInvoiceContent() {
  const params = useSearchParams();
  const from = params.get('from');
  if (from) return <DuplicateInvoice id={from} />;
  // Worked out on each visit, so a tab left open overnight doesn't date invoices yesterday
  const today = localToday();
  return (
    <InvoiceForm
      title="New invoice"
      subtitle="Invoice will be saved as a draft."
      initial={{ client_id: params.get('client') ?? '', issue_date: today, due_date: addDays(today, 30), notes: '', items: [NEW_LINE] }}
    />
  );
}

// /invoices/new?from=<id>: a new draft filled in from an existing invoice
function DuplicateInvoice({ id }: { id: string }) {
  const { data: source, isLoading, isError } = useQuery<SourceInvoice>({
    queryKey: ['invoice', id],
    queryFn: () => api<SourceInvoice>(`/api/v1/invoices/${id}`),
  });

  if (isLoading) return <div className="card h-48 max-w-3xl animate-pulse bg-slate-50" />;
  if (isError || !source) return <p className="text-sm text-slate-500">Invoice not found.</p>;

  const { initial, warnings } = duplicateInvoice(source, localToday());
  return (
    <InvoiceForm
      key={source.id}
      title={`Duplicate ${source.invoice_number}`}
      subtitle={'A new draft with the same client, lines and notes, dated today with the same payment terms. '
        + warnings.map(w => `${w} `).join('')
        + 'It gets its own invoice number.'}
      initial={{ ...initial, items: initial.items.map(i => ({ ...i, unit_price: penceToPounds(i.unit_price) })) }}
    />
  );
}
