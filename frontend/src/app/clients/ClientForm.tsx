'use client';

import { useForm, type FieldError } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { CLIENT_LIMITS, ClientSchema, type ClientFormData } from '@/lib/clients';

type Props = {
  defaultValues?: Partial<ClientFormData>;
  /** Called with valid data. To clear the boxes after a save, give the form a new `key`. */
  onSubmit: (data: ClientFormData) => void;
  submitLabel: string;
  pending: boolean;
  error?: Error | null;
  onCancel?: () => void;
};

function FieldMessage({ id, error, hint }: { id: string; error?: FieldError; hint?: string }) {
  if (error) return <p id={id} className="field-error" role="alert">{error.message}</p>;
  return hint ? <p id={id} className="mt-1 text-xs text-slate-500">{hint}</p> : null;
}

export function ClientForm({ defaultValues, onSubmit, submitLabel, pending, error, onCancel }: Props) {
  const { register, handleSubmit, formState: { errors } } = useForm<ClientFormData>({
    resolver: zodResolver(ClientSchema),
    defaultValues,
  });

  // Each box with its label, limit, error state and the message under it
  const field = (name: keyof typeof CLIENT_LIMITS, id: string, { hint = false, className = '' } = {}) => ({
    id,
    ...register(name),
    maxLength: CLIENT_LIMITS[name],
    className: `input ${errors[name] ? 'input-error' : ''} ${className}`,
    'aria-invalid': !!errors[name],
    'aria-describedby': errors[name] || hint ? `${id}-msg` : undefined,
  });

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-5">
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <div>
          <label htmlFor="cl-name" className="field-label">
            Name <span className="text-red-500" aria-hidden="true">*</span>
          </label>
          <input {...field('name', 'cl-name', { hint: true })} />
          <FieldMessage id="cl-name-msg" error={errors.name} hint="The person or business the invoice is addressed to." />
        </div>
        <div>
          <label htmlFor="cl-company" className="field-label">Company name</label>
          <input {...field('company_name', 'cl-company', { hint: true })} />
          <FieldMessage id="cl-company-msg" error={errors.company_name} hint="If applicable. Shown under the name on invoices." />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <div>
          <label htmlFor="cl-email" className="field-label">Email</label>
          <input
            id="cl-email" type="email" {...register('email')}
            className={`input ${errors.email ? 'input-error' : ''}`}
            aria-invalid={!!errors.email} aria-describedby={errors.email ? 'cl-email-msg' : undefined}
          />
          <FieldMessage id="cl-email-msg" error={errors.email} />
        </div>
        <div>
          <label htmlFor="cl-phone" className="field-label">Phone</label>
          <input type="tel" {...field('phone', 'cl-phone')} />
          <FieldMessage id="cl-phone-msg" error={errors.phone} />
        </div>
      </div>

      <div>
        <label htmlFor="cl-address" className="field-label">Address</label>
        <textarea {...field('address', 'cl-address', { hint: true, className: 'resize-none' })} rows={4} placeholder={'Street\nTown\nPostcode'} />
        <FieldMessage id="cl-address-msg" error={errors.address} hint="If applicable. Up to four lines are printed under Bill to." />
      </div>

      <div>
        <label htmlFor="cl-tax" className="field-label">VAT / tax number</label>
        <input {...field('tax_id', 'cl-tax')} placeholder="GB123456789" />
        <FieldMessage id="cl-tax-msg" error={errors.tax_id} />
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
        <textarea {...field('notes', 'cl-notes', { className: 'resize-none' })} rows={2} />
        <FieldMessage id="cl-notes-msg" error={errors.notes} />
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2" role="alert">
          <p className="text-sm text-red-700">{error.message || 'Couldn’t save the client'}</p>
        </div>
      )}

      <div className="flex gap-3">
        <button type="submit" disabled={pending} className="btn-primary">
          {pending ? (
            <>
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" aria-hidden="true" />
              Saving…
            </>
          ) : submitLabel}
        </button>
        {onCancel && <button type="button" onClick={onCancel} className="btn-secondary">Cancel</button>}
      </div>
    </form>
  );
}
