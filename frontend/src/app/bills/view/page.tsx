'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Suspense, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { AppShell } from '@/components/layout/AppShell';
import { AuditHistory } from '@/components/AuditHistory';
import { LockedBadge } from '@/components/PeriodLock';
import { api, API_BASE } from '@/lib/api';
import { useAuthStore } from '@/lib/auth';
import { formatDate, formatPence, statusBadgeClass, statusLabel } from '@/lib/formatters';
import { parsePence } from '@/lib/quickbooksImport';
import { canEditBill, canVoidBill } from '@/lib/bills';

type BillItem = {
  id: string;
  description: string;
  quantity: number;
  unit_price: number;
  tax_rate: number;
  amount: number;
  /** A VAT-only line: the supplier's VAT, with no price */
  vat_amount: number | null;
  expense_category_id: string | null;
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
  vendor_id: string;
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
  attachment_filename: string | null;
  pending_bank_matches: number;
  bank_matches: number;
  items: BillItem[];
  payments: BillPayment[];
};

const PaymentSchema = z.object({
  amount: z.string().trim().min(1, 'Amount required').refine(v => {
    const pence = parsePence(v);
    return pence !== null && !Number.isNaN(pence) && pence > 0;
  }, 'Enter an amount in pounds, such as 12.50'),
  payment_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  method: z.string().optional(),
  reference: z.string().optional(),
  notes: z.string().optional(),
});
type PaymentForm = z.infer<typeof PaymentSchema>;

export default function BillDetailPage() {
  return (
    <AppShell>
      <Suspense>
        <BillDetailRoute />
      </Suspense>
    </AppShell>
  );
}

// Static export can't pre-render one page per id, so the id comes from ?id=
function BillDetailRoute() {
  const id = useSearchParams().get('id');
  if (!id) return <p className="text-sm text-slate-500">No bill selected.</p>;
  return <BillDetail id={id} />;
}

