'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Suspense } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { api } from '@/lib/api';
import { formatPence, formatDate, statusBadgeClass, statusLabel } from '@/lib/formatters';

type Client = {
  id: string; name: string; email: string | null; phone: string | null;
  address: string | null; tax_id: string | null; notes: string | null;
  is_active: number; created_at: string;
};
type Invoice = {
  id: string; invoice_number: string; status: string; issue_date: string;
  due_date: string; total: number; amount_paid: number;
};

export default function ClientDetailPage() {
  return (
    <AppShell>
      <Suspense>
        <ClientDetailRoute />
      </Suspense>
    </AppShell>
  );
}

// Static export can't pre-render one page per id, so the id comes from ?id=
function ClientDetailRoute() {
  const id = useSearchParams().get('id');
  if (!id) return <p className="text-sm text-slate-500">No client selected.</p>;
  return <ClientDetail id={id} />;
}

function ClientDetail({ id }: { id: string }) {
  const router = useRouter();
  const qc = useQueryClient();

  const { data: client, isLoading } = useQuery<Client>({
    queryKey: ['client', id],
    queryFn: () => api<Client>(`/api/v1/clients/${id}`),
  });

  const { data: invoices = [] } = useQuery<Invoice[]>({
    queryKey: ['invoices', { client_id: id }],
    queryFn: async () => {
      const all = await api<Invoice[]>('/api/v1/invoices');
      return all;
    },
    select: (all: Invoice[]) => all,
    enabled: !!client,
  });

  const deactivate = useMutation({
    mutationFn: () => api(`/api/v1/clients/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['clients'] });
      router.push('/clients');
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

  if (!client) return <p className="text-sm text-slate-500">Client not found.</p>;

  const clientInvoices = invoices;

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{client.name}</h1>
          {client.email && <p className="mt-1 text-sm text-slate-500">{client.email}</p>}
        </div>
        <div className="flex gap-2">
          <Link href={`/invoices/new?client=${id}`} className="btn-primary">New invoice</Link>
          <button
            onClick={() => {
              if (confirm(`Deactivate ${client.name}? This will not affect existing invoices.`)) {
                deactivate.mutate();
              }
            }}
            className="btn-danger"
            disabled={deactivate.isPending}
          >
            Deactivate
          </button>
        </div>
      </div>

      <div className="card">
        <h2 className="text-base font-semibold text-slate-900 mb-4">Details</h2>
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 text-sm">
          {client.phone && (
            <>
              <dt className="text-slate-500">Phone</dt>
              <dd className="text-slate-900">{client.phone}</dd>
            </>
          )}
          {client.address && (
            <>
              <dt className="text-slate-500">Address</dt>
              <dd className="text-slate-900 whitespace-pre-line">{client.address}</dd>
            </>
          )}
          {client.tax_id && (
            <>
              <dt className="text-slate-500">VAT number</dt>
              <dd className="text-slate-900 font-mono">{client.tax_id}</dd>
            </>
          )}
          {client.notes && (
            <>
              <dt className="text-slate-500">Notes</dt>
              <dd className="text-slate-900">{client.notes}</dd>
            </>
          )}
          <dt className="text-slate-500">Client since</dt>
          <dd className="text-slate-900">{formatDate(client.created_at)}</dd>
        </dl>
      </div>

      <div className="card">
        <h2 className="text-base font-semibold text-slate-900 mb-4">Invoices</h2>
        {clientInvoices.length === 0 ? (
          <p className="text-sm text-slate-500 py-4 text-center">No invoices yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {clientInvoices.map(inv => (
              <li key={inv.id}>
                <Link
                  href={`/invoices/view?id=${inv.id}`}
                  className="flex items-center justify-between py-3 first:pt-0 last:pb-0 hover:bg-slate-50 -mx-5 px-5 rounded-lg transition-colors"
                >
                  <div>
                    <p className="text-sm font-medium text-slate-900 font-mono">{inv.invoice_number}</p>
                    <p className="text-xs text-slate-500">Due {formatDate(inv.due_date)}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={`badge ${statusBadgeClass[inv.status] ?? 'badge-gray'}`}>
                      {statusLabel[inv.status] ?? inv.status}
                    </span>
                    <span className="text-sm font-semibold tabular-nums text-slate-900">
                      {formatPence(inv.total)}
                    </span>
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
