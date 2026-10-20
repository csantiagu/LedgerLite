'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import Link from 'next/link';
import { AppShell } from '@/components/layout/AppShell';
import { RoleGuard } from '@/components/RoleGuard';
import { api } from '@/lib/api';

type Client = { id: string; name: string; email: string | null; phone: string | null; is_active: number };

const Schema = z.object({
  name: z.string().min(1),
  email: z.string().email().or(z.literal('')).optional(),
  phone: z.string().optional(),
  address: z.string().optional(),
  tax_id: z.string().optional(),
  notes: z.string().optional(),
});
type FormData = z.infer<typeof Schema>;

export default function SettingsClientsPage() {
  return (
    <AppShell>
      <RoleGuard allowedRoles={['owner']}>
        <Content />
      </RoleGuard>
    </AppShell>
  );
}

function Content() {
  const qc = useQueryClient();
  const { data: clients = [] } = useQuery<Client[]>({ queryKey: ['clients'], queryFn: () => api('/api/v1/clients') });
  const form = useForm<FormData>({ resolver: zodResolver(Schema) });

  const create = useMutation({
    mutationFn: (data: FormData) => api('/api/v1/clients', {
      method: 'POST',
      body: JSON.stringify({
        ...data,
        email: data.email || null,
        phone: data.phone || null,
        address: data.address || null,
        tax_id: data.tax_id || null,
        notes: data.notes || null,
      }),
    }),
    onSuccess: () => {
      form.reset();
      qc.invalidateQueries({ queryKey: ['clients'] });
    },
  });

  const deactivate = useMutation({
    mutationFn: (id: string) => api(`/api/v1/clients/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['clients'] }),
  });

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Settings · Clients</h1>
      </div>

      <div className="card space-y-4">
        <h2 className="text-base font-semibold text-slate-900">Add client</h2>
        <form onSubmit={form.handleSubmit(d => create.mutate(d))} className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <input {...form.register('name')} className="input" placeholder="Client name" />
          <input {...form.register('email')} className="input" placeholder="Email" />
          <button type="submit" className="btn-primary" disabled={create.isPending}>{create.isPending ? 'Saving…' : 'Add'}</button>
        </form>
      </div>

      <div className="card">
        <h2 className="text-base font-semibold text-slate-900 mb-3">Client list</h2>
        <ul className="divide-y divide-slate-100">
          {clients.map(c => (
            <li key={c.id} className="flex items-center justify-between py-3">
              <Link href={`/clients/view?id=${c.id}`} className="min-w-0 flex-1 group">
                <p className="text-sm font-medium text-slate-900 group-hover:text-blue-700">{c.name}</p>
                <p className="text-xs text-slate-500">{c.email || '—'}</p>
              </Link>
              <button type="button" className="text-xs text-red-600 hover:text-red-700" onClick={() => { if (confirm(`Deactivate ${c.name}? Existing invoices are not affected.`)) deactivate.mutate(c.id); }}>
                Deactivate
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
