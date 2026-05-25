'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useRouter } from 'next/navigation';
import { AppShell } from '@/components/layout/AppShell';
import { RoleGuard } from '@/components/RoleGuard';
import { api } from '@/lib/api';
import { formatPence } from '@/lib/formatters';

const today = new Date().toISOString().slice(0, 10);

const ItemSchema = z.object({
  description:         z.string().min(1, 'Required'),
  quantity:            z.coerce.number().positive('Must be > 0'),
  unit_price:          z.coerce.number().int().min(0, 'Must be ≥ 0'),
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
  const subtotal = items.reduce((s, i) => s + Math.round((i.quantity || 0) * (i.unit_price || 0)), 0);
  const vat = items.reduce((s, i) => s + Math.round(Math.round((i.quantity || 0) * (i.unit_price || 0)) * (i.tax_rate || 0)), 0);

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
          items: data.items.map(i => ({ ...i, expense_category_id: i.expense_category_id || null })),
        }),
      }),
    onSuccess: ({ id }) => {
      qc.invalidateQueries({ queryKey: ['bills'] });
      router.push(`/bills/${id}`);
    },
  });

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
              <input {...register(`items.${i}.unit_price`)} type="number" step="1" className="input text-right tabular-nums" />
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

        <div className="card">
          <label className="field-label">Notes</label>
          <textarea {...register('notes')} rows={3} className="input resize-none" />
        </div>

        {create.isError && <p className="text-sm text-red-600">{(create.error as Error).message}</p>}

        <div className="flex gap-3">
          <button type="submit" disabled={create.isPending} className="btn-primary">
            {create.isPending ? 'Saving…' : 'Save bill'}
          </button>
          <button type="button" onClick={() => router.back()} className="btn-secondary">Cancel</button>
        </div>
      </form>
    </div>
  );
}
