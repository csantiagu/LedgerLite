'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { formatPence } from '@/lib/formatters';
import { parsePence } from '@/lib/quickbooksImport';
import { creditLinesFrom, creditPayload, vatCreditDefault, type InvoiceLine } from '@/lib/creditNote';
import { LockedPeriodNote } from '@/components/PeriodLock';

type CreditInvoice = {
  id: string; invoice_number: string; issue_date: string;
  subtotal: number; tax_amount: number; total: number; amount_paid: number;
  items: InvoiceLine[];
};

/**
 * Credit all or part of an issued invoice. To correct an invoice, credit it in full and raise a
 * new one with the right details. A VAT-only invoice is credited as an amount of VAT: the part
 * the customer will not pay, after the rest was paid to HMRC.
 */
export function CreditNoteForm({ invoice, alreadyCredited, onClose }: {
  invoice: CreditInvoice;
  /** Credit already given on this invoice by earlier credit notes */
  alreadyCredited: number;
  onClose: () => void;
}) {
  const vatOnly = invoice.subtotal === 0 && invoice.tax_amount > 0;
  return vatOnly
    ? <VatCredit invoice={invoice} alreadyCredited={alreadyCredited} onClose={onClose} />
    : <LineCredit invoice={invoice} alreadyCredited={alreadyCredited} onClose={onClose} />;
}

function useIssueCredit(invoiceId: string) {
  const router = useRouter();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api<{ id: string }>(
      `/api/v1/invoices/${invoiceId}/credit-note`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
    onSuccess: r => {
      qc.invalidateQueries({ queryKey: ['invoices'] });
      qc.invalidateQueries({ queryKey: ['invoice', invoiceId] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      router.push(`/invoices/view?id=${r.id}`);
    },
  });
}

function VatCredit({ invoice, alreadyCredited, onClose }: {
  invoice: CreditInvoice; alreadyCredited: number; onClose: () => void;
}) {
  const create = useIssueCredit(invoice.id);
  const left = invoice.total - alreadyCredited;
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState('');
  const [amount, setAmount] = useState(() => (vatCreditDefault(invoice.total, invoice.amount_paid, alreadyCredited) / 100).toFixed(2));
  const pence = parsePence(amount);
  const error = pence === null || pence <= 0
    ? 'Enter the VAT to credit, in pounds'
    : pence > left ? `Only ${formatPence(left)} of this VAT is left to credit` : null;

  return (
    <div className="card space-y-4">
      <div>
        <h2 className="text-base font-semibold text-slate-900">Credit VAT on {invoice.invoice_number}</h2>
        <p className="mt-1 text-sm text-slate-500">
          This invoice is the VAT on a sale, not the sale itself. Credit the part the customer will not pay.
          It clears what they owe. The VAT return for the credit note&rsquo;s date goes down by the same amount,
          which is how VAT you have already paid to HMRC comes back.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="cn-vat" className="field-label">VAT to credit (£)</label>
          <input id="cn-vat" className="input text-right tabular-nums" value={amount} inputMode="decimal"
            onChange={e => setAmount(e.target.value)} />
        </div>
        <div>
          <label htmlFor="cn-date" className="field-label">Credit note date</label>
          <input id="cn-date" type="date" className="input" value={date} min={invoice.issue_date} onChange={e => setDate(e.target.value)} />
        </div>
        <div className="sm:col-span-2">
          <label htmlFor="cn-reason" className="field-label">Reason <span className="text-red-500" aria-hidden="true">*</span></label>
          <input id="cn-reason" className="input" value={reason} maxLength={500} onChange={e => setReason(e.target.value)}
            placeholder="e.g. Customer paid part of the VAT and will not pay the rest" />
        </div>
      </div>
      <LockedPeriodNote date={date} />
      <p className="flex justify-between text-sm font-semibold"><span>Credit</span><span className="tabular-nums">{pence ? formatPence(pence) : '—'}</span></p>
      {(error || create.isError) && (
        <p className="text-sm text-red-700" role="alert">{error ?? (create.error as Error).message}</p>
      )}
      <div className="flex gap-3">
        <button type="button" className="btn-primary" disabled={!!error || reason.trim().length < 3 || create.isPending}
          onClick={() => create.mutate({ issue_date: date, reason, vat_amount: pence })}>
          {create.isPending ? 'Issuing…' : `Issue credit note for ${pence ? formatPence(pence) : ''}`}
        </button>
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

function LineCredit({ invoice, alreadyCredited, onClose }: {
  invoice: CreditInvoice; alreadyCredited: number; onClose: () => void;
}) {
  const create = useIssueCredit(invoice.id);
  const [lines, setLines] = useState(() => creditLinesFrom(invoice.items));
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState('');
  const payload = creditPayload(lines);
  const whole = alreadyCredited === 0 && linesUnchanged(invoice.items, lines);
  const left = invoice.total - alreadyCredited;
  const over = left < payload.total;

  const update = (i: number, patch: Partial<(typeof lines)[number]>) =>
    setLines(ls => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  return (
    <div className="card space-y-4">
      <div>
        <h2 className="text-base font-semibold text-slate-900">Credit {invoice.invoice_number}</h2>
        <p className="mt-1 text-sm text-slate-500">
          A credit note reduces what the customer owes on this invoice; any credit left over can be refunded.
          To correct an invoice, credit it in full and then raise a new one with the right details.
          Each line keeps the invoice&rsquo;s VAT rate, and can&rsquo;t credit more at that rate than the invoice charged.
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
            <span className="text-sm text-slate-600 text-right">{Math.round(l.tax_rate * 10000) / 100}%</span>
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
      <LockedPeriodNote date={date} />

      <div className="text-sm space-y-0.5">
        <p className="flex justify-between text-slate-500"><span>Net</span><span className="tabular-nums">{formatPence(payload.subtotal)}</span></p>
        <p className="flex justify-between text-slate-500"><span>VAT</span><span className="tabular-nums">{formatPence(payload.vat)}</span></p>
        <p className="flex justify-between font-semibold"><span>Credit</span><span className="tabular-nums">{formatPence(payload.total)}</span></p>
        {over && <p className="text-amber-800">Only {formatPence(left)} of this invoice is left to credit.</p>}
      </div>

      {(payload.error || create.isError) && (
        <p className="text-sm text-red-700" role="alert">{payload.error ?? (create.error as Error).message}</p>
      )}
      <div className="flex gap-3">
        <button type="button" className="btn-primary"
          disabled={!!payload.error || over || reason.trim().length < 3 || create.isPending}
          onClick={() => create.mutate({ issue_date: date, reason, ...(whole ? {} : { items: payload.items }) })}>
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
