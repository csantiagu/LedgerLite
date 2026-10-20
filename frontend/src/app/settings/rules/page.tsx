'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { AppShell } from '@/components/layout/AppShell';
import { RoleGuard } from '@/components/RoleGuard';
import { api } from '@/lib/api';
import { valueToVat, vatChoicesFor, vatLabel, vatToValue } from '@/lib/vat';

type Category = { id: string; name: string; default_vat_rate: number | null };

type Rule = {
  id: string;
  match_text: string;
  direction: 'any' | 'in' | 'out';
  expense_category_id: string;
  category_name: string;
  explanation: string | null;
  priority: number;
  vat_rate: number | null;          // the rule's own VAT; null = the category's usual VAT
  default_vat_rate: number | null;  // the category's usual VAT
  times_applied: number;
};

const Schema = z.object({
  matchText: z.string().trim().min(2, 'At least 2 characters').max(120),
  direction: z.enum(['any', 'in', 'out']),
  expenseCategoryId: z.string().min(1, 'Pick a category'),
  explanation: z.string().max(500).optional(),
  vat: z.string(),   // '' = the category's usual VAT, else the rate (see lib/vat)
});
type FormData = z.infer<typeof Schema>;

const EMPTY: FormData = { matchText: '', direction: 'any', expenseCategoryId: '', explanation: '', vat: '' };

const DIRECTION_LABEL: Record<Rule['direction'], string> = {
  any: 'In or out',
  in: 'Money in',
  out: 'Money out',
};

// Common UK bank-statement wording for HMRC payments. Prefills the form; user confirms.
// Payments to HMRC carry no VAT; their categories say so already.
const STARTERS: Array<{ text: string; category: string; explanation: string }> = [
  { text: 'HMRC VAT', category: 'VAT Payments / Refunds', explanation: 'Quarterly VAT return payment' },
  { text: 'HMRC PAYE', category: 'PAYE & NI', explanation: 'Monthly PAYE and NI' },
  { text: 'HMRC COTAX', category: 'Corporation Tax', explanation: 'Corporation tax payment' },
];

export default function RulesPage() {
  return (
    <AppShell>
      <RoleGuard allowedRoles={['owner']}>
        <RulesContent />
      </RoleGuard>
    </AppShell>
  );
}

