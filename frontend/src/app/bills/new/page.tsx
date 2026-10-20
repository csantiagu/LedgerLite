'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Suspense, useEffect, useRef, useState } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { RoleGuard } from '@/components/RoleGuard';
import { api, API_BASE } from '@/lib/api';
import { formatDate, formatPence, penceToPounds } from '@/lib/formatters';
import {
  bankLineProblem, closestAmountAction, formTotals, grossFromNet, heldBillMessage, initialVendorId,
  linesMissingCategory, mismatchNote, netForGross, unmatchedAmount, type BankLine,
} from '@/lib/billFromBank';
import { attachmentRequired } from '@/lib/bills';
import { useAuthStore } from '@/lib/auth';

const today = new Date().toISOString().slice(0, 10);

const ItemSchema = z.object({
  description:         z.string().min(1, 'Required'),
  quantity:            z.coerce.number().positive('Must be > 0'),
  unit_price:          z.coerce.number().min(0, 'Must be ≥ 0'),
  tax_rate:            z.coerce.number().min(0).max(1),
  expense_category_id: z.string().optional(),
});

const Schema = z.object({
  vendor_id:    z.string().min(1, 'Select a vendor'),
  bill_number:  z.string().max(100).optional(),
  issue_date:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  due_date:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  notes:        z.string().max(1000).optional(),
  items:        z.array(ItemSchema).min(1, 'At least one line required'),
});
type FormData = z.infer<typeof Schema>;

type Vendor = { id: string; name: string };
type Category = { id: string; name: string };

const NEW_VENDOR = '__new__';

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
    return <NewBillContent vendors={vendorsQuery.data ?? []} vendorId={vendorId} line={line} />;
  }
  return <NewBillContent vendors={vendorsQuery.data ?? []} vendorId={vendorId} line={null} />;
}

