'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { AppShell } from '@/components/layout/AppShell';
import { api } from '@/lib/api';
import { useAuthStore } from '@/lib/auth';
import { formatDate, formatPence, statusBadgeClass, statusLabel } from '@/lib/formatters';

type BillItem = {
  id: string;
  description: string;
  quantity: number;
  unit_price: number;
  tax_rate: number;
  amount: number;
  expense_category_name: string | null;
};

type BillPayment = {
  id: string;
  amount: number;
  payment_date: string;
  method: string | null;
  reference: string | null;
};

type Bill = {
  id: string;
  bill_number: string | null;
  status: string;
  vendor_name: string;
  issue_date: string | null;
  due_date: string | null;
  subtotal: number;
  tax_amount: number;
  total: number;
  amount_paid: number;
  notes: string | null;
  flagged: number;
  accountant_notes: string | null;
  attachment_r2_key: string | null;
  items: BillItem[];
  payments: BillPayment[];
};

const PaymentSchema = z.object({
  amount: z.coerce.number().int().positive(),
  payment_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  method: z.string().optional(),
  reference: z.string().optional(),
  notes: z.string().optional(),
});
type PaymentForm = z.infer<typeof PaymentSchema>;

export default function BillDetailPage() {
  return (
    <AppShell>
      <BillDetail />
    </AppShell>
  );
}

