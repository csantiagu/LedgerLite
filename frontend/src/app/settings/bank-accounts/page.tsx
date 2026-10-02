'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useState } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { api } from '@/lib/api';
import { formatPence } from '@/lib/formatters';
import { RoleGuard } from '@/components/RoleGuard';

const CSV_FORMATS = ['barclays', 'hsbc', 'lloyds', 'natwest', 'monzo', 'starling'] as const;
const ACCOUNT_TYPES = ['current', 'savings', 'credit', 'other'] as const;

const Schema = z.object({
  name:           z.string().min(1, 'Name required'),
  bankName:       z.string().min(1, 'Bank name required'),
  accountType:    z.enum(ACCOUNT_TYPES),
  lastFour:       z.string().length(4, 'Must be exactly 4 digits').or(z.literal('')).optional(),
  currency:       z.string().default('GBP'),
  csvFormat:      z.enum(CSV_FORMATS),
  openingBalance: z.coerce.number().default(0), // entered as £, converted to pence on submit
  notes:          z.string().optional(),
});

type FormValues = z.infer<typeof Schema>;

type BankAccount = {
  id: string;
  name: string;
  bank_name: string;
  account_type: string;
  last_four: string | null;
  csv_format: string;
  opening_balance: number;
  notes: string | null;
};

export default function BankAccountsPage() {
  return (
    <AppShell>
      <RoleGuard allowedRoles={['owner']}>
        <BankAccountsContent />
      </RoleGuard>
    </AppShell>
  );
}