function NewBillContent({ vendors, vendorId, line }: { vendors: Vendor[]; vendorId: string | null; line: BankLine | null }) {
  const router = useRouter();
  const qc = useQueryClient();
  const token = useAuthStore(s => s.accessToken);

  const [attachmentFile, setAttachmentFile] = useState<File | null>(null);
  // Set once the bill exists but we stayed on the form (attachment or match did not finish)
  const [heldBill, setHeldBill] = useState<{ id: string; message: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: categories = [] } = useQuery<Category[]>({
    queryKey: ['expense-categories'],
    queryFn: () => api<Category[]>('/api/v1/expense-categories'),
  });

  // What's left of the bank payment once earlier matches are taken off
  const bankRemaining = line ? unmatchedAmount(line) : 0;
  const initialVendor = initialVendorId(vendors, vendorId, line);

  const { register, control, handleSubmit, watch, setValue, setError, formState: { errors } } = useForm<FormData>({
    resolver: zodResolver(Schema),
    defaultValues: {
      vendor_id: initialVendor,
      bill_number: '',
      issue_date: line?.date ?? today,
      due_date: line?.date ?? today,
      notes: '',
      items: [{
        description: line ? line.description.slice(0, 500) : '',
        quantity: 1,
        unit_price: line ? penceToPounds(bankRemaining) : 0,
        tax_rate: 0,
        expense_category_id: '',
      }],
    },
  });

  const { fields, append, remove } = useFieldArray({ control, name: 'items' });
  const items = watch('items');
  const vendorChoice = watch('vendor_id');

  const lineRate = Number(items[0]?.tax_rate) || 0;
  // Some VAT rates can't split a gross amount into whole pence. The closest bill is then 1p over.
  const closestTotal = line && fields.length === 1
    ? grossFromNet(netForGross(bankRemaining, lineRate), lineRate)
    : null;
  const { subtotal, vat } = formTotals(items);
  const mismatch = line ? mismatchNote(subtotal + vat, bankRemaining) : null;
  const closest = closestTotal === null ? null : closestAmountAction(closestTotal, bankRemaining);

  // Require attachment when any line uses Professional Services or Sub-contract
  const requiresAttachment = attachmentRequired(categories, items.map(i => i.expense_category_id));
  const attachmentMissing = requiresAttachment && !attachmentFile;

  // A vendor added without leaving the form
  const [newVendorName, setNewVendorName] = useState('');
  const [addedVendorId, setAddedVendorId] = useState<string | null>(null);
  const addVendor = useMutation({
    mutationFn: (name: string) =>
      api<{ id: string }>('/api/v1/vendors', { method: 'POST', body: JSON.stringify({ name }) }),
    onSuccess: ({ id }) => {
      setAddedVendorId(id);
      setNewVendorName('');
      qc.invalidateQueries({ queryKey: ['vendors'] });
    },
  });
  // Select the new vendor once the refreshed list has drawn its option
  useEffect(() => {
    if (!addedVendorId || !vendors.some(v => v.id === addedVendorId)) return;
    setValue('vendor_id', addedVendorId, { shouldValidate: true });
    setAddedVendorId(null);
  }, [addedVendorId, vendors, setValue]);

  const create = useMutation({
    mutationFn: (data: FormData) =>
      api<{ id: string; total: number }>('/api/v1/bills', {
        method: 'POST',
        body: JSON.stringify({
          ...data,
          bill_number: data.bill_number || null,
          issue_date: data.issue_date || null,
          due_date: data.due_date || null,
          notes: data.notes || null,
          items: data.items.map(i => ({
            ...i,
            unit_price: Math.round(i.unit_price * 100),
            expense_category_id: i.expense_category_id || null,
          })),
        }),
      }),
    onSuccess: async ({ id, total }) => {
      // Upload attachment if one was selected. A failure must stay on this page: leaving
      // drops the message, and the bill (and its bank match) would have no receipt.
      let attachmentFailed = false;
      if (attachmentFile && token) {
        try {
          const form = new FormData();
          form.append('file', attachmentFile);
          const res = await fetch(`${API_BASE}/api/v1/bills/${id}/attachments`, {
            method: 'POST',
            credentials: 'include',
            headers: { Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' },
            body: form,
          });
          if (!res.ok) attachmentFailed = true;
        } catch {
          attachmentFailed = true;
        }
      }
      qc.invalidateQueries({ queryKey: ['bills'] });

      // Match the new bill to the bank payment; posting the line in For Review records the payment
      let matchError: string | null = null;
      if (line) {
        try {
          await api('/api/v1/transaction-matches', {
            method: 'POST',
            body: JSON.stringify({
              transactionId: line.id, type: 'bill', targetId: id, allocatedAmount: Math.min(bankRemaining, total),
            }),
          });
          qc.invalidateQueries({ queryKey: ['transactions'] });
          qc.invalidateQueries({ queryKey: ['review-counts'] });
        } catch (e) {
          matchError = (e as Error).message;
        }
      }

      const held = heldBillMessage({ fromBank: !!line, attachmentFailed, matchError });
      if (held) {
        setHeldBill({ id, message: held });
        return;
      }
      if (!line) router.push(`/bills/view?id=${id}`);
      else if (window.history.length > 1) router.back();
      else router.push('/transactions');
    },
  });

  // The bank line takes its category from the bill when posted, so a bill for a bank payment
  // needs one on every line
  const submit = (d: FormData) => {
    if (line) {
      const missing = linesMissingCategory(d.items);
      missing.forEach(i => setError(`items.${i}.expense_category_id`, { message: 'Choose a category' }));
      if (missing.length) return;
    }
    create.mutate(d);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    setAttachmentFile(file);
  };

  const removeFile = () => {
    setAttachmentFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">New bill</h1>
        <p className="mt-1 text-sm text-slate-500">
          {line
            ? 'Record the receipt or supplier invoice for this bank payment. Saving matches the bill to it.'
            : 'Create supplier bill with line-level categories.'}
        </p>
      </div>

      {line && (
        <div className="card flex flex-wrap items-center justify-between gap-3 text-sm">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Bank payment</p>
            <p className="font-medium text-slate-900 truncate">{line.description}</p>
            <p className="text-xs text-slate-500">
              {formatDate(line.date)}{line.account_name && ` · ${line.account_name}`}{line.reference && ` · ${line.reference}`}
            </p>
          </div>
          <div className="text-right">
            <p className="font-semibold tabular-nums text-slate-900">{formatPence(-line.amount)}</p>
            {bankRemaining !== -line.amount && (
              <p className="text-xs text-slate-500">{formatPence(bankRemaining)} not yet matched</p>
            )}
          </div>
        </div>
      )}

      <form onSubmit={handleSubmit(submit)} noValidate className="space-y-6">
        <div className="card space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="field-label">Vendor</label>
              <select
                {...register('vendor_id', {
                  onChange: e => {
                    if (e.target.value === NEW_VENDOR && !newVendorName && line) setNewVendorName(line.description.slice(0, 200));
                  },
                })}
                className={`input ${errors.vendor_id ? 'input-error' : ''}`}
              >
                <option value="">Select vendor…</option>
                {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                <option value={NEW_VENDOR}>+ New vendor…</option>
              </select>
              {vendorChoice === NEW_VENDOR && (
                <div className="mt-2 flex gap-2">
                  <input
                    autoFocus
                    value={newVendorName}
                    onChange={e => setNewVendorName(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') { e.preventDefault(); if (newVendorName.trim()) addVendor.mutate(newVendorName.trim()); }
                    }}
                    className="input flex-1"
                    placeholder="Vendor name"
                    aria-label="New vendor name"
                    maxLength={200}
                  />
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={!newVendorName.trim() || addVendor.isPending}
                    onClick={() => addVendor.mutate(newVendorName.trim())}
                  >
                    {addVendor.isPending ? 'Adding…' : 'Add'}
                  </button>
                </div>
              )}
              {addVendor.isError && <p className="field-error">{(addVendor.error as Error).message}</p>}
              {errors.vendor_id && <p className="field-error">{errors.vendor_id.message}</p>}
            </div>
            <div>
              <label className="field-label">Bill number</label>
              <input {...register('bill_number')} className="input" placeholder="Supplier reference" />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="field-label">Issue date</label>
              <input type="date" {...register('issue_date')} className="input" />
            </div>
            <div>
              <label className="field-label">Due date</label>
              <input type="date" {...register('due_date')} className="input" />
            </div>
          </div>
        </div>

        <div className="card space-y-4">
          <h2 className="text-base font-semibold text-slate-900">Line items</h2>
          {fields.map((field, i) => (
            <div key={field.id} className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_80px_110px_90px_180px_36px] items-start">
              <input {...register(`items.${i}.description`)} placeholder="Description" className="input" />
              <input {...register(`items.${i}.quantity`)} type="number" step="0.01" className="input text-right tabular-nums" />
              <input {...register(`items.${i}.unit_price`)} type="number" step="0.01" min="0" placeholder="0.00" className="input text-right tabular-nums" aria-label="Unit price in pounds" />
              <select {...register(`items.${i}.tax_rate`)} className="input">
                <option value="0">0%</option>
                <option value="0.05">5%</option>
                <option value="0.20">20%</option>
              </select>
              <div>
                <select
                  {...register(`items.${i}.expense_category_id`)}
                  className={`input ${errors.items?.[i]?.expense_category_id ? 'input-error' : ''}`}
                  aria-label="Category"
                >
                  <option value="">{line ? 'Choose category…' : 'No category'}</option>
                  {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                {errors.items?.[i]?.expense_category_id && (
                  <p className="field-error">{errors.items[i]?.expense_category_id?.message}</p>
                )}
              </div>
              <button type="button" onClick={() => remove(i)} disabled={fields.length === 1} className="text-slate-400 hover:text-red-600">×</button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => append({ description: '', quantity: 1, unit_price: 0, tax_rate: 0, expense_category_id: '' })}
            className="text-sm text-blue-600 hover:text-blue-800 font-medium"
          >
            Add line
          </button>

          <div className="border-t border-slate-100 pt-3 text-sm space-y-1">
            <div className="flex justify-between text-slate-500"><span>Subtotal</span><span>{formatPence(subtotal)}</span></div>
            <div className="flex justify-between text-slate-500"><span>VAT</span><span>{formatPence(vat)}</span></div>
            <div className="flex justify-between font-semibold text-slate-900"><span>Total</span><span>{formatPence(subtotal + vat)}</span></div>
            {mismatch && (
              <p className="text-xs text-amber-700 pt-1">
                {mismatch}
                {closest && (
                  <>
                    {' '}
                    <button
                      type="button"
                      className="underline hover:text-amber-900"
                      onClick={() => {
                        setValue('items.0.quantity', 1);
                        setValue('items.0.unit_price', penceToPounds(netForGross(bankRemaining, lineRate)));
                      }}
                    >
                      {closest.label}
                    </button>
                    {closest.note && ` ${closest.note}`}
                  </>
                )}
              </p>
            )}
          </div>
        </div>

        {/* Attachment */}
        <div className="card space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold text-slate-900">Supplier invoice</h2>
              <p className="text-xs text-slate-500 mt-0.5">PDF or image of the original invoice received</p>
            </div>
            {requiresAttachment && (
              <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium ${
                attachmentMissing
                  ? 'bg-red-50 border-red-200 text-red-700'
                  : 'bg-green-50 border-green-200 text-green-700'
              }`}>
                {attachmentMissing ? (
                  <>
                    <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                      <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
                    </svg>
                    Invoice attachment required
                  </>
                ) : (
                  <>
                    <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                      <path fillRule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z" clipRule="evenodd" />
                    </svg>
                    Invoice attached
                  </>
                )}
              </span>
            )}
          </div>

          {requiresAttachment && !attachmentFile && (
            <p className="text-sm text-red-600 font-medium" role="alert">
              A supplier invoice must be attached for Professional Services or Sub-contract bills.
            </p>
          )}

          {attachmentFile ? (
            <div className="flex items-center gap-3 p-3 rounded-lg border border-slate-200 bg-slate-50">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-slate-900 truncate">{attachmentFile.name}</p>
                <p className="text-xs text-slate-500">{(attachmentFile.size / 1024).toFixed(0)} KB</p>
              </div>
              <button
                type="button"
                onClick={removeFile}
                className="text-xs text-slate-500 hover:text-red-600 shrink-0"
                aria-label="Remove file"
              >
                Remove
              </button>
            </div>
          ) : (
            <label className={`flex flex-col items-center justify-center gap-2 p-6 rounded-lg border-2 border-dashed cursor-pointer transition-colors ${
              attachmentMissing
                ? 'border-red-300 bg-red-50 hover:border-red-400'
                : 'border-slate-300 hover:border-slate-500 hover:bg-slate-50'
            }`}>
              <span className={`text-sm font-medium ${attachmentMissing ? 'text-red-700' : 'text-slate-600'}`}>
                {attachmentMissing ? 'Upload required — attach the supplier invoice' : 'Click to attach supplier invoice'}
              </span>
              <span className="text-xs text-slate-400">PDF, PNG, JPG up to 10 MB</span>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.png,.jpg,.jpeg,.webp"
                className="sr-only"
                onChange={handleFileChange}
              />
            </label>
          )}

        </div>

        <div className="card">
          <label className="field-label">Notes</label>
          <textarea {...register('notes')} rows={3} className="input resize-none" />
        </div>

        {create.isError && <p className="text-sm text-red-600">{(create.error as Error).message}</p>}
        {heldBill && (
          <p className="text-sm text-red-600" role="alert">
            {heldBill.message}{' '}
            <Link href={`/bills/view?id=${heldBill.id}`} className="underline">Open the bill</Link>
          </p>
        )}

        <div className="flex gap-3 items-center">
          <button type="submit" disabled={create.isPending || attachmentMissing || !!heldBill || vendorChoice === NEW_VENDOR} className="btn-primary">
            {create.isPending ? 'Saving…' : line ? 'Save and match' : 'Save bill'}
          </button>
          <button type="button" onClick={() => router.back()} className="btn-secondary">Cancel</button>
          {attachmentMissing && (
            <p className="text-sm text-red-600">Attach supplier invoice to continue</p>
          )}
        </div>
      </form>
    </div>
  );
}
