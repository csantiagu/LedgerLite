'use client';

import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { api, logout } from '@/lib/api';
import { useAuthStore } from '@/lib/auth';
import { AppShell } from '@/components/layout/AppShell';

const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password'),
  newPassword:     z.string().min(12, 'Use at least 12 characters').max(256, 'Use at most 256 characters'),
  confirmPassword: z.string(),
}).refine(d => d.newPassword === d.confirmPassword, {
  message: 'Passwords must match',
  path: ['confirmPassword'],
});

type ChangePasswordData = z.infer<typeof ChangePasswordSchema>;

export default function SecurityPage() {
  return (
    <AppShell>
      <div className="space-y-8 max-w-2xl">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Security</h1>
          <p className="mt-1 text-sm text-slate-500">Your password and signed-in sessions.</p>
        </div>
        <ChangePassword />
        <SignOutEverywhere />
      </div>
    </AppShell>
  );
}

function ChangePassword() {
  const setAuth = useAuthStore(s => s.setAuth);
  const { register, handleSubmit, reset, formState: { errors } } = useForm<ChangePasswordData>({
    resolver: zodResolver(ChangePasswordSchema),
  });

  const change = useMutation({
    mutationFn: (d: ChangePasswordData) => api<{ accessToken: string; role: 'owner' | 'accountant' }>(
      '/auth/change-password',
      { method: 'POST', body: JSON.stringify({ currentPassword: d.currentPassword, newPassword: d.newPassword }) },
    ),
    onSuccess: ({ accessToken, role }) => { setAuth(accessToken, role); reset(); },
  });

  const field = (id: keyof ChangePasswordData, label: string, autoComplete: string) => (
    <div>
      <label htmlFor={id} className="field-label">{label}</label>
      <input
        id={id}
        {...register(id)}
        type="password"
        autoComplete={autoComplete}
        className={`input ${errors[id] ? 'input-error' : ''}`}
        aria-invalid={!!errors[id]}
      />
      {errors[id] && <p className="field-error" role="alert">{errors[id]?.message}</p>}
    </div>
  );

  return (
    <div className="card">
      <h2 className="text-base font-semibold text-slate-900">Change password</h2>
      <p className="mt-1 mb-4 text-sm text-slate-500">
        Changing your password signs you out on every other device.
      </p>
      <form onSubmit={handleSubmit(d => change.mutate(d))} noValidate className="space-y-4">
        {field('currentPassword', 'Current password', 'current-password')}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {field('newPassword', 'New password', 'new-password')}
          {field('confirmPassword', 'Confirm new password', 'new-password')}
        </div>

        {change.isError && (
          <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2" role="alert">
            <p className="text-sm text-red-700">{(change.error as Error).message}</p>
          </div>
        )}
        {change.isSuccess && (
          <div className="rounded-lg bg-green-50 border border-green-200 px-3 py-2" role="status">
            <p className="text-sm text-green-700">Password changed. Other devices have been signed out.</p>
          </div>
        )}

        <button type="submit" disabled={change.isPending} className="btn-primary">
          {change.isPending ? 'Changing…' : 'Change password'}
        </button>
      </form>
    </div>
  );
}

function SignOutEverywhere() {
  const router = useRouter();
  const signOutAll = useMutation({
    mutationFn: () => api('/auth/logout-all', { method: 'POST' }),
    onSuccess: async () => { await logout(); router.replace('/login'); },
  });

  return (
    <div className="card">
      <h2 className="text-base font-semibold text-slate-900">Sign out everywhere</h2>
      <p className="mt-1 mb-4 text-sm text-slate-500">
        Ends every session on every device, including this one. Use this if you think someone else
        has access to your account.
      </p>
      {signOutAll.isError && (
        <p className="mb-3 text-sm text-red-700" role="alert">{(signOutAll.error as Error).message}</p>
      )}
      <button
        type="button"
        onClick={() => { if (confirm('Sign out of every device, including this one?')) signOutAll.mutate(); }}
        disabled={signOutAll.isPending}
        className="btn-danger"
      >
        {signOutAll.isPending ? 'Signing out…' : 'Sign out everywhere'}
      </button>
    </div>
  );
}
