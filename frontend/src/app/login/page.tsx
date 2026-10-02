'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useAuthStore } from '@/lib/auth';

const LoginSchema = z.object({
  email:    z.string().email('Valid email required'),
  password: z.string().min(1, 'Password required'),
});

type FormData = z.infer<typeof LoginSchema>;

export default function LoginPage() {
  const setAuth = useAuthStore(s => s.setAuth);
  const API     = process.env.NEXT_PUBLIC_API_URL ?? '';

  const {
    register, handleSubmit,
    formState: { errors, isSubmitting },
    setError,
  } = useForm<FormData>({ resolver: zodResolver(LoginSchema) });

  async function onSubmit(data: FormData) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(`${API}/auth/login`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify(data),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        setError('root', { message: 'Invalid email or password' });
        return;
      }

      const { accessToken, role } = await res.json() as { accessToken: string; role: 'owner' | 'accountant' };
      setAuth(accessToken, role);
      window.location.assign('/dashboard');
    } catch {
      setError('root', { message: 'Sign-in failed. Please try again.' });
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="mb-8 flex flex-col items-center text-center">
          <img src="/logo.png" alt="LedgerLite" width={160} height={131} className="mb-6 h-auto w-40 mix-blend-multiply" />
          <h1 className="text-2xl font-bold text-slate-900">Sign in</h1>
          <p className="mt-1 text-sm text-slate-500">Enter your credentials below.</p>
        </div>

        <div className="card">
          <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-4">
            <div>
              <label htmlFor="email" className="field-label">Email address</label>
              <input
                id="email"
                {...register('email')}
                type="email"
                autoComplete="email"
                className={`input ${errors.email ? 'input-error' : ''}`}
                aria-invalid={!!errors.email}
                aria-describedby={errors.email ? 'email-error' : undefined}
              />
              {errors.email && (
                <p id="email-error" className="field-error" role="alert">{errors.email.message}</p>
              )}
            </div>

            <div>
              <label htmlFor="password" className="field-label">Password</label>
              <input
                id="password"
                {...register('password')}
                type="password"
                autoComplete="current-password"
                className={`input ${errors.password ? 'input-error' : ''}`}
              />
            </div>

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
                    Signing in…
                  </>
                : 'Sign in'
              }
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