function BillDetail() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const role = useAuthStore(s => s.role);
  const token = useAuthStore(s => s.accessToken);
  const isOwner = role === 'owner';
  const isAccountant = role === 'accountant';

  const [flagged, setFlagged] = useState(false);
  const [accountantNotes, setAccountantNotes] = useState('');

  const { data: bill, isLoading } = useQuery<Bill>({
    queryKey: ['bill', id],
    queryFn: () => api<Bill>(`/api/v1/bills/${id}`),
  });

  useEffect(() => {
    if (!bill) return;
    setFlagged(bill.flagged === 1);
    setAccountantNotes(bill.accountant_notes ?? '');
  }, [bill]);

  const paymentForm = useForm<PaymentForm>({
    resolver: zodResolver(PaymentSchema),
    defaultValues: { payment_date: new Date().toISOString().slice(0, 10), method: 'bank_transfer' },
  });

  const addPayment = useMutation({
    mutationFn: (data: PaymentForm) => api(`/api/v1/bills/${id}/payments`, {
      method: 'POST',
      body: JSON.stringify({ ...data, reference: data.reference || null, notes: data.notes || null }),
    }),
    onSuccess: () => {
      paymentForm.reset({ payment_date: new Date().toISOString().slice(0, 10), method: 'bank_transfer' });
      qc.invalidateQueries({ queryKey: ['bill', id] });
      qc.invalidateQueries({ queryKey: ['bills'] });
    },
  });

  const deletePayment = useMutation({
    mutationFn: (paymentId: string) => api(`/api/v1/bills/${id}/payments/${paymentId}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['bill', id] }),
  });

  const saveFlag = useMutation({
    mutationFn: (payload: { flagged: boolean; accountant_notes: string }) =>
      api(`/api/v1/bills/${id}/flag`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bill', id] });
      qc.invalidateQueries({ queryKey: ['bills'] });
      qc.invalidateQueries({ queryKey: ['bills-flagged'] });
    },
  });

  const uploadAttachment = useMutation({
    mutationFn: async (file: File) => {
      if (!token) throw new Error('No access token');
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/bills/${id}/attachments`, {
        method: 'POST',
        credentials: 'include',
        headers: { Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' },
        body: form,
      });
      if (!res.ok) throw new Error('Upload failed');
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['bill', id] }),
  });

  const openAttachment = async () => {
    const response = await api<{ url: string }>(`/api/v1/bills/${id}/attachments`);
    window.open(response.url, '_blank', 'noopener,noreferrer');
  };

  if (isLoading) return <div className="h-24 w-full animate-pulse rounded bg-slate-100" />;
  if (!bill) return <p className="text-sm text-slate-500">Bill not found.</p>;

  const currentFlagged = flagged;
  const currentNotes = accountantNotes;

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-slate-500">{bill.bill_number || bill.id.slice(0, 8).toUpperCase()}</p>
          <h1 className="text-2xl font-bold text-slate-900">{bill.vendor_name}</h1>
          <span className={`badge mt-2 ${statusBadgeClass[bill.status] ?? 'badge-gray'}`}>{statusLabel[bill.status] ?? bill.status}</span>
          {bill.flagged === 1 && <span className="badge badge-red ml-2">Flagged</span>}
        </div>
        {isOwner && (
          <div className="flex gap-2">
            <button type="button" className="btn-secondary" onClick={openAttachment} disabled={!bill.attachment_r2_key}>
              View attachment
            </button>
          </div>
        )}
      </div>

      <div className="card">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6 text-sm">
          <div><p className="text-slate-500">Issue date</p><p className="font-medium">{bill.issue_date ? formatDate(bill.issue_date) : '—'}</p></div>
          <div><p className="text-slate-500">Due date</p><p className="font-medium">{bill.due_date ? formatDate(bill.due_date) : '—'}</p></div>
          <div><p className="text-slate-500">Amount paid</p><p className="font-medium">{formatPence(bill.amount_paid)}</p></div>
        </div>
        <table className="w-full text-sm mb-6">
          <thead>
            <tr className="border-b border-slate-100">
              <th className="pb-2 text-left text-xs text-slate-500 uppercase">Description</th>
              <th className="pb-2 text-left text-xs text-slate-500 uppercase">Category</th>
              <th className="pb-2 text-right text-xs text-slate-500 uppercase">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {bill.items.map(item => (
              <tr key={item.id}>
                <td className="py-2">{item.description}</td>
                <td className="py-2 text-slate-500">{item.expense_category_name || '—'}</td>
                <td className="py-2 text-right tabular-nums">{formatPence(item.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="w-56 ml-auto space-y-1 text-sm">
          <div className="flex justify-between"><span className="text-slate-500">Subtotal</span><span>{formatPence(bill.subtotal)}</span></div>
          <div className="flex justify-between"><span className="text-slate-500">VAT</span><span>{formatPence(bill.tax_amount)}</span></div>
          <div className="flex justify-between font-semibold"><span>Total</span><span>{formatPence(bill.total)}</span></div>
        </div>
      </div>

      {isOwner && (
        <div className="card space-y-4">
          <h2 className="text-base font-semibold text-slate-900">Owner actions</h2>

          <form
            onSubmit={paymentForm.handleSubmit(d => addPayment.mutate(d))}
            className="grid grid-cols-1 sm:grid-cols-5 gap-2 items-end"
          >
            <div>
              <label className="field-label">Amount (p)</label>
              <input type="number" step="1" min="1" {...paymentForm.register('amount')} className="input" />
            </div>
            <div>
              <label className="field-label">Date</label>
              <input type="date" {...paymentForm.register('payment_date')} className="input" />
            </div>
            <div>
              <label className="field-label">Method</label>
              <input {...paymentForm.register('method')} className="input" />
            </div>
            <div>
              <label className="field-label">Reference</label>
              <input {...paymentForm.register('reference')} className="input" />
            </div>
            <button type="submit" className="btn-primary" disabled={addPayment.isPending}>
              {addPayment.isPending ? 'Saving…' : 'Add payment'}
            </button>
          </form>

          <div className="flex items-center gap-3">
            <input
              type="file"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) uploadAttachment.mutate(file);
              }}
              className="text-sm"
            />
            {uploadAttachment.isPending && <span className="text-sm text-slate-500">Uploading…</span>}
          </div>

          {bill.payments.length > 0 && (
            <ul className="divide-y divide-slate-100">
              {bill.payments.map(p => (
                <li key={p.id} className="flex justify-between items-center py-2">
                  <div className="text-sm">
                    <p className="font-medium">{formatDate(p.payment_date)} · {formatPence(p.amount)}</p>
                    <p className="text-slate-500 text-xs">{p.method || '—'} {p.reference ? `· ${p.reference}` : ''}</p>
                  </div>
                  <button type="button" onClick={() => deletePayment.mutate(p.id)} className="text-sm text-red-600 hover:text-red-700">
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {isAccountant && (
        <div className="card space-y-4">
          <h2 className="text-base font-semibold text-slate-900">Accountant review</h2>
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={currentFlagged}
              onChange={(e) => setFlagged(e.target.checked)}
            />
            Flag for owner
          </label>
          <div>
            <label className="field-label">Notes</label>
            <textarea
              rows={4}
              className="input resize-none"
              value={currentNotes}
              onChange={(e) => setAccountantNotes(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="btn-primary"
            onClick={() => saveFlag.mutate({ flagged: currentFlagged, accountant_notes: currentNotes })}
            disabled={saveFlag.isPending}
          >
            {saveFlag.isPending ? 'Saving…' : 'Save review'}
          </button>
        </div>
      )}
    </div>
  );
}
