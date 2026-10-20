'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm, useFieldArray, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { formatPence } from '@/lib/formatters';

// The invoice form shared by New invoice and Edit draft. Amounts are typed in pounds and sent in
// pence; the server works out the totals again.

const ItemSchema = z.object({
  description: z.string().min(1, 'Required'),
  quantity:    z.coerce.number().positive('Must be > 0'),
  unit_price:  z.coerce.number().min(0, 'Must be ≥ 0'),
  tax_rate:    z.coerce.number().min(0).max(1),
});

const Schema = z.object({
  client_id:  z.string().min(1, 'Select a client'),
  issue_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  due_date:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes:      z.string().max(1000).optional(),
  items:      z.array(ItemSchema).min(1, 'At least one line item required'),
});
export type InvoiceFormData = z.infer<typeof Schema>;
type FormData = InvoiceFormData;

type Client = { id: string; name: string };

export const NEW_LINE = { description: '', quantity: 1, unit_price: 0, tax_rate: 0.2 };

type FormProps = {
  title: string;
  subtitle: string;
  initial: FormData;
  /** Set when editing a draft: saves over it instead of creating a new one */
  invoiceId?: string;
};

export function InvoiceForm(props: FormProps) {
  const { data: clients, isError, refetch } = useQuery<Client[]>({
    queryKey: ['clients'],
    queryFn: () => api<Client[]>('/api/v1/clients'),
  });
  // The client box can only show the chosen client once its option exists, so the form waits for
  // the list (after a page refresh it isn't cached yet)
  if (isError) {
    return (
      <div className="card max-w-3xl p-6">
        <p className="text-sm text-red-700" role="alert">Couldn’t load clients.</p>
        <button type="button" className="btn-secondary mt-3" onClick={() => refetch()}>Try again</button>
      </div>
    );
  }
  if (!clients) return <div className="card h-48 max-w-3xl animate-pulse bg-slate-50" />;
  return <InvoiceFormFields {...props} clients={clients} />;
}

