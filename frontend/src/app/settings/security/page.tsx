'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
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
        <TwoFactor />
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

type TwoFactorStatus = { enabled: boolean; recoveryCodesLeft: number };
type Session = { accessToken: string; role: 'owner' | 'accountant' };

function TwoFactor() {
  const qc = useQueryClient();
  const { data: status } = useQuery({
    queryKey: ['2fa'],
    queryFn: () => api<TwoFactorStatus>('/auth/2fa'),
  });
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  const done = () => { setRecoveryCodes(null); qc.invalidateQueries({ queryKey: ['2fa'] }); };

  return (
    <div className="card">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-base font-semibold text-slate-900">Two-factor sign-in</h2>
        {status && (
          <span className={`badge ${status.enabled ? 'badge-green' : 'badge-yellow'}`}>
            {status.enabled ? 'On' : 'Off'}
          </span>
        )}
      </div>
      <p className="mt-1 mb-4 text-sm text-slate-500">
        After your password, sign-in asks for a 6-digit code from an authenticator app on your
        phone (Google Authenticator, 1Password, Microsoft Authenticator…). A stolen password alone
        is then not enough to get in.
      </p>

      {recoveryCodes
        ? <RecoveryCodes codes={recoveryCodes} onDone={done} />
        : status?.enabled
          ? <ManageTwoFactor left={status.recoveryCodesLeft} onCodes={setRecoveryCodes} onDisabled={done} />
          : status && <EnableTwoFactor onEnabled={setRecoveryCodes} />}
    </div>
  );
}

function EnableTwoFactor({ onEnabled }: { onEnabled: (codes: string[]) => void }) {
  const setAuth = useAuthStore(s => s.setAuth);
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const { register, handleSubmit, formState: { errors } } = useForm<{ code: string }>({
    resolver: zodResolver(z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code') })),
  });

  useEffect(() => {
    if (setup) QRCode.toDataURL(setup.otpauthUri, { margin: 1, width: 200 }).then(setQr).catch(() => setQr(null));
  }, [setup]);

  const start = useMutation({
    mutationFn: () => api<{ secret: string; otpauthUri: string }>('/auth/2fa/setup', { method: 'POST' }),
    onSuccess: setSetup,
  });
  const enable = useMutation({
    mutationFn: (code: string) => api<Session & { recoveryCodes: string[] }>(
      '/auth/2fa/enable', { method: 'POST', body: JSON.stringify({ code }) },
    ),
    onSuccess: ({ accessToken, role, recoveryCodes }) => { setAuth(accessToken, role); onEnabled(recoveryCodes); },
  });

  if (!setup) {
    return (
      <>
        {start.isError && <p className="mb-3 text-sm text-red-700" role="alert">{(start.error as Error).message}</p>}
        <button type="button" onClick={() => start.mutate()} disabled={start.isPending} className="btn-primary">
          {start.isPending ? 'Starting…' : 'Set up two-factor sign-in'}
        </button>
      </>
    );
  }

  return (
    <form onSubmit={handleSubmit(d => enable.mutate(d.code))} noValidate className="space-y-4">
      <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-700">
        <li>Open your authenticator app and add an account by scanning this QR code.</li>
        <li>Enter the 6-digit code it shows to finish.</li>
      </ol>
      <div className="flex flex-wrap items-center gap-6">
        {qr
          ? <img src={qr} alt="QR code for your authenticator app" width={200} height={200} className="rounded-lg border border-slate-200" />
          : <div className="h-[200px] w-[200px] animate-pulse rounded-lg bg-slate-100" />}
        <div className="text-sm">
          <p className="text-slate-500">Can&apos;t scan it? Enter this key instead:</p>
          <code className="mt-1 block select-all break-all rounded bg-slate-100 px-2 py-1 font-mono text-slate-900">
            {setup.secret.match(/.{1,4}/g)?.join(' ')}
          </code>
        </div>
      </div>
      <div className="max-w-xs">
        <label htmlFor="enable-code" className="field-label">6-digit code</label>
        <input
          id="enable-code"
          {...register('code')}
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="123456"
          className={`input tracking-widest ${errors.code ? 'input-error' : ''}`}
        />
        {errors.code && <p className="field-error" role="alert">{errors.code.message}</p>}
      </div>
      {enable.isError && <p className="text-sm text-red-700" role="alert">{(enable.error as Error).message}</p>}
      <button type="submit" disabled={enable.isPending} className="btn-primary">
        {enable.isPending ? 'Checking…' : 'Turn on two-factor sign-in'}
      </button>
    </form>
  );
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const download = () => {
    const text = `LedgerLite recovery codes\nEach code works once, in place of an authenticator code.\n\n${codes.join('\n')}\n`;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'ledgerlite-recovery-codes.txt' });
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800" role="status">
        Save these recovery codes somewhere safe, such as your password manager. If you lose your
        phone, each one lets you sign in once. They won&apos;t be shown again.
      </div>
      <ul className="grid grid-cols-2 gap-2 font-mono text-sm text-slate-900 sm:max-w-sm">
        {codes.map(code => <li key={code} className="rounded bg-slate-100 px-2 py-1 text-center">{code}</li>)}
      </ul>
      <div className="flex gap-3">
        <button type="button" onClick={download} className="btn-secondary">Download</button>
        <button type="button" onClick={onDone} className="btn-primary">I&apos;ve saved them</button>
      </div>
    </div>
  );
}