function BillDetail({ id }: { id: string }) {
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
      body: JSON.stringify({ ...data, amount: parsePence(data.amount), reference: data.reference || null, notes: data.notes || null }),
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
  const paymentError = (addPayment.error ?? deletePayment.error) as Error | null;

  // Bills are never deleted: voiding keeps the record. The API refuses while payments or bank matches exist.
  // Categories can be changed on any bill that isn't void, paid or not
  const [editCategories, setEditCategories] = useState(false);
  const [categoryChoice, setCategoryChoice] = useState<Record<string, string>>({});
  const { data: categories = [] } = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ['expense-categories'],
    queryFn: () => api('/api/v1/expense-categories'),
    enabled: editCategories,
  });
  const startCategoryEdit = () => {
    setCategoryChoice(Object.fromEntries((bill?.items ?? []).map(i => [i.id, i.expense_category_id ?? ''])));
    setEditCategories(true);
  };
  const saveCategories = useMutation({
    mutationFn: () => api(`/api/v1/bills/${id}/categories`, {
      method: 'PATCH',
      body: JSON.stringify({
        items: Object.entries(categoryChoice).map(([lineId, cat]) => ({ id: lineId, expense_category_id: cat || null })),
      }),
    }),
    onSuccess: () => {
      setEditCategories(false);
      qc.invalidateQueries({ queryKey: ['bill', id] });
      qc.invalidateQueries({ queryKey: ['bills'] });
    },
  });

  const voidBill = useMutation({
    mutationFn: () => api(`/api/v1/bills/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bill', id] });
      qc.invalidateQueries({ queryKey: ['bills'] });
      qc.invalidateQueries({ queryKey: ['transactions'] });
    },
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
      const res = await fetch(`${API_BASE}/api/v1/bills/${id}/attachments`, {
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
    if (!token) throw new Error('Unauthenticated');
    const res = await fetch(`${API_BASE}/api/v1/bills/${id}/attachments`, {
      method: 'GET',
      credentials: 'include',
      headers: { Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' },
    });
    if (!res.ok) throw new Error(`Failed to open attachment (${res.status})`);
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

  if (isLoading) return <div className="h-24 w-full animate-pulse rounded bg-slate-100" />;
  if (!bill) return <p className="text-sm text-slate-500">Bill not found.</p>;

  const currentFlagged = flagged;
  const currentNotes = accountantNotes;

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-slate-500">{bill.bill_number || bill.id.slice(0, 8).toUpperCase()}</p>
          <h1 className="text-2xl font-bold text-slate-900">
            {isOwner
              ? <Link href={`/vendors/view?id=${bill.vendor_id}`} className="hover:text-blue-700">{bill.vendor_name}</Link>
              : bill.vendor_name}
          </h1>
          <span className={`badge mt-2 ${statusBadgeClass[bill.status] ?? 'badge-gray'}`}>{statusLabel[bill.status] ?? bill.status}</span>
          {bill.flagged === 1 && <span className="badge badge-red ml-2">Flagged</span>}
          <LockedBadge date={bill.issue_date} className="ml-2" />
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex gap-2">
            {canEditBill(bill, isOwner) && (
              <Link href={`/bills/edit?id=${bill.id}`} className="btn-secondary">Edit</Link>
            )}
            {bill.attachment_r2_key && (
              <button type="button" className="btn-secondary" onClick={openAttachment}>
                {bill.attachment_filename ?? 'View attachment'}
              </button>
            )}
            {canVoidBill(bill, isOwner) && (
              <button
                type="button"
                className="btn-danger"
                disabled={voidBill.isPending}
                onClick={() => {
                  if (confirm('Void this bill? It stays on record but no longer counts as owed.')) voidBill.mutate();
                }}
              >
                {voidBill.isPending ? 'Voiding…' : 'Void'}
              </button>
            )}
          </div>
          {voidBill.isError && (
            <p className="text-sm text-red-600 max-w-xs text-right" role="alert">{(voidBill.error as Error).message}</p>
          )}
        </div>
      </div>

      <div className="card">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6 text-sm">
          <div><p className="text-slate-500">Issue date</p><p className="font-medium">{bill.issue_date ? formatDate(bill.issue_date) : '—'}</p></div>
          <div><p className="text-slate-500">Due date</p><p className="font-medium">{bill.due_date ? formatDate(bill.due_date) : '—'}</p></div>
          <div><p className="text-slate-500">Amount paid</p><p className="font-medium">{formatPence(bill.amount_paid)}</p></div>
        </div>
        {isOwner && bill.status !== 'void' && (
          <div className="mb-2 flex items-center justify-end gap-2">
            {editCategories ? (<>
              <button type="button" className="btn-primary text-xs px-3 py-1" disabled={saveCategories.isPending}
                onClick={() => saveCategories.mutate()}>
                {saveCategories.isPending ? 'Saving…' : 'Save categories'}
              </button>
              <button type="button" className="btn-secondary text-xs px-3 py-1" onClick={() => setEditCategories(false)}>Cancel</button>
            </>) : (
              <button type="button" className="text-xs text-blue-600 hover:text-blue-800" onClick={startCategoryEdit}>
                Change categories
              </button>
            )}
          </div>
        )}
        {saveCategories.isError && (
          <p className="mb-2 text-sm text-red-700 text-right" role="alert">{(saveCategories.error as Error).message}</p>
        )}
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
                <td className="py-2">
                  {item.description}
                  {item.vat_amount !== null && <span className="ml-2 text-xs text-slate-500">VAT only</span>}
                </td>
                <td className="py-2 text-slate-500">
                  {editCategories ? (
                    <select className="input py-1 text-sm" aria-label={`Category for ${item.description}`}
                      value={categoryChoice[item.id] ?? ''}
                      onChange={e => setCategoryChoice(c => ({ ...c, [item.id]: e.target.value }))}>
                      <option value="">{item.vat_amount !== null ? 'None needed (VAT only)' : 'No category'}</option>
                      {categories.map(cat => <option key={cat.id} value={cat.id}>{cat.name}</option>)}
                    </select>
                  ) : item.expense_category_name || (item.vat_amount !== null ? '— (VAT only)' : '—')}
                </td>
                <td className="py-2 text-right tabular-nums">
                  {item.vat_amount !== null ? `${formatPence(item.vat_amount)} VAT` : formatPence(item.amount)}
                </td>
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

      {isOwner && bill.status !== 'void' && (
        <div className="card space-y-4">
          <h2 className="text-base font-semibold text-slate-900">Owner actions</h2>
          {paymentError && <p className="text-sm text-red-700" role="alert">{paymentError.message}</p>}

          {bill.pending_bank_matches > 0 ? (
            <p className="text-sm text-slate-600">
              This bill is matched to a bank payment. Post that line on the Bank page to record the payment, or remove the match before adding one by hand.
            </p>
          ) : (
          <form
            onSubmit={paymentForm.handleSubmit(d => addPayment.mutate(d))}
            className="grid grid-cols-1 sm:grid-cols-5 gap-2 items-end"
          >
            <div>
              <label className="field-label">Amount (£)</label>
              <input type="text" inputMode="decimal" autoComplete="off" placeholder="0.00" {...paymentForm.register('amount')} className="input tabular-nums" />
              {paymentForm.formState.errors.amount && (
                <p className="field-error" role="alert">{paymentForm.formState.errors.amount.message}</p>
              )}
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
          )}

          {/* Vendor invoice attachment */}
          <div>
            <label className="field-label">Vendor invoice (PDF / image)</label>
            {bill.attachment_r2_key ? (
              <div className="flex items-center gap-3 p-3 rounded-lg border border-slate-200 bg-slate-50">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-slate-900 truncate">
                    {bill.attachment_filename ?? 'Attached file'}
                  </p>
                  <p className="text-xs text-slate-500">Vendor invoice attached</p>
                </div>
                <div className="flex gap-2 shrink-0">
                  <button type="button" className="btn-secondary text-xs" onClick={openAttachment}>
                    View
                  </button>
                  <label className="btn-secondary text-xs cursor-pointer">
                    Replace
                    <input
                      type="file"
                      accept=".pdf,.png,.jpg,.jpeg,.webp"
                      className="sr-only"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) uploadAttachment.mutate(file);
                      }}
                    />
                  </label>
                </div>
              </div>
            ) : (
              <label className="flex flex-col items-center justify-center gap-2 p-6 rounded-lg border-2 border-dashed border-slate-300 hover:border-slate-500 cursor-pointer transition-colors hover:bg-slate-50">
                <span className="text-sm font-medium text-slate-600">
                  {uploadAttachment.isPending ? 'Uploading…' : 'Click to attach vendor invoice'}
                </span>
                <span className="text-xs text-slate-400">PDF, PNG, JPG up to 10 MB</span>
                <input
                  type="file"
                  accept=".pdf,.png,.jpg,.jpeg,.webp"
                  className="sr-only"
                  disabled={uploadAttachment.isPending}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) uploadAttachment.mutate(file);
                  }}
                />
              </label>
            )}
            {uploadAttachment.isPending && (
              <p className="text-xs text-blue-600 mt-1">Uploading…</p>
            )}
            {uploadAttachment.isSuccess && !uploadAttachment.isPending && (
              <p className="text-xs text-green-600 mt-1">✓ Attachment saved</p>
            )}
            {uploadAttachment.isError && (
              <p className="text-xs text-red-600 mt-1">Upload failed — try again</p>
            )}
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
          {bill.attachment_r2_key && (
            <div className="flex items-center gap-3 p-3 rounded-lg border border-slate-200 bg-slate-50">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-slate-900 truncate">
                  {bill.attachment_filename ?? 'Vendor invoice'}
                </p>
                <p className="text-xs text-slate-500">Vendor invoice attached</p>
              </div>
              <button type="button" className="btn-secondary text-xs shrink-0" onClick={openAttachment}>
                View
              </button>
            </div>
          )}
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

      <div className="card">
        <AuditHistory type="bill" id={bill.id} />
      </div>
    </div>
  );
}
