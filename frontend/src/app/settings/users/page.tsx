'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { api } from '@/lib/api';
import { RoleGuard } from '@/components/RoleGuard';
import { AppShell } from '@/components/layout/AppShell';

const AddUserSchema = z.object({
  name:     z.string().min(1, 'Name required'),
  email:    z.string().email('Valid email required'),
  password: z.string().min(8, 'Min 8 characters'),
  role:     z.literal('accountant'),
});

type UserRow = { id: string; name: string; email: string; role: string; is_active: number };
type FormData = z.infer<typeof AddUserSchema>;

export default function UsersPage() {
  return (
    <AppShell>
      <RoleGuard allowedRoles={['owner']}>
        <UsersContent />
      </RoleGuard>
    </AppShell>
  );
}

function UsersContent() {
  const qc = useQueryClient();

  const { data: users = [], isLoading } = useQuery({
    queryKey: ['users'],
    queryFn: () => api<UserRow[]>('/api/v1/users'),
  });

  const createUser = useMutation({
    mutationFn: (body: FormData) =>
      api('/api/v1/users', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['users'] }); reset(); },
  });

  const toggleActive = useMutation({
    mutationFn: ({ id, is_active }: { id: string; is_active: boolean }) =>
      api(`/api/v1/users/${id}`, { method: 'PATCH', body: JSON.stringify({ is_active }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });

  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm<FormData>({
    resolver: zodResolver(AddUserSchema),
    defaultValues: { role: 'accountant' },
  });

  return (
    <div className="space-y-8 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Users</h1>
        <p className="mt-1 text-sm text-slate-500">Manage who has access to LedgerLite.</p>
      </div>

      {/* Current users */}
      <div className="card space-y-3">
        <h2 className="text-base font-semibold text-slate-900">Team members</h2>
        {isLoading
          ? <div className="space-y-2">{[1, 2].map(i => (
              <div key={i} className="h-14 animate-pulse rounded-lg bg-slate-100" />
            ))}</div>
          : users.length === 0
          ? <p className="text-sm text-slate-500 py-4 text-center">No users yet.</p>
          : (
            <ul className="divide-y divide-slate-100">
              {users.map((u) => (
                <li key={u.id} className="flex items-center justify-between py-3 first:pt-0 last:pb-0">
                  <div>
                    <p className="text-sm font-medium text-slate-900">{u.name}</p>
                    <p className="text-xs text-slate-500">{u.email}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={u.role === 'owner' ? 'badge badge-blue' : 'badge badge-gray'}>
                      {u.role}
                    </span>
                    {u.role !== 'owner' && (
                      <button
                        onClick={() => toggleActive.mutate({ id: u.id, is_active: !u.is_active })}
                        className={`text-xs font-medium transition-colors cursor-pointer ${
                          u.is_active
                            ? 'text-red-600 hover:text-red-800'
                            : 'text-green-600 hover:text-green-800'
                        }`}
                        aria-label={u.is_active ? `Deactivate ${u.name}` : `Reactivate ${u.name}`}
                      >
                        {u.is_active ? 'Deactivate' : 'Reactivate'}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )
        }
      </div>

      {/* Add accountant form */}
      <div className="card">
        <h2 className="text-base font-semibold text-slate-900 mb-4">Add accountant</h2>
        <form
          onSubmit={handleSubmit(d =>
            createUser.mutate(d, {
              onError: () => {},
            })
          )}
          noValidate
          className="space-y-4"
        >
          <input type="hidden" {...register('role')} />

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="acc-name" className="field-label">Full name</label>
              <input
                id="acc-name"
                {...register('name')}
                className={`input ${errors.name ? 'input-error' : ''}`}
                placeholder="Alex Johnson"
              />
              {errors.name && <p className="field-error">{errors.name.message}</p>}
            </div>
            <div>
              <label htmlFor="acc-email" className="field-label">Email address</label>
              <input
                id="acc-email"
                {...register('email')}
                type="email"
                className={`input ${errors.email ? 'input-error' : ''}`}
                placeholder="alex@firm.co.uk"
              />
              {errors.email && <p className="field-error">{errors.email.message}</p>}
            </div>
          </div>

          <div>
            <label htmlFor="acc-password" className="field-label">
              Temporary password
              <span className="ml-1 font-normal text-slate-400">(they can change it later)</span>
            </label>
            <input
              id="acc-password"
              {...register('password')}
              type="password"
              className={`input ${errors.password ? 'input-error' : ''}`}
              placeholder="Min 8 characters"
            />
            {errors.password && <p className="field-error">{errors.password.message}</p>}
          </div>

          {createUser.isError && (
            <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2" role="alert">
              <p className="text-sm text-red-700">
                {(createUser.error as Error)?.message ?? 'Failed to create user'}
              </p>
            </div>
          )}

          {createUser.isSuccess && (
            <div className="rounded-lg bg-green-50 border border-green-200 px-3 py-2" role="status">
              <p className="text-sm text-green-700">Accountant account created.</p>
            </div>
          )}

          <button
            type="submit"
            disabled={isSubmitting || createUser.isPending}
            className="btn-primary"
          >
            {createUser.isPending
              ? <>
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" aria-hidden="true" />
                  Adding…
                </>
              : 'Add accountant'
            }
          </button>
        </form>
      </div>
    </div>
  );
}