function ManageTwoFactor({ left, onCodes, onDisabled }: {
  left: number; onCodes: (codes: string[]) => void; onDisabled: () => void;
}) {
  type Confirm = { password: string; code: string };
  const { register, handleSubmit, reset, formState: { errors } } = useForm<Confirm>({
    resolver: zodResolver(z.object({
      password: z.string().min(1, 'Enter your password'),
      code:     z.string().trim().min(6, 'Enter a code from your app or a recovery code'),
    })),
  });

  const newCodes = useMutation({
    mutationFn: (d: Confirm) => api<{ recoveryCodes: string[] }>('/auth/2fa/recovery-codes', { method: 'POST', body: JSON.stringify(d) }),
    onSuccess: ({ recoveryCodes }) => { reset(); onCodes(recoveryCodes); },
  });
  const disable = useMutation({
    mutationFn: (d: Confirm) => api('/auth/2fa/disable', { method: 'POST', body: JSON.stringify(d) }),
    onSuccess: () => { reset(); onDisabled(); },
  });
  const error = (newCodes.error ?? disable.error) as Error | null;

  return (
    <form noValidate className="space-y-4">
      <p className={`text-sm ${left <= 3 ? 'text-amber-700' : 'text-slate-600'}`}>
        {left} recovery code{left === 1 ? '' : 's'} left.
        {left <= 3 && ' Get new ones soon.'}
      </p>
      <p className="text-sm text-slate-500">To change these settings, confirm it&apos;s you:</p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="confirm-password" className="field-label">Password</label>
          <input id="confirm-password" {...register('password')} type="password" autoComplete="current-password"
            className={`input ${errors.password ? 'input-error' : ''}`} />
          {errors.password && <p className="field-error" role="alert">{errors.password.message}</p>}
        </div>
        <div>
          <label htmlFor="confirm-code" className="field-label">Code</label>
          <input id="confirm-code" {...register('code')} inputMode="numeric" autoComplete="one-time-code"
            placeholder="123456" className={`input ${errors.code ? 'input-error' : ''}`} />
          {errors.code && <p className="field-error" role="alert">{errors.code.message}</p>}
        </div>
      </div>
      {error && <p className="text-sm text-red-700" role="alert">{error.message}</p>}
      <div className="flex flex-wrap gap-3">
        <button type="button" onClick={handleSubmit(d => newCodes.mutate(d))} disabled={newCodes.isPending} className="btn-secondary">
          {newCodes.isPending ? 'Creating…' : 'Get new recovery codes'}
        </button>
        <button
          type="button"
          onClick={handleSubmit(d => { if (confirm('Turn off two-factor sign-in?')) disable.mutate(d); })}
          disabled={disable.isPending}
          className="btn-danger"
        >
          {disable.isPending ? 'Turning off…' : 'Turn off two-factor'}
        </button>
      </div>
    </form>
  );
}
