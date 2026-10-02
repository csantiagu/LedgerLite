'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useAuthStore } from '@/lib/auth';

const SetupSchema = z.object({
  name:            z.string().min(1, 'Name required'),
  email:           z.string().email('Valid email required'),
  password:        z.string().min(8, 'Minimum 8 characters'),
  confirmPassword: z.string(),
}).refine(d => d.password === d.confirmPassword, {
  message: 'Passwords must match',
  path: ['confirmPassword'],
});

type FormData = z.infer<typeof SetupSchema>;

export default function SetupPage() {
  const router  = useRouter();
  const setAuth = useAuthStore(s => s.setAuth);
  const API     = process.env.NEXT_PUBLIC_API_URL ?? '';

  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    let active = true;
    fetch(`${API}/auth/setup/status`, {
      signal: controller.signal,
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    })
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(({ setupRequired }: { setupRequired: boolean }) => {
        if (!active) return;
        clearTimeout(timeout);
        if (!setupRequired) router.replace('/login');
      })
      .catch(() => {
        // Network error or worker unreachable — stay on setup page, don't redirect
        clearTimeout(timeout);
      });

    return () => {
      active = false;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [API, router]);

  const {
    register, handleSubmit,
    formState: { errors, isSubmitting },
    setError,
  } = useForm<FormData>({ resolver: zodResolver(SetupSchema) });

  async function onSubmit(data: FormData) {
    const res = await fetch(`${API}/auth/setup`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: JSON.stringify({ name: data.name, email: data.email, password: data.password }),
    });
    if (!res.ok) {
      setError('root', { message: 'Setup failed — check the Worker logs' });
      return;
    }
    const { accessToken, role } = await res.json() as { accessToken: string; role: 'owner' };
    setAuth(accessToken, role);
    router.replace('/dashboard');
  }

  const fields = [
    { id: 'name' as const,            label: 'Your name',        type: 'text',     placeholder: 'Jane Smith' },
    { id: 'email' as const,           label: 'Email address',    type: 'email',    placeholder: 'jane@example.com' },
    { id: 'password' as const,        label: 'Password',         type: 'password', placeholder: 'Min 8 characters' },
    { id: 'confirmPassword' as const, label: 'Confirm password', type: 'password', placeholder: '' },
  ];

  return (
    <div className="flex min-h-dvh items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-md">
        {/* Logo mark */}
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-600 shadow-lg shadow-blue-600/30">
            <svg className="h-8 w-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m-3-2.818.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-slate-900">Welcome to LedgerLite</h1>
          <p className="mt-1 text-sm text-slate-500">Create your owner account to get started.</p>
        </div>

        <div className="card">
          <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-4">
            {fields.map(({ id, label, type, placeholder }) => (
              <div key={id}>
                <label htmlFor={id} className="field-label">{label}</label>
                <input
                  id={id}
                  {...register(id)}
                  type={type}
                  placeholder={placeholder}
                  autoComplete={id === 'email' ? 'email' : id === 'password' ? 'new-password' : id === 'confirmPassword' ? 'new-password' : 'name'}
                  className={`input ${errors[id] ? 'input-error' : ''}`}
                  aria-invalid={!!errors[id]}
                  aria-describedby={errors[id] ? `${id}-error` : undefined}
                />
                {errors[id] && (
                  <p id={`${id}-error`} className="field-error" role="alert">
                    {errors[id]?.message}
                  </p>
                )}
              </div>
            ))}

            {errors.root && (
              <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2" role="alert">
                <p className="text-sm text-red-700">{errors.root.message}</p>
              </div>
            )}

            <button
              type="submit"
              disabled={isSubmitting}
              className="btn-primary w-full py-2.5 mt-2"
            >
              {isSubmitting
                ? <>
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" aria-hidden="true" />
                    Creating account…
                  </>
                : 'Create account & sign in'
              }
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
