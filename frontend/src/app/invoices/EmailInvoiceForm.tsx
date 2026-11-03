'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { api } from '@/lib/api';
import { EmailSchema, emailBody, type EmailFormData } from '@/lib/invoiceEmail';

type Preview = {
  to: string; from: string | null; reply_to: string | null;
  subject: string; message: string; attachment: string;
  /** `settings`: fixed on Settings → Company */
  problems: Array<{ code: string; settings: boolean; message: string }>;
};

// Emailing a finalised invoice: the template fills the form in, the owner checks or changes it, and
// it's sent with the PDF attached. Finalising never sends anything by itself.
export function EmailInvoiceForm({ invoiceId, onClose }: { invoiceId: string; onClose: () => void }) {
  const { data: preview, isLoading, isError } = useQuery<Preview>({
    queryKey: ['invoice-email', invoiceId],
    queryFn: () => api<Preview>(`/api/v1/invoices/${invoiceId}/email`),
    // Not kept after the form closes: the form takes its first values from this, so reopening it
    // after changing the client's email or the template must fetch them again
    gcTime: 0,
  });

  if (isLoading) return <div className="card h-40 animate-pulse bg-slate-50" />;
  if (isError || !preview) {
    return (
      <div className="card">
        <p className="text-sm text-red-700" role="alert">Couldn’t prepare the email.</p>
      </div>
    );
  }
  return <EmailFields invoiceId={invoiceId} preview={preview} onClose={onClose} />;
}

function EmailFields({ invoiceId, preview, onClose }: { invoiceId: string; preview: Preview; onClose: () => void }) {
  const qc = useQueryClient();
  // One key per opened form: sending it twice (a double click, a retry) sends one email
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const { register, handleSubmit, formState: { errors } } = useForm<EmailFormData>({
    resolver: zodResolver(EmailSchema),
    defaultValues: { to: preview.to, cc: '', subject: preview.subject, message: preview.message },
  });

  const send = useMutation({
    mutationFn: (data: EmailFormData) => api(`/api/v1/invoices/${invoiceId}/email`, {
      method: 'POST', body: JSON.stringify(emailBody(data, idempotencyKey)),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['invoice', invoiceId] });
      qc.invalidateQueries({ queryKey: ['audit'] });
      onClose();
    },
  });

  const blocked = preview.problems.length > 0;

  return (
    <form onSubmit={handleSubmit(d => send.mutate(d))} noValidate className="card space-y-4">
      <div>
        <h2 className="text-base font-semibold text-slate-900">Email invoice</h2>
        <p className="mt-1 text-xs text-slate-500">
          {preview.from ? <>From {preview.from}</> : 'No From address yet'}
          {preview.reply_to && <> · replies to {preview.reply_to}</>}
          {' · '}{preview.attachment} attached
        </p>
      </div>

      {blocked && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800" role="alert">
          {preview.problems.map(p => <p key={p.code}>{p.message}</p>)}
          {preview.problems.some(p => p.settings) && (
            <Link href="/settings/company" className="mt-1 inline-block text-xs text-blue-700 hover:text-blue-900">
              Settings → Company
            </Link>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="em-to" className="field-label">To <span className="text-red-500" aria-hidden="true">*</span></label>
          <input id="em-to" type="email" {...register('to')} maxLength={200} className={`input ${errors.to ? 'input-error' : ''}`} aria-invalid={!!errors.to} />
          {errors.to
            ? <p className="field-error" role="alert">{errors.to.message}</p>
            : !preview.to && <p className="mt-1 text-xs text-slate-500">The client has no email address saved.</p>}
        </div>
        <div>
          <label htmlFor="em-cc" className="field-label">CC</label>
          <input id="em-cc" {...register('cc')} className={`input ${errors.cc ? 'input-error' : ''}`} placeholder="Separate several with commas" aria-invalid={!!errors.cc} />
          {errors.cc && <p className="field-error" role="alert">{errors.cc.message}</p>}
        </div>
      </div>

      <div>
        <label htmlFor="em-subject" className="field-label">Subject <span className="text-red-500" aria-hidden="true">*</span></label>
        <input id="em-subject" {...register('subject')} maxLength={200} className={`input ${errors.subject ? 'input-error' : ''}`} aria-invalid={!!errors.subject} />
        {errors.subject && <p className="field-error" role="alert">{errors.subject.message}</p>}
      </div>

      <div>
        <label htmlFor="em-message" className="field-label">Message <span className="text-red-500" aria-hidden="true">*</span></label>
        <textarea id="em-message" {...register('message')} maxLength={10_000} rows={9} className={`input ${errors.message ? 'input-error' : ''}`} aria-invalid={!!errors.message} />
        {errors.message && <p className="field-error" role="alert">{errors.message.message}</p>}
      </div>

      {send.isError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2" role="alert">
          <p className="text-sm text-red-700">{(send.error as Error).message}</p>
        </div>
      )}

      <div className="flex gap-3">
        <button type="submit" className="btn-primary" disabled={blocked || send.isPending}>
          {send.isPending ? 'Sending…' : 'Send email'}
        </button>
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}