function RulesContent() {
  const qc = useQueryClient();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [message, setMessage] = useState('');

  const { data: rules = [] } = useQuery<Rule[]>({
    queryKey: ['categorisation-rules'],
    queryFn: () => api<Rule[]>('/api/v1/categorisation-rules'),
  });

  const { data: categories = [] } = useQuery<Category[]>({
    queryKey: ['expense-categories'],
    queryFn: () => api<Category[]>('/api/v1/expense-categories'),
  });

  const form = useForm<FormData>({ resolver: zodResolver(Schema), defaultValues: EMPTY });

  // Prefill from the transactions page: /settings/rules?text=...&category=...&direction=...
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const text = p.get('text');
    if (!text) return;
    const direction = p.get('direction');
    form.reset({
      matchText: text,
      direction: direction === 'in' || direction === 'out' ? direction : 'any',
      expenseCategoryId: p.get('category') ?? '',
      explanation: p.get('explanation') ?? '',
      vat: p.get('vat') ?? '',
    });
  }, [form]);

  const afterSave = (applied: number, verb: string) => {
    setMessage(`Rule ${verb}.${applied ? ` ${applied} existing transaction${applied === 1 ? '' : 's'} categorised.` : ''}`);
    setEditingId(null);
    form.reset(EMPTY);
    qc.invalidateQueries({ queryKey: ['categorisation-rules'] });
    qc.invalidateQueries({ queryKey: ['transactions'] });
  };

  const save = useMutation({
    mutationFn: (data: FormData) => {
      const body = JSON.stringify({
        matchText: data.matchText.trim(),
        direction: data.direction,
        expenseCategoryId: data.expenseCategoryId,
        explanation: data.explanation?.trim() || null,
        vatRate: valueToVat(data.vat),
      });
      return editingId
        ? api<{ applied: number }>(`/api/v1/categorisation-rules/${editingId}`, { method: 'PUT', body })
        : api<{ applied: number }>('/api/v1/categorisation-rules', { method: 'POST', body });
    },
    onSuccess: (res) => afterSave(res.applied, editingId ? 'updated' : 'added'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/v1/categorisation-rules/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setMessage('Rule deleted. Transactions it already categorised keep their category.');
      qc.invalidateQueries({ queryKey: ['categorisation-rules'] });
    },
  });

  const rerun = useMutation({
    mutationFn: () => api<{ applied: number }>('/api/v1/categorisation-rules/apply', { method: 'POST' }),
    onSuccess: (res) => {
      setMessage(res.applied ? `${res.applied} transaction${res.applied === 1 ? '' : 's'} categorised.` : 'No uncategorised transactions matched any rule.');
      qc.invalidateQueries({ queryKey: ['categorisation-rules'] });
      qc.invalidateQueries({ queryKey: ['transactions'] });
    },
  });

  const startEdit = (r: Rule) => {
    setEditingId(r.id);
    setMessage('');
    form.reset({
      matchText: r.match_text,
      direction: r.direction,
      expenseCategoryId: r.expense_category_id,
      explanation: r.explanation ?? '',
      vat: vatToValue(r.vat_rate),
    });
  };

  const applyStarter = (s: (typeof STARTERS)[number]) => {
    setEditingId(null);
    setMessage('');
    form.reset({
      matchText: s.text,
      direction: 'any',
      expenseCategoryId: categories.find((c) => c.name === s.category)?.id ?? '',
      explanation: s.explanation,
      vat: '',
    });
  };

  const existingTexts = new Set(rules.map((r) => r.match_text.toLowerCase()));
  const starters = STARTERS.filter((s) => !existingTexts.has(s.text.toLowerCase()));
  const errors = form.formState.errors;
  const selectedCategory = categories.find((c) => c.id === form.watch('expenseCategoryId'));
  const vatValue = form.watch('vat');

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Settings · Rules</h1>
          <p className="mt-1 text-sm text-slate-500">
            Automatically categorise recurring bank lines (VAT, PAYE, subscriptions) when you import a statement.
          </p>
        </div>
        <button type="button" className="btn-secondary" onClick={() => rerun.mutate()} disabled={rerun.isPending || rules.length === 0}>
          {rerun.isPending ? 'Running…' : 'Run rules on uncategorised'}
        </button>
      </div>

      <div className="card space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-slate-900">{editingId ? 'Edit rule' : 'Add rule'}</h2>
          {editingId && (
            <button type="button" className="text-sm text-slate-500 hover:text-slate-700"
              onClick={() => { setEditingId(null); form.reset(EMPTY); }}>
              Cancel
            </button>
          )}
        </div>

        {!editingId && starters.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-slate-500">Common ones:</span>
            {starters.map((s) => (
              <button key={s.text} type="button" onClick={() => applyStarter(s)}
                className="rounded-full border border-slate-200 px-3 py-1 text-slate-600 hover:border-blue-300 hover:text-slate-900">
                {s.text} → {s.category}
              </button>
            ))}
            <span className="text-slate-400">Check the wording against your own statement first.</span>
          </div>
        )}

        <form onSubmit={form.handleSubmit((d) => save.mutate(d))} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="field-label" htmlFor="matchText">Description contains</label>
              <input id="matchText" {...form.register('matchText')} className="input" placeholder="e.g. HMRC VAT" />
              {errors.matchText && <p className="field-error">{errors.matchText.message}</p>}
            </div>
            <div>
              <label className="field-label" htmlFor="direction">Direction</label>
              <select id="direction" {...form.register('direction')} className="input">
                <option value="any">In or out</option>
                <option value="out">Money out only</option>
                <option value="in">Money in only</option>
              </select>
            </div>
            <div>
              <label className="field-label" htmlFor="category">Category</label>
              <select id="category" {...form.register('expenseCategoryId')} className="input">
                <option value="">Select…</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              {errors.expenseCategoryId && <p className="field-error">{errors.expenseCategoryId.message}</p>}
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-2">
              <label className="field-label" htmlFor="explanation">Explanation for your accountant (optional)</label>
              <input id="explanation" {...form.register('explanation')} className="input" placeholder="e.g. Monthly PAYE and NI" />
            </div>
            <div>
              <label className="field-label" htmlFor="vat">VAT included</label>
              <select id="vat" {...form.register('vat')} className="input">
                <option value="">{`Category's usual (${vatLabel(selectedCategory?.default_vat_rate, 'ask each time')})`}</option>
                {vatChoicesFor(valueToVat(vatValue)).map(v => <option key={v.value} value={v.value}>{v.label}</option>)}
              </select>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button type="submit" className="btn-primary" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : editingId ? 'Update rule' : 'Add rule'}
            </button>
            <p className="text-xs text-slate-500">Matching ignores case. Rules never overwrite a category you set by hand.</p>
          </div>
          {save.isError && <p className="text-sm text-red-600">{(save.error as Error).message}</p>}
        </form>
      </div>

      {message && <p className="text-sm text-green-700" role="status">{message}</p>}

      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100">
              {['Contains', 'Direction', 'Category', 'VAT', 'Explanation', 'Used', ''].map((h) => (
                <th key={h} className="py-3 px-4 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {rules.map((r) => (
              <tr key={r.id} className={editingId === r.id ? 'bg-blue-50' : 'hover:bg-slate-50'}>
                <td className="py-3 px-4 font-mono text-xs">{r.match_text}</td>
                <td className="py-3 px-4 text-slate-600">{DIRECTION_LABEL[r.direction]}</td>
                <td className="py-3 px-4 font-medium">{r.category_name}</td>
                <td className="py-3 px-4 text-slate-600 whitespace-nowrap">
                  {vatLabel(r.vat_rate ?? r.default_vat_rate, 'Ask each time')}
                </td>
                <td className="py-3 px-4 text-slate-600">{r.explanation || '—'}</td>
                <td className="py-3 px-4 text-slate-600 tabular-nums">{r.times_applied}</td>
                <td className="py-3 px-4 text-right whitespace-nowrap">
                  <button type="button" className="text-sm text-blue-600 hover:text-blue-700" onClick={() => startEdit(r)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className="ml-3 text-sm text-red-600 hover:text-red-700"
                    onClick={() => { if (confirm(`Delete the rule for "${r.match_text}"?`)) remove.mutate(r.id); }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {rules.length === 0 && (
              <tr>
                <td colSpan={7} className="py-8 px-4 text-center text-sm text-slate-500">
                  No rules yet. Add one above, or use &ldquo;Make rule&rdquo; on a transaction.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
