'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useAuthStore } from '@/lib/auth';
import { API_BASE } from '@/lib/api';
import { ThemeToggle } from '@/components/ThemeToggle';

const LoginSchema = z.object({
  email:    z.string().email('Valid email required'),
  password: z.string().min(1, 'Password required'),
});

type FormData = z.infer<typeof LoginSchema>;

const CodeSchema = z.object({
  code: z.string().trim().min(6, 'Enter the 6-digit code or a recovery code').max(32),
});

type SessionResponse = { accessToken: string; role: 'owner' | 'accountant' };

export default function LoginPage() {
  const setAuth = useAuthStore(s => s.setAuth);
  const API     = API_BASE;
  const [mfaToken, setMfaToken] = useState<string | null>(null);

  function signedIn({ accessToken, role }: SessionResponse) {
    setAuth(accessToken, role);
    window.location.assign('/dashboard');
  }

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

      const body = await res.json() as SessionResponse | { mfaRequired: true; mfaToken: string };
      if ('mfaRequired' in body) setMfaToken(body.mfaToken);
      else signedIn(body);
    } catch {
      setError('root', { message: 'Sign-in failed. Please try again.' });
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <p className="brand-mark text-4xl">LedgerLite</p>
          <h1 className="mt-6 text-2xl text-slate-900">Sign in</h1>
          <p className="mt-1 text-sm text-slate-500">Enter your credentials below.</p>
          <ThemeToggle className="mx-auto mt-5 max-w-[16rem]" />
        </div>

        {mfaToken ? (
          <SecondFactor
            api={API}
            mfaToken={mfaToken}
            onDone={signedIn}
            onRestart={() => setMfaToken(null)}
          />
        ) : (
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
        )}
      </div>
    </div>
  );
}

function SecondFactor({ api, mfaToken, onDone, onRestart }: {
  api: string; mfaToken: string; onDone: (s: SessionResponse) => void; onRestart: () => void;
}) {
  const {
    register, handleSubmit,
    formState: { errors, isSubmitting },
    setError,
  } = useForm<z.infer<typeof CodeSchema>>({ resolver: zodResolver(CodeSchema) });

  async function onSubmit({ code }: z.infer<typeof CodeSchema>) {
    const res = await fetch(`${api}/auth/login/2fa`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ mfaToken, code }),
    }).catch(() => null);
    if (!res) return setError('root', { message: 'Sign-in failed. Please try again.' });
    if (res.status === 429) return setError('root', { message: 'Too many attempts. Wait a minute and try again.' });
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({ error: '' })) as { error?: string };
      return setError('root', { message: error === 'Sign-in expired, start again' ? error : 'That code is not right' });
    }
    onDone(await res.json() as SessionResponse);
  }

  return (
    <div className="card">
      <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-4">
        <div>
          <label htmlFor="code" className="field-label">Authentication code</label>
          <input
            id="code"
            {...register('code')}
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            placeholder="123456"
            className={`input tracking-widest ${errors.code ? 'input-error' : ''}`}
            aria-invalid={!!errors.code}
          />
          <p className="mt-1 text-xs text-slate-500">
            From your authenticator app. Lost your phone? Enter one of your recovery codes instead.
          </p>
          {errors.code && <p className="field-error" role="alert">{errors.code.message}</p>}
        </div>

        {errors.root && (
          <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2" role="alert">
            <p className="text-sm text-red-700">{errors.root.message}</p>
          </div>
        )}

        <button type="submit" disabled={isSubmitting} className="btn-primary w-full py-2.5">
          {isSubmitting ? 'Checking…' : 'Verify'}
        </button>
        <button type="button" onClick={onRestart} className="w-full text-sm text-slate-500 hover:text-slate-700">
          Use a different account
        </button>
      </form>
    </div>
  );
}
