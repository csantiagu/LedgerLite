'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { AppShell } from '@/components/layout/AppShell';
import { RoleGuard } from '@/components/RoleGuard';
import { api } from '@/lib/api';
import { valueToVat, VAT_CHOICES, vatChoicesFor, vatLabel, vatToValue } from '@/lib/vat';

type Category = {
  id: string;
  name: string;
  description: string | null;
  default_vat_rate: number | null;
  vat_box: VatBox;
};

type VatBox = 'purchases' | 'sales' | 'excluded';
/** Where a category's bank lines go in the VAT return */
const VAT_BOXES: Array<{ value: VatBox; label: string }> = [
  { value: 'purchases', label: 'Purchases (boxes 4, 7)' },
  { value: 'sales', label: 'Sales (boxes 1, 6)' },
  { value: 'excluded', label: 'Not in the VAT return' },
];
const vatBoxLabel = (b: VatBox) => VAT_BOXES.find(x => x.value === b)?.label ?? b;

const Schema = z.object({
  name: z.string().min(1, 'Name required').max(120),
  description: z.string().max(500).optional(),
  vat: z.string(),   // '' = ask on each line, else the rate (see lib/vat)
  vatBox: z.enum(['purchases', 'sales', 'excluded']),
});
type FormData = z.infer<typeof Schema>;

export default function CategoriesPage() {
  return (
    <AppShell>
      <RoleGuard allowedRoles={['owner']}>
        <CategoriesContent />
      </RoleGuard>
    </AppShell>
  );
}

function CategoriesContent() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Category | null>(null);

  const { data: categories = [] } = useQuery<Category[]>({
    queryKey: ['expense-categories'],
    queryFn: () => api<Category[]>('/api/v1/expense-categories'),
  });

  const createForm = useForm<FormData>({
    resolver: zodResolver(Schema),
    defaultValues: { name: '', description: '', vat: '', vatBox: 'purchases' },
  });

  const editForm = useForm<FormData>({
    resolver: zodResolver(Schema),
    values: editing
      ? { name: editing.name, description: editing.description ?? '', vat: vatToValue(editing.default_vat_rate), vatBox: editing.vat_box }
      : { name: '', description: '', vat: '', vatBox: 'purchases' },
  });

  const create = useMutation({
    mutationFn: (data: FormData) =>
      api('/api/v1/expense-categories', {
        method: 'POST',
        body: JSON.stringify({
          name: data.name.trim(), description: data.description?.trim() || null, defaultVatRate: valueToVat(data.vat),
          vatBox: data.vatBox,
        }),
      }),
    onSuccess: () => {
      createForm.reset();
      qc.invalidateQueries({ queryKey: ['expense-categories'] });
    },
  });

  const update = useMutation({
    mutationFn: ({ id, data }: { id: string; data: FormData }) =>
      api(`/api/v1/expense-categories/${id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: data.name.trim(), description: data.description?.trim() || null, defaultVatRate: valueToVat(data.vat),
          vatBox: data.vatBox,
        }),
      }),
    onSuccess: () => {
      setEditing(null);
      qc.invalidateQueries({ queryKey: ['expense-categories'] });
    },
  });

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Settings · Categories</h1>
        <p className="mt-1 text-sm text-slate-500">
          Create and maintain expense categories used on bills and transactions. A category&rsquo;s usual VAT is
          filled in on bank lines you give it (you can still change it per line). The VAT return box says where
          those lines count: money paid out is a purchase, sales categories are sales, and transfers, loans,
          tax and wages stay out of the return.
        </p>
      </div>

      <div className="card space-y-4">
        <h2 className="text-base font-semibold text-slate-900">Create category</h2>
        <form onSubmit={createForm.handleSubmit((d) => create.mutate(d))} className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_10rem_12rem_auto] gap-3">
          <div>
            <input {...createForm.register('name')} className="input" placeholder="Category name" />
            {createForm.formState.errors.name && <p className="field-error">{createForm.formState.errors.name.message}</p>}
          </div>
          <input {...createForm.register('description')} className="input" placeholder="Description (optional)" />
          <select {...createForm.register('vat')} className="input" aria-label="Usual VAT">
            <option value="">VAT: ask each time</option>
            {VAT_CHOICES.map(v => <option key={v.value} value={v.value}>{v.label}</option>)}
          </select>
          <select {...createForm.register('vatBox')} className="input" aria-label="VAT return box">
            {VAT_BOXES.map(b => <option key={b.value} value={b.value}>{b.label}</option>)}
          </select>
          <button type="submit" className="btn-primary" disabled={create.isPending}>
            {create.isPending ? 'Saving…' : 'Add'}
          </button>
        </form>
        {create.isError && <p className="text-sm text-red-600">{(create.error as Error).message}</p>}
      </div>

      <div className="card overflow-hidden p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100">
              <th className="py-3 px-4 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Name</th>
              <th className="py-3 px-4 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Description</th>
              <th className="py-3 px-4 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Usual VAT</th>
              <th className="py-3 px-4 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">VAT return</th>
              <th className="py-3 px-4 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {categories.map((cat) => (
              <tr key={cat.id} className="hover:bg-slate-50">
                <td className="py-3 px-4 font-medium">{cat.name}</td>
                <td className="py-3 px-4 text-slate-600">{cat.description || '—'}</td>
                <td className="py-3 px-4 text-slate-600 whitespace-nowrap">{vatLabel(cat.default_vat_rate, 'Ask each time')}</td>
                <td className="py-3 px-4 text-slate-600 whitespace-nowrap">{vatBoxLabel(cat.vat_box)}</td>
                <td className="py-3 px-4 text-right">
                  <button type="button" className="text-sm text-blue-600 hover:text-blue-700" onClick={() => setEditing(cat)}>
                    Edit
                  </button>
                </td>
              </tr>
            ))}
            {categories.length === 0 && (
              <tr>
                <td colSpan={5} className="py-8 px-4 text-center text-sm text-slate-500">No categories yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {editing && (
        <div className="card space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-slate-900">Edit category</h2>
            <button type="button" className="text-sm text-slate-500 hover:text-slate-700" onClick={() => setEditing(null)}>
              Close
            </button>
          </div>
          <form
            onSubmit={editForm.handleSubmit((d) => update.mutate({ id: editing.id, data: d }))}
            className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_10rem_12rem_auto] gap-3"
          >
            <div>
              <input {...editForm.register('name')} className="input" />
              {editForm.formState.errors.name && <p className="field-error">{editForm.formState.errors.name.message}</p>}
            </div>
            <input {...editForm.register('description')} className="input" />
            <select {...editForm.register('vat')} className="input" aria-label="Usual VAT">
              <option value="">VAT: ask each time</option>
              {vatChoicesFor(editing.default_vat_rate).map(v => <option key={v.value} value={v.value}>{v.label}</option>)}
            </select>
            <select {...editForm.register('vatBox')} className="input" aria-label="VAT return box">
              {VAT_BOXES.map(b => <option key={b.value} value={b.value}>{b.label}</option>)}
            </select>
            <button type="submit" className="btn-primary" disabled={update.isPending}>
              {update.isPending ? 'Updating…' : 'Update'}
            </button>
          </form>
          {update.isError && <p className="text-sm text-red-600">{(update.error as Error).message}</p>}
        </div>
      )}
    </div>
  );
}
