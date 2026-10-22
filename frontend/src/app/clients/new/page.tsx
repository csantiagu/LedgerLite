'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useRouter } from 'next/navigation';
import { AppShell } from '@/components/layout/AppShell';
import { RoleGuard } from '@/components/RoleGuard';
import { api } from '@/lib/api';

const Schema = z.object({
  name:    z.string().min(1, 'Name required'),
  email:   z.string().email('Valid email required').or(z.literal('')).optional(),
  phone:   z.string().max(30).optional(),
  address: z.string().max(500).optional(),
  tax_id:  z.string().max(50).optional(),
  notes:   z.string().max(1000).optional(),
  overseas: z.boolean().optional(),
});
type FormData = z.infer<typeof Schema>;

export default function NewClientPage() {
  return (
    <AppShell>
      <RoleGuard allowedRoles={['owner']}>
        <NewClientContent />
      </RoleGuard>
    </AppShell>
  );
}

function NewClientContent() {
  const router = useRouter();
  const qc = useQueryClient();

  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<FormData>({
    resolver: zodResolver(Schema),
  });

  const create = useMutation({
    mutationFn: (data: FormData) =>
      api<{ id: string }>('/api/v1/clients', { method: 'POST', body: JSON.stringify({
        ...data,
        // `overseas` is only the form's checkbox; the API takes vat_treatment
        email: data.email || null,
        phone: data.phone || null,
        address: data.address || null,
        tax_id: data.tax_id || null,
        notes: data.notes || null,
        overseas: undefined,
        vat_treatment: data.overseas ? 'outside_scope' : 'standard',
      })}),
    onSuccess: ({ id }) => {
      qc.invalidateQueries({ queryKey: ['clients'] });
      router.push(`/clients/view?id=${id}`);
    },
  });

  return (
    <div className="max-w-xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Add client</h1>
        <p className="mt-1 text-sm text-slate-500">Create a new client account.</p>
      </div>

      <form onSubmit={handleSubmit(d => create.mutate(d))} noValidate className="card space-y-5">
        <div>
          <label htmlFor="cl-name" className="field-label">
            Company / name <span className="text-red-500" aria-hidden="true">*</span>
          </label>
          <input
            id="cl-name"
            {...register('name')}
            className={`input ${errors.name ? 'input-error' : ''}`}
            aria-invalid={!!errors.name}
            aria-describedby={errors.name ? 'cl-name-err' : undefined}
          />
          {errors.name && <p id="cl-name-err" className="field-error" role="alert">{errors.name.message}</p>}
        </div>

        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <div>
            <label htmlFor="cl-email" className="field-label">Email</label>
            <input id="cl-email" type="email" {...register('email')} className={`input ${errors.email ? 'input-error' : ''}`} />
            {errors.email && <p className="field-error" role="alert">{errors.email.message}</p>}
          </div>
          <div>
            <label htmlFor="cl-phone" className="field-label">Phone</label>
            <input id="cl-phone" type="tel" {...register('phone')} className="input" />
          </div>
        </div>

        <div>
          <label htmlFor="cl-address" className="field-label">Address</label>
          <textarea id="cl-address" {...register('address')} rows={3} className="input resize-none" />
        </div>

        <div>
          <label htmlFor="cl-tax" className="field-label">VAT / tax number</label>
          <input id="cl-tax" {...register('tax_id')} className="input" placeholder="GB123456789" />
        </div>

        <label className="flex items-start gap-2 text-sm text-slate-700">
          <input type="checkbox" {...register('overseas')} className="mt-1" />
          <span>
            Customer is outside the UK
            <span className="block text-xs text-slate-500">Services to them are outside the scope of UK VAT: their invoices charge no VAT.</span>
          </span>
        </label>

        <div>
          <label htmlFor="cl-notes" className="field-label">Notes</label>
          <textarea id="cl-notes" {...register('notes')} rows={2} className="input resize-none" />
        </div>

        {create.isError && (
          <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2" role="alert">
            <p className="text-sm text-red-700">
              {(create.error as Error)?.message ?? 'Failed to create client'}
            </p>
          </div>
        )}

        <div className="flex gap-3">
          <button type="submit" disabled={isSubmitting || create.isPending} className="btn-primary">
            {create.isPending ? (
              <>
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" aria-hidden="true" />
                Saving…
              </>
            ) : 'Save client'}
          </button>
          <button type="button" onClick={() => router.back()} className="btn-secondary">
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