function BankAccountsContent() {
  const qc = useQueryClient();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingBalance, setEditingBalance] = useState('');

  const { data: accounts = [] } = useQuery({
    queryKey: ['bank-accounts'],
    queryFn: () => api<BankAccount[]>('/api/v1/bank-accounts'),
  });

  const create = useMutation({
    mutationFn: (body: FormValues) =>
      api('/api/v1/bank-accounts', {
        method: 'POST',
        body: JSON.stringify({
          ...body,
          openingBalance: Math.round(body.openingBalance * 100),
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bank-accounts'] });
      qc.invalidateQueries({ queryKey: ['account-balance'] });
      reset();
    },
  });

  const deactivate = useMutation({
    mutationFn: (id: string) =>
      api(`/api/v1/bank-accounts/${id}`, { method: 'PATCH', body: JSON.stringify({ isActive: false }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['bank-accounts'] }),
  });

  const updateOpeningBalance = useMutation({
    mutationFn: ({ id, openingBalance }: { id: string; openingBalance: number }) =>
      api(`/api/v1/bank-accounts/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ openingBalance }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bank-accounts'] });
      qc.invalidateQueries({ queryKey: ['account-balance'] });
      setEditingId(null);
      setEditingBalance('');
    },
  });

  const autoDetect = useMutation({
    mutationFn: (id: string) =>
      api<{ opening_balance: number }>(`/api/v1/bank-accounts/${id}/detect-opening-balance`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bank-accounts'] });
      qc.invalidateQueries({ queryKey: ['account-balance'] });
    },
  });

  const { register, handleSubmit, reset, formState: { errors } } = useForm<FormValues>({
    resolver: zodResolver(Schema),
    defaultValues: { accountType: 'current', currency: 'GBP', csvFormat: 'monzo', openingBalance: 0 },
  });

  const startEdit = (a: BankAccount) => {
    setEditingId(a.id);
    setEditingBalance((a.opening_balance / 100).toFixed(2));
  };

  const saveEdit = (id: string) => {
    const pounds = parseFloat(editingBalance);
    if (isNaN(pounds)) return;
    updateOpeningBalance.mutate({ id, openingBalance: Math.round(pounds * 100) });
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Bank accounts</h1>
        <p className="mt-1 text-sm text-slate-500">
          Register each bank account once. CSV format and opening balance are saved here.
          Opening balance is auto-detected from the first CSV import if the file includes a balance column.
        </p>
      </div>

      <div className="space-y-3">
        {accounts.map(a => (
          <div key={a.id} className="card flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <p className="font-medium text-slate-900">{a.name}</p>
              <p className="text-xs text-slate-500 mt-0.5">
                {a.bank_name} · {a.account_type} · {a.csv_format} format
                {a.last_four ? ` · ···· ${a.last_four}` : ''}
              </p>

              {/* Opening balance — inline edit */}
              <div className="flex items-center gap-2 mt-1.5">
                <span className="text-xs text-slate-400">Opening balance:</span>
                {editingId === a.id ? (
                  <>
                    <div className="flex items-center gap-1">
                      <span className="text-xs text-slate-500">£</span>
                      <input
                        type="number"
                        step="0.01"
                        value={editingBalance}
                        onChange={e => setEditingBalance(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') saveEdit(a.id); if (e.key === 'Escape') setEditingId(null); }}
                        className="input py-0.5 text-xs w-28"
                        autoFocus
                      />
                    </div>
                    <button
                      onClick={() => saveEdit(a.id)}
                      disabled={updateOpeningBalance.isPending}
                      className="text-xs text-green-600 hover:underline font-medium"
                    >
                      Save
                    </button>
                    <button onClick={() => setEditingId(null)} className="text-xs text-slate-400 hover:underline">
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <span className={`text-xs font-medium ${a.opening_balance === 0 ? 'text-amber-600' : 'text-slate-700'}`}>
                      {formatPence(a.opening_balance ?? 0)}
                      {a.opening_balance === 0 && ' — not set'}
                    </span>
                    {a.opening_balance === 0 && (
                      <button
                        onClick={() => autoDetect.mutate(a.id)}
                        disabled={autoDetect.isPending}
                        className="text-xs text-green-600 hover:underline font-medium"
                      >
                        {autoDetect.isPending ? 'Detecting…' : 'Auto-detect'}
                      </button>
                    )}
                    <button onClick={() => startEdit(a)} className="text-xs text-blue-500 hover:underline">
                      Edit
                    </button>
                  </>
                )}
              </div>

              {a.notes && <p className="text-xs text-slate-400 mt-1">{a.notes}</p>}
            </div>
            <button
              onClick={() => deactivate.mutate(a.id)}
              className="btn-danger text-sm shrink-0"
            >
              Remove
            </button>
          </div>
        ))}
        {accounts.length === 0 && (
          <p className="text-sm text-slate-400">No bank accounts registered yet.</p>
        )}
      </div>

      <div className="card space-y-4">
        <h2 className="text-base font-semibold text-slate-900">Add bank account</h2>
        <form onSubmit={handleSubmit(d => create.mutate(d))} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="field-label">Account nickname *</label>
              <input {...register('name')} placeholder="e.g. Starling Current" className="input" />
              {errors.name && <p className="field-error">{errors.name.message}</p>}
            </div>
            <div>
              <label className="field-label">Bank name *</label>
              <input {...register('bankName')} placeholder="e.g. Starling" className="input" />
              {errors.bankName && <p className="field-error">{errors.bankName.message}</p>}
            </div>
            <div>
              <label className="field-label">Account type</label>
              <select {...register('accountType')} className="input">
                {ACCOUNT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className="field-label">CSV format *</label>
              <select {...register('csvFormat')} className="input">
                {CSV_FORMATS.map(f => <option key={f} value={f}>{f.charAt(0).toUpperCase() + f.slice(1)}</option>)}
              </select>
            </div>
            <div>
              <label className="field-label">Opening balance (£)</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">£</span>
                <input
                  type="number"
                  step="0.01"
                  {...register('openingBalance')}
                  placeholder="0.00"
                  className="input pl-7"
                />
              </div>
              <p className="text-xs text-slate-400 mt-1">
                Balance before first imported transaction. Leave 0 to auto-detect from CSV.
              </p>
              {errors.openingBalance && <p className="field-error">{errors.openingBalance.message}</p>}
            </div>
            <div>
              <label className="field-label">Last 4 digits (optional)</label>
              <input {...register('lastFour')} placeholder="1234" maxLength={4} className="input" />
              {errors.lastFour && <p className="field-error">{errors.lastFour.message}</p>}
            </div>
            <div>
              <label className="field-label">Currency</label>
              <input {...register('currency')} className="input" />
            </div>
          </div>
          <div>
            <label className="field-label">Notes (optional)</label>
            <input {...register('notes')} placeholder="Any notes about this account" className="input" />
          </div>
          <button type="submit" className="btn-primary" disabled={create.isPending}>
            {create.isPending ? 'Adding…' : 'Add account'}
          </button>
        </form>
      </div>
    </div>
  );
}
