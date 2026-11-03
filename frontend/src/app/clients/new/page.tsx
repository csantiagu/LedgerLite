'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { AppShell } from '@/components/layout/AppShell';
import { RoleGuard } from '@/components/RoleGuard';
import { api } from '@/lib/api';
import { ClientForm } from '../ClientForm';
import { clientBody, type ClientFormData } from '@/lib/clients';

export default function NewClientPage() {
  return (
    <AppShell>
      <RoleGuard allowedRoles={['owner']}>
        <NewClientContent />
      </RoleGuard>
    </AppShell>
  );
}

function NewClientContent() {
  const router = useRouter();
  const qc = useQueryClient();

  const create = useMutation({
    mutationFn: (data: ClientFormData) =>
      api<{ id: string }>('/api/v1/clients', { method: 'POST', body: JSON.stringify(clientBody(data)) }),
    onSuccess: ({ id }) => {
      qc.invalidateQueries({ queryKey: ['clients'] });
      router.push(`/clients/view?id=${id}`);
    },
  });

  return (
    <div className="max-w-xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Add client</h1>
        <p className="mt-1 text-sm text-slate-500">Create a new client account.</p>
      </div>

      <div className="card">
        <ClientForm
          onSubmit={d => create.mutate(d)}
          submitLabel="Save client"
          pending={create.isPending}
          error={create.error as Error | null}
          onCancel={() => router.back()}
        />
      </div>
    </div>
  );
}
