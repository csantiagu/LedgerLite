'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { RoleGuard } from '@/components/RoleGuard';
import { InvoiceForm, NEW_LINE } from '../InvoiceForm';

const today = new Date().toISOString().slice(0, 10);
const in30 = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);

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
  return (
    <InvoiceForm
      title="New invoice"
      subtitle="Invoice will be saved as a draft."
      initial={{ client_id: params.get('client') ?? '', issue_date: today, due_date: in30, notes: '', items: [NEW_LINE] }}
    />
  );
}
