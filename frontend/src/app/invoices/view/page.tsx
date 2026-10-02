'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import Link from 'next/link';
import { AppShell } from '@/components/layout/AppShell';
import { api } from '@/lib/api';
import { formatPence, formatDate, statusBadgeClass, statusLabel } from '@/lib/formatters';
import { useAuthStore } from '@/lib/auth';

type InvoiceItem = { id: string; description: string; quantity: number; unit_price: number; tax_rate: number; amount: number };
type Payment = { id: string; amount: number; payment_date: string; method: string; reference: string | null };
type Invoice = {
  id: string; invoice_number: string; status: string;
  issue_date: string; due_date: string;
  subtotal: number; tax_amount: number; total: number; amount_paid: number;
  notes: string | null; pdf_r2_key: string | null;
  client_name: string; client_email: string | null; client_address: string | null;
  client_id: string;
  items: InvoiceItem[];
  payments: Payment[];
};

const PaymentSchema = z.object({
  amount:       z.coerce.number().positive('Amount required'),
  payment_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  method:       z.enum(['bank_transfer', 'card', 'cash', 'cheque', 'other']),
  reference:    z.string().max(100).optional(),
  notes:        z.string().max(500).optional(),
});
type PaymentForm = z.infer<typeof PaymentSchema>;

export default function InvoiceDetailPage() {
  return (
    <AppShell>
      <Suspense>
        <InvoiceDetailRoute />
      </Suspense>
    </AppShell>
  );
}

// Static export can't pre-render one page per id, so the id comes from ?id=
function InvoiceDetailRoute() {
  const id = useSearchParams().get('id');
  if (!id) return <p className="text-sm text-slate-500">No invoice selected.</p>;
  return <InvoiceDetail id={id} />;
}

