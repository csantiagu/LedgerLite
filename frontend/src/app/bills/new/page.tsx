'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { RoleGuard } from '@/components/RoleGuard';
import { api, API_BASE } from '@/lib/api';
import { formatPence } from '@/lib/formatters';
import { useAuthStore } from '@/lib/auth';

const today = new Date().toISOString().slice(0, 10);

// Exact category names that REQUIRE an attachment
const REQUIRES_ATTACHMENT_CATEGORIES = ['professional services', 'sub-contract', 'subcontract'];

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

export default function NewBillPage() {
  return (
    <AppShell>
      <RoleGuard allowedRoles={['owner']}>
        <NewBillContent />
      </RoleGuard>
    </AppShell>
  );
}

function NewBillContent() {
  const router = useRouter();
  const qc = useQueryClient();
  const token = useAuthStore(s => s.accessToken);

  const [attachmentFile, setAttachmentFile] = useState<File | null>(null);
  const [uploadError, setUploadError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: vendors = [] } = useQuery<Vendor[]>({
    queryKey: ['vendors'],
    queryFn: () => api<Vendor[]>('/api/v1/vendors'),
  });
  const { data: categories = [] } = useQuery<Category[]>({
    queryKey: ['expense-categories'],
    queryFn: () => api<Category[]>('/api/v1/expense-categories'),
  });

  const { register, control, handleSubmit, watch, formState: { errors } } = useForm<FormData>({
    resolver: zodResolver(Schema),
    defaultValues: {
      vendor_id: '',
      bill_number: '',
      issue_date: today,
      due_date: today,
      notes: '',
      items: [{ description: '', quantity: 1, unit_price: 0, tax_rate: 0, expense_category_id: '' }],
    },
  });

  const { fields, append, remove } = useFieldArray({ control, name: 'items' });
  const items = watch('items');
  const subtotal = items.reduce((s, i) => s + Math.round((i.quantity || 0) * Math.round((i.unit_price || 0) * 100)), 0);
  const vat = items.reduce((s, i) => s + Math.round(Math.round((i.quantity || 0) * Math.round((i.unit_price || 0) * 100)) * (i.tax_rate || 0)), 0);

  // Require attachment when any line uses Professional Services or Sub-contract
  const selectedCategoryIds = items.map(i => i.expense_category_id).filter(Boolean);
  const matchedCategories = categories.filter(c => selectedCategoryIds.includes(c.id));
  const requiresAttachment = matchedCategories.some(c =>
    REQUIRES_ATTACHMENT_CATEGORIES.includes(c.name.trim().toLowerCase())
  );
  const attachmentMissing = requiresAttachment && !attachmentFile;

  const create = useMutation({
    mutationFn: (data: FormData) =>
      api<{ id: string }>('/api/v1/bills', {
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
    onSuccess: async ({ id }) => {
      // Upload attachment if one was selected
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
          if (!res.ok) setUploadError('Bill saved but attachment upload failed — add it from the bill page.');
        } catch {
          setUploadError('Bill saved but attachment upload failed — add it from the bill page.');
        }
      }
      qc.invalidateQueries({ queryKey: ['bills'] });
      router.push(`/bills/view?id=${id}`);
    },
  });

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    setAttachmentFile(file);
    setUploadError('');
  };

  const removeFile = () => {
    setAttachmentFile(null);
    setUploadError('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">New bill</h1>
        <p className="mt-1 text-sm text-slate-500">Create supplier bill with line-level categories.</p>
      </div>

      <form onSubmit={handleSubmit(d => create.mutate(d))} noValidate className="space-y-6">
        <div className="card space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="field-label">Vendor</label>
              <select {...register('vendor_id')} className={`input ${errors.vendor_id ? 'input-error' : ''}`}>
                <option value="">Select vendor…</option>
                {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
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
              <select {...register(`items.${i}.expense_category_id`)} className="input">
                <option value="">No category</option>
                {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
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
            <div className="flex items-center gap-3 p-3 rounded-lg border border-blue-200 bg-blue-50">
              <svg className="h-8 w-8 text-blue-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
              </svg>
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
                : 'border-slate-300 bg-white hover:border-blue-400 hover:bg-blue-50'
            }`}>
              <svg className={`h-8 w-8 ${attachmentMissing ? 'text-red-400' : 'text-slate-300'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
              </svg>
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

          {uploadError && (
            <p className="text-xs text-amber-600">{uploadError}</p>
          )}
        </div>

        <div className="card">
          <label className="field-label">Notes</label>
          <textarea {...register('notes')} rows={3} className="input resize-none" />
        </div>

        {create.isError && <p className="text-sm text-red-600">{(create.error as Error).message}</p>}

        <div className="flex gap-3 items-center">
          <button type="submit" disabled={create.isPending || attachmentMissing} className="btn-primary">
            {create.isPending ? 'Saving…' : 'Save bill'}
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
