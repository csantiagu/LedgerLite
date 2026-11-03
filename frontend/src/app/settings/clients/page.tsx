'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { RoleGuard } from '@/components/RoleGuard';
import { api } from '@/lib/api';
import { ClientForm } from '../../clients/ClientForm';
import { clientBody, type ClientFormData } from '@/lib/clients';

type Client = { id: string; name: string; company_name: string | null; email: string | null; phone: string | null; is_active: number };

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

  const [formKey, setFormKey] = useState(0);
  const create = useMutation({
    mutationFn: (data: ClientFormData) =>
      api('/api/v1/clients', { method: 'POST', body: JSON.stringify(clientBody(data)) }),
    onSuccess: () => {
      setFormKey(k => k + 1);   // a fresh, empty form for the next client
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
        <ClientForm
          key={formKey}
          onSubmit={d => create.mutate(d)}
          submitLabel="Add client"
          pending={create.isPending}
          error={create.error as Error | null}
        />
      </div>

      <div className="card">
        <h2 className="text-base font-semibold text-slate-900 mb-3">Client list</h2>
        <ul className="divide-y divide-slate-100">
          {clients.map(c => (
            <li key={c.id} className="flex items-center justify-between py-3">
              <Link href={`/clients/view?id=${c.id}`} className="min-w-0 flex-1 group">
                <p className="text-sm font-medium text-slate-900 group-hover:text-blue-700">{c.name}</p>
                <p className="text-xs text-slate-500">{[c.company_name, c.email].filter(Boolean).join(' · ') || '—'}</p>
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
