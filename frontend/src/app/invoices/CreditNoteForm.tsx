'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { formatPence } from '@/lib/formatters';
import { creditLinesFrom, creditPayload, type InvoiceLine } from '@/lib/creditNote';

/**
 * Credit all or part of an issued invoice. To correct an invoice, credit it in full and raise a
 * new one with the right details.
 */
export function CreditNoteForm({ invoice, alreadyCredited, onClose }: {
  invoice: { id: string; invoice_number: string; issue_date: string; total: number; items: InvoiceLine[] };
  /** Credit already given on this invoice by earlier credit notes */
  alreadyCredited: number;
  onClose: () => void;
}) {
  const router = useRouter();
  const qc = useQueryClient();
  const [lines, setLines] = useState(() => creditLinesFrom(invoice.items));
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState('');
  const payload = creditPayload(lines);
  // Untouched lines on an invoice not yet credited: ask for a full credit (the server copies the lines)
  const whole = alreadyCredited === 0 && linesUnchanged(invoice.items, lines);
  const left = invoice.total - alreadyCredited;

  const create = useMutation({
    mutationFn: () => api<{ id: string; invoice_number: string; applied: number; credit_left: number }>(
      `/api/v1/invoices/${invoice.id}/credit-note`,
      { method: 'POST', body: JSON.stringify({ issue_date: date, reason, ...(whole ? {} : { items: payload.items }) }) },
    ),
    onSuccess: r => {
      qc.invalidateQueries({ queryKey: ['invoices'] });
      qc.invalidateQueries({ queryKey: ['invoice', invoice.id] });
      router.push(`/invoices/view?id=${r.id}`);
    },
  });

  const update = (i: number, patch: Partial<(typeof lines)[number]>) =>
    setLines(ls => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  return (
    <div className="card space-y-4">
      <div>
        <h2 className="text-base font-semibold text-slate-900">Credit {invoice.invoice_number}</h2>
        <p className="mt-1 text-sm text-slate-500">
          A credit note reduces what the customer owes on this invoice; any credit left over can be refunded.
          To correct an invoice, credit it in full and then raise a new one with the right details.
          The VAT on each line stays at the invoice&rsquo;s rate.
        </p>
      </div>

      <div className="space-y-2">
        <div className="hidden sm:grid sm:grid-cols-[24px_1fr_80px_110px_60px] gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          <span /><span>Description</span><span>Qty</span><span>Unit price (£)</span><span>VAT</span>
        </div>
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-[24px_1fr] sm:grid-cols-[24px_1fr_80px_110px_60px] gap-2 items-center">
            <input type="checkbox" checked={l.include} onChange={e => update(i, { include: e.target.checked })}
              aria-label={`Credit “${l.description}”`} />
            <input className="input" value={l.description} disabled={!l.include}
              onChange={e => update(i, { description: e.target.value })} aria-label="Description" />
            <input className="input text-right tabular-nums" value={l.quantity} disabled={!l.include} inputMode="decimal"
              onChange={e => update(i, { quantity: e.target.value })} aria-label="Quantity" />
            <input className="input text-right tabular-nums" value={l.unit_price} disabled={!l.include} inputMode="decimal"
              onChange={e => update(i, { unit_price: e.target.value })} aria-label="Unit price in pounds" />
            <span className="text-sm text-slate-600 text-right">{Math.round(l.tax_rate * 100)}%</span>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="cn-date" className="field-label">Credit note date</label>
          <input id="cn-date" type="date" className="input" value={date} min={invoice.issue_date} onChange={e => setDate(e.target.value)} />
        </div>
        <div>
          <label htmlFor="cn-reason" className="field-label">Reason <span className="text-red-500" aria-hidden="true">*</span></label>
          <input id="cn-reason" className="input" value={reason} maxLength={500} onChange={e => setReason(e.target.value)}
            placeholder="e.g. Charged for 4 hours, worked 3" />
        </div>
      </div>

      <div className="text-sm space-y-0.5">
        <p className="flex justify-between text-slate-500"><span>Net</span><span className="tabular-nums">{formatPence(payload.subtotal)}</span></p>
        <p className="flex justify-between text-slate-500"><span>VAT</span><span className="tabular-nums">{formatPence(payload.vat)}</span></p>
        <p className="flex justify-between font-semibold"><span>Credit</span><span className="tabular-nums">{formatPence(payload.total)}</span></p>
        {left < payload.total && <p className="text-amber-800">Only {formatPence(left)} of this invoice is left to credit.</p>}
      </div>

      {(payload.error || create.isError) && (
        <p className="text-sm text-red-700" role="alert">{payload.error ?? (create.error as Error).message}</p>
      )}
      <div className="flex gap-3">
        <button type="button" className="btn-primary" disabled={!!payload.error || reason.trim().length < 3 || create.isPending}
          onClick={() => create.mutate()}>
          {create.isPending ? 'Issuing…' : `Issue credit note for ${formatPence(payload.total)}`}
        </button>
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

/** Whether the lines are exactly the invoice's own, all ticked and unchanged. */
function linesUnchanged(items: InvoiceLine[], lines: ReturnType<typeof creditLinesFrom>) {
  const original = creditLinesFrom(items);
  return lines.length === original.length && lines.every((l, i) =>
    l.include && l.description === original[i]!.description && l.quantity === original[i]!.quantity
    && l.unit_price === original[i]!.unit_price);
}