function InvoiceFormFields({
  title, subtitle, initial, invoiceId, clients,
}: FormProps & { clients: Client[] }) {
  const router = useRouter();
  const qc = useQueryClient();

  const { register, control, handleSubmit, watch, formState: { errors } } = useForm<FormData>({
    resolver: zodResolver(Schema),
    defaultValues: initial,
  });

  const { fields, append, remove } = useFieldArray({ control, name: 'items' });

  const watchedItems = watch('items');
  const subtotal = watchedItems.reduce((s, i) => s + Math.round((i.quantity || 0) * Math.round((i.unit_price || 0) * 100)), 0);
  const vatTotal = watchedItems.reduce((s, i) => {
    const line = Math.round((i.quantity || 0) * Math.round((i.unit_price || 0) * 100));
    return s + Math.round(line * (i.tax_rate || 0));
  }, 0);
  const total = subtotal + vatTotal;

  const create = useMutation({
    mutationFn: async (data: FormData) => {
      const body = JSON.stringify({
        ...data,
        items: data.items.map(i => ({ ...i, unit_price: Math.round(i.unit_price * 100) })),
      });
      if (invoiceId) {
        await api(`/api/v1/invoices/${invoiceId}`, { method: 'PUT', body });
        return { id: invoiceId };
      }
      return api<{ id: string; invoice_number: string }>('/api/v1/invoices', { method: 'POST', body });
    },
    onSuccess: ({ id }) => {
      qc.invalidateQueries({ queryKey: ['invoices'] });
      qc.invalidateQueries({ queryKey: ['invoice', id] });
      router.push(`/invoices/view?id=${id}`);
    },
  });

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">{title}</h1>
        <p className="mt-1 text-sm text-slate-500">{subtitle}</p>
      </div>

      <form onSubmit={handleSubmit(d => create.mutate(d))} noValidate className="space-y-6">
        {/* Header */}
        <div className="card space-y-5">
          <div>
            <label htmlFor="inv-client" className="field-label">
              Client <span className="text-red-500" aria-hidden="true">*</span>
            </label>
            <select
              id="inv-client"
              {...register('client_id')}
              className={`input ${errors.client_id ? 'input-error' : ''}`}
              aria-invalid={!!errors.client_id}
            >
              <option value="">Select client…</option>
              {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            {errors.client_id && <p className="field-error" role="alert">{errors.client_id.message}</p>}
          </div>

          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <div>
              <label htmlFor="inv-issue" className="field-label">Issue date</label>
              <input id="inv-issue" type="date" {...register('issue_date')} className="input" />
            </div>
            <div>
              <label htmlFor="inv-due" className="field-label">Due date</label>
              <input id="inv-due" type="date" {...register('due_date')} className="input" />
            </div>
          </div>
        </div>

        {/* Line items */}
        <div className="card space-y-4">
          <h2 className="text-base font-semibold text-slate-900">Line items</h2>

          <div className="hidden sm:grid sm:grid-cols-[1fr_80px_110px_90px_36px] gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500 pb-1 border-b border-slate-100">
            <span>Description</span>
            <span>Qty</span>
            <span>Unit price (£)</span>
            <span>VAT</span>
            <span />
          </div>

          {fields.map((field, i) => (
            <div key={field.id} className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_80px_110px_90px_36px] items-start">
              <div>
                <input
                  {...register(`items.${i}.description`)}
                  placeholder="Description"
                  className={`input ${errors.items?.[i]?.description ? 'input-error' : ''}`}
                  aria-label="Description"
                />
                {errors.items?.[i]?.description && (
                  <p className="field-error">{errors.items[i]?.description?.message}</p>
                )}
              </div>
              <input
                {...register(`items.${i}.quantity`)}
                type="number"
                step="0.01"
                min="0.01"
                className="input text-right tabular-nums"
                aria-label="Quantity"
              />
              <div>
                <input
                  {...register(`items.${i}.unit_price`)}
                  type="number"
                  min="0"
                  step="0.01"
                  className="input text-right tabular-nums"
                  aria-label="Unit price in pounds"
                  placeholder="0.00"
                />
                {errors.items?.[i]?.unit_price && (
                  <p className="field-error">{errors.items[i]?.unit_price?.message}</p>
                )}
              </div>
              <select {...register(`items.${i}.tax_rate`)} className="input" aria-label="VAT rate">
                <option value="0">0%</option>
                <option value="0.05">5%</option>
                <option value="0.2">20%</option>
              </select>
              <button
                type="button"
                onClick={() => remove(i)}
                disabled={fields.length === 1}
                className="flex h-10 w-9 items-center justify-center rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                aria-label="Remove line"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          ))}

          <button
            type="button"
            onClick={() => append(NEW_LINE)}
            className="text-sm text-blue-600 hover:text-blue-800 font-medium flex items-center gap-1"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            Add line
          </button>

          {/* Totals */}
          <div className="border-t border-slate-100 pt-4 space-y-1 text-sm">
            <div className="flex justify-between text-slate-500">
              <span>Subtotal</span>
              <span className="tabular-nums">{formatPence(subtotal)}</span>
            </div>
            <div className="flex justify-between text-slate-500">
              <span>VAT</span>
              <span className="tabular-nums">{formatPence(vatTotal)}</span>
            </div>
            <div className="flex justify-between font-semibold text-slate-900 text-base pt-1 border-t border-slate-100">
              <span>Total</span>
              <span className="tabular-nums">{formatPence(total)}</span>
            </div>
          </div>
        </div>

        {/* Notes */}
        <div className="card">
          <label htmlFor="inv-notes" className="field-label">Notes (optional)</label>
          <textarea id="inv-notes" {...register('notes')} rows={3} className="input resize-none mt-1" />
        </div>

        {create.isError && (
          <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2" role="alert">
            <p className="text-sm text-red-700">
              {(create.error as Error)?.message ?? 'Failed to save invoice'}
            </p>
          </div>
        )}

        <div className="flex gap-3">
          <button type="submit" disabled={create.isPending} className="btn-primary">
            {create.isPending ? (
              <>
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" aria-hidden="true" />
                Saving…
              </>
            ) : invoiceId ? 'Save changes' : 'Save draft'}
          </button>
          <button type="button" onClick={() => router.back()} className="btn-secondary">Cancel</button>
        </div>
      </form>
    </div>
  );
}
