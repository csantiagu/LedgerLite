'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { AppShell } from '@/components/layout/AppShell';
import { RoleGuard } from '@/components/RoleGuard';
import { api } from '@/lib/api';

type Category = {
  id: string;
  name: string;
  description: string | null;
};

const Schema = z.object({
  name: z.string().min(1, 'Name required').max(120),
  description: z.string().max(500).optional(),
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
    defaultValues: { name: '', description: '' },
  });

  const editForm = useForm<FormData>({
    resolver: zodResolver(Schema),
    values: editing ? { name: editing.name, description: editing.description ?? '' } : { name: '', description: '' },
  });

  const create = useMutation({
    mutationFn: (data: FormData) =>
      api('/api/v1/expense-categories', {
        method: 'POST',
        body: JSON.stringify({ name: data.name.trim(), description: data.description?.trim() || null }),
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
        body: JSON.stringify({ name: data.name.trim(), description: data.description?.trim() || null }),
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
        <p className="mt-1 text-sm text-slate-500">Create and maintain expense categories used on bills and transactions.</p>
      </div>

      <div className="card space-y-4">
        <h2 className="text-base font-semibold text-slate-900">Create category</h2>
        <form onSubmit={createForm.handleSubmit((d) => create.mutate(d))} className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-3">
          <div>
            <input {...createForm.register('name')} className="input" placeholder="Category name" />
            {createForm.formState.errors.name && <p className="field-error">{createForm.formState.errors.name.message}</p>}
          </div>
          <input {...createForm.register('description')} className="input" placeholder="Description (optional)" />
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
              <th className="py-3 px-4 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {categories.map((cat) => (
              <tr key={cat.id} className="hover:bg-slate-50">
                <td className="py-3 px-4 font-medium">{cat.name}</td>
                <td className="py-3 px-4 text-slate-600">{cat.description || '—'}</td>
                <td className="py-3 px-4 text-right">
                  <button type="button" className="text-sm text-blue-600 hover:text-blue-700" onClick={() => setEditing(cat)}>
                    Edit
                  </button>
                </td>
              </tr>
            ))}
            {categories.length === 0 && (
              <tr>
                <td colSpan={3} className="py-8 px-4 text-center text-sm text-slate-500">No categories yet.</td>
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
            className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-3"
          >
            <div>
              <input {...editForm.register('name')} className="input" />
              {editForm.formState.errors.name && <p className="field-error">{editForm.formState.errors.name.message}</p>}
            </div>
            <input {...editForm.register('description')} className="input" />
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
