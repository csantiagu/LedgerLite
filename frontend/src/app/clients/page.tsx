'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { AppShell } from '@/components/layout/AppShell';
import { api } from '@/lib/api';

type Client = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  is_active: number;
};

export default function ClientsPage() {
  return (
    <AppShell>
      <ClientsContent />
    </AppShell>
  );
}

function ClientsContent() {
  const { data: clients = [], isLoading } = useQuery<Client[]>({
    queryKey: ['clients'],
    queryFn: () => api<Client[]>('/api/v1/clients'),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Clients</h1>
          <p className="mt-1 text-sm text-slate-500">Manage your client accounts.</p>
        </div>
        <Link href="/clients/new" className="btn-primary">
          Add client
        </Link>
      </div>

      <div className="card">
        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map(i => (
              <div key={i} className="h-14 animate-pulse rounded-lg bg-slate-100" />
            ))}
          </div>
        ) : clients.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <svg className="h-10 w-10 text-slate-300 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z" />
            </svg>
            <p className="text-sm font-medium text-slate-500">No clients yet</p>
            <p className="text-xs text-slate-400 mt-1">Add your first client to start creating invoices.</p>
            <Link href="/clients/new" className="btn-primary mt-4">Add client</Link>
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {clients.map(client => (
              <li key={client.id}>
                <Link
                  href={`/clients/view?id=${client.id}`}
                  className="flex items-center justify-between py-4 first:pt-0 last:pb-0 hover:bg-slate-50 -mx-5 px-5 rounded-lg transition-colors"
                >
                  <div>
                    <p className="text-sm font-medium text-slate-900">{client.name}</p>
                    {client.email && (
                      <p className="text-xs text-slate-500">{client.email}</p>
                    )}
                  </div>
                  <svg className="h-4 w-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