function InvoiceDetail({ id }: { id: string }) {
  const qc = useQueryClient();
  const role = useAuthStore(s => s.role);
  const token = useAuthStore(s => s.accessToken);
  const isOwner = role === 'owner';

  const [showPaymentForm, setShowPaymentForm] = useState(false);

  const { data: invoice, isLoading } = useQuery<Invoice>({
    queryKey: ['invoice', id],
    queryFn: () => api<Invoice>(`/api/v1/invoices/${id}`),
  });

  const finalize = useMutation({
    mutationFn: () => api(`/api/v1/invoices/${id}/finalize`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['invoice', id] }),
  });

  const voidInvoice = useMutation({
    mutationFn: () => api(`/api/v1/invoices/${id}/void`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['invoice', id] }),
  });

  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm<PaymentForm>({
    resolver: zodResolver(PaymentSchema),
    defaultValues: {
      payment_date: new Date().toISOString().slice(0, 10),
      method: 'bank_transfer',
    },
  });

  const addPayment = useMutation({
    mutationFn: (data: PaymentForm) =>
      api(`/api/v1/invoices/${id}/payments`, {
        method: 'POST',
        body: JSON.stringify({
          ...data,
          amount: Math.round(data.amount * 100),
          reference: data.reference || null,
          notes: data.notes || null,
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['invoice', id] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      setShowPaymentForm(false);
      reset();
    },
  });

  const removePayment = useMutation({
    mutationFn: (paymentId: string) =>
      api(`/api/v1/invoices/${id}/payments/${paymentId}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['invoice', id] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });

  const openPdf = async () => {
    if (!token) throw new Error('Unauthenticated');
    const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/invoices/${id}/pdf`, {
      method: 'GET',
      credentials: 'include',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Requested-With': 'XMLHttpRequest',
      },
    });
    if (!res.ok) throw new Error(`Failed to download PDF (${res.status})`);

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const signed = await res.json() as { url: string };
      window.open(signed.url, '_blank', 'noopener,noreferrer');
      return;
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener,noreferrer');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  if (isLoading) {
    return (
      <div className="space-y-4 max-w-3xl">
        <div className="h-8 w-64 animate-pulse rounded bg-slate-100" />
        <div className="card h-48 animate-pulse bg-slate-50" />
      </div>
    );
  }

  if (!invoice) return <p className="text-sm text-slate-500">Invoice not found.</p>;

  const canFinalize = invoice.status === 'draft' && isOwner;
  const canVoid = invoice.status !== 'void' && isOwner;
  const canPay = ['sent', 'partial', 'overdue'].includes(invoice.status) && isOwner;
  const balance = invoice.total - invoice.amount_paid;

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <p className="text-sm text-slate-500 font-mono">{invoice.invoice_number}</p>
          <h1 className="text-2xl font-bold text-slate-900">{invoice.client_name}</h1>
          <div className="mt-1 flex items-center gap-2">
            <span className={`badge ${statusBadgeClass[invoice.status] ?? 'badge-gray'}`}>
              {statusLabel[invoice.status] ?? invoice.status}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {invoice.pdf_r2_key && (
            <button type="button" onClick={openPdf} className="btn-secondary text-sm">
              Download PDF
            </button>
          )}
          {canFinalize && (
            <button
              onClick={() => finalize.mutate()}
              disabled={finalize.isPending}
              className="btn-primary"
            >
              {finalize.isPending ? 'Generating…' : 'Finalise & send'}
            </button>
          )}
          {canPay && (
            <button onClick={() => setShowPaymentForm(v => !v)} className="btn-primary">
              Record payment
            </button>
          )}
          {canVoid && (
            <button
              onClick={() => {
                if (confirm('Void this invoice? This cannot be undone.')) voidInvoice.mutate();
              }}
              disabled={voidInvoice.isPending}
              className="btn-danger"
            >
              Void
            </button>
          )}
        </div>
      </div>

      {/* Invoice details */}
      <div className="card">
        <div className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4 mb-6">
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wide">Issue date</p>
            <p className="mt-1 font-medium text-slate-900">{formatDate(invoice.issue_date)}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wide">Due date</p>
            <p className="mt-1 font-medium text-slate-900">{formatDate(invoice.due_date)}</p>
          </div>
          {invoice.client_email && (
            <div>
              <p className="text-xs text-slate-500 uppercase tracking-wide">Client email</p>
              <p className="mt-1 font-medium text-slate-900">{invoice.client_email}</p>
            </div>
          )}
        </div>

        {/* Line items */}
        <table className="w-full text-sm mb-6">
          <thead>
            <tr className="border-b border-slate-100">
              <th className="pb-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Description</th>
              <th className="pb-2 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">Qty</th>
              <th className="pb-2 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">Unit</th>
              <th className="pb-2 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">VAT</th>
              <th className="pb-2 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {invoice.items.map(item => (
              <tr key={item.id}>
                <td className="py-2 text-slate-900">{item.description}</td>
                <td className="py-2 text-right tabular-nums text-slate-700">{item.quantity}</td>
                <td className="py-2 text-right tabular-nums text-slate-700">{formatPence(item.unit_price)}</td>
                <td className="py-2 text-right tabular-nums text-slate-700">{Math.round(item.tax_rate * 100)}%</td>
                <td className="py-2 text-right tabular-nums font-medium text-slate-900">{formatPence(item.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Totals */}
        <div className="flex justify-end">
          <div className="w-48 space-y-1 text-sm">
            <div className="flex justify-between text-slate-500">
              <span>Subtotal</span>
              <span className="tabular-nums">{formatPence(invoice.subtotal)}</span>
            </div>
            <div className="flex justify-between text-slate-500">
              <span>VAT</span>
              <span className="tabular-nums">{formatPence(invoice.tax_amount)}</span>
            </div>
            <div className="flex justify-between font-semibold text-slate-900 text-base pt-1 border-t border-slate-200">
              <span>Total</span>
              <span className="tabular-nums">{formatPence(invoice.total)}</span>
            </div>
            {invoice.amount_paid > 0 && (
              <>
                <div className="flex justify-between text-green-600">
                  <span>Paid</span>
                  <span className="tabular-nums">−{formatPence(invoice.amount_paid)}</span>
                </div>
                <div className="flex justify-between font-semibold text-slate-900 pt-1 border-t border-slate-200">
                  <span>Balance due</span>
                  <span className="tabular-nums">{formatPence(balance)}</span>
                </div>
              </>
            )}
          </div>
        </div>

        {invoice.notes && (
          <div className="mt-6 pt-4 border-t border-slate-100">
            <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">Notes</p>
            <p className="text-sm text-slate-700 whitespace-pre-line">{invoice.notes}</p>
          </div>
        )}
      </div>

      {/* Payment form */}
      {showPaymentForm && (
        <div className="card">
          <h2 className="text-base font-semibold text-slate-900 mb-4">Record payment</h2>
          <form onSubmit={handleSubmit(d => addPayment.mutate(d))} noValidate className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="pay-amount" className="field-label">
                  Amount (£) <span className="text-red-500" aria-hidden="true">*</span>
                </label>
                <input
                  id="pay-amount"
                  type="number"
                  min="0.01"
                  step="0.01"
                  {...register('amount')}
                  className={`input tabular-nums ${errors.amount ? 'input-error' : ''}`}
                  placeholder={(balance / 100).toFixed(2)}
                />
                {errors.amount && <p className="field-error" role="alert">{errors.amount.message}</p>}
              </div>
              <div>
                <label htmlFor="pay-date" className="field-label">Payment date</label>
                <input id="pay-date" type="date" {...register('payment_date')} className="input" />
              </div>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="pay-method" className="field-label">Method</label>
                <select id="pay-method" {...register('method')} className="input">
                  <option value="bank_transfer">Bank transfer</option>
                  <option value="card">Card</option>
                  <option value="cash">Cash</option>
                  <option value="cheque">Cheque</option>
                  <option value="other">Other</option>
                </select>
              </div>
              <div>
                <label htmlFor="pay-ref" className="field-label">Reference</label>
                <input id="pay-ref" {...register('reference')} className="input" placeholder="e.g. BACS ref" />
              </div>
            </div>

            {addPayment.isError && (
              <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2" role="alert">
                <p className="text-sm text-red-700">
                  {(addPayment.error as Error)?.message ?? 'Failed to record payment'}
                </p>
              </div>
            )}

            <div className="flex gap-3">
              <button type="submit" disabled={isSubmitting || addPayment.isPending} className="btn-primary">
                {addPayment.isPending ? (
                  <>
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" aria-hidden="true" />
                    Saving…
                  </>
                ) : 'Record payment'}
              </button>
              <button type="button" onClick={() => setShowPaymentForm(false)} className="btn-secondary">Cancel</button>
            </div>
          </form>
        </div>
      )}

      {/* Payment history */}
      {invoice.payments.length > 0 && (
        <div className="card">
          <h2 className="text-base font-semibold text-slate-900 mb-3">Payment history</h2>
          <ul className="divide-y divide-slate-100">
            {invoice.payments.map(p => (
              <li key={p.id} className="flex items-center justify-between py-3 first:pt-0 last:pb-0 text-sm">
                <div>
                  <p className="font-medium text-slate-900">{formatDate(p.payment_date)}</p>
                  <p className="text-xs text-slate-500">
                    {p.method.replace('_', ' ')}
                    {p.reference ? ` · ${p.reference}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="tabular-nums font-semibold text-green-700">{formatPence(p.amount)}</span>
                  {isOwner && (
                    <button
                      type="button"
                      onClick={() => removePayment.mutate(p.id)}
                      className="text-xs text-red-600 hover:text-red-700"
                    >
                      Remove
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
