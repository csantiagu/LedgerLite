// Helpers for creating a bill from a bank payment (/bills/new?transaction=…). Money is pence.

import { formatPence } from './formatters';

/**
 * Net amount (pence) of a one-line bill whose VAT-inclusive total must equal `gross`, using the
 * server's rounding (VAT = round(net × rate)). Falls back to the closest net when no net gives the
 * gross exactly.
 */
export function netForGross(gross: number, rate: number): number {
  if (rate <= 0) return gross;
  const start = Math.round(gross / (1 + rate));
  for (let net = start - 2; net <= start + 2; net++) {
    if (grossFromNet(net, rate) === gross) return net;
  }
  // `start` is always within a penny of the gross, so no other net can be closer
  return start;
}

/** VAT-inclusive total (pence) of a one-line bill with net `net` at `rate`. */
export function grossFromNet(net: number, rate: number): number {
  if (rate <= 0) return net;
  return net + Math.round(net * rate);
}

/** The vendor whose name appears in the bank text (longest name wins), if any. */
export function guessVendor<V extends { name: string }>(vendors: V[], text: string): V | null {
  const haystack = text.toLowerCase();
  let best: V | null = null;
  for (const v of vendors) {
    const name = v.name.trim().toLowerCase();
    if (name.length < 3 || !haystack.includes(name)) continue;
    if (!best || name.length > best.name.trim().length) best = v;
  }
  return best;
}

/** The bank payment a bill is being created for (GET /transactions/:id) */
export type BankLine = {
  id: string; date: string; description: string; reference: string | null; amount: number;
  is_reconciled: number; account_name: string | null;
  matches: { status: string; allocated_amount: number }[];
};

/** Pence of a money-out bank line not yet taken by a pending or posted match. */
export function unmatchedAmount(line: Pick<BankLine, 'amount' | 'matches'>): number {
  const taken = line.matches
    .filter(m => m.status === 'pending' || m.status === 'posted')
    .reduce((s, m) => s + m.allocated_amount, 0);
  return -line.amount - taken;
}

/** Why a bill can't be created from this bank line, or null when it can. */
export function bankLineProblem(line: BankLine | undefined): string | null {
  if (!line) return 'Bank line not found.';
  if (line.amount >= 0) return 'Bills can only be created from money going out.';
  if (line.is_reconciled) return 'This bank line is already posted. Undo it in the Bank page first.';
  if (unmatchedAmount(line) <= 0) return 'This bank payment is already fully matched. Remove its match first.';
  return null;
}

/**
 * The vendor to start the form with: the one in ?vendor= if it is active, else one named in the
 * bank text, else none ('').
 */
export function initialVendorId(vendors: { id: string; name: string }[], vendorId: string | null, line: BankLine | null): string {
  if (vendorId && vendors.some(v => v.id === vendorId)) return vendorId;
  if (line) return guessVendor(vendors, `${line.description} ${line.reference ?? ''}`)?.id ?? '';
  return '';
}

/** Subtotal and VAT (pence) of the form's lines, whose prices are typed in pounds, rounded as the server does. */
export function formTotals(items: { quantity: number; unit_price: number; tax_rate: number }[]): { subtotal: number; vat: number } {
  let subtotal = 0;
  let vat = 0;
  for (const i of items) {
    const line = Math.round((Number(i.quantity) || 0) * Math.round((Number(i.unit_price) || 0) * 100));
    subtotal += line;
    vat += Math.round(line * (Number(i.tax_rate) || 0));
  }
  return { subtotal, vat };
}

/** Indexes of lines with no category. */
export const linesMissingCategory = (items: { expense_category_id?: string }[]): number[] =>
  items.flatMap((item, i) => (item.expense_category_id ? [] : [i]));

/** What happens when the bill total and the unmatched bank amount differ (pence), or null when they agree. */
export function mismatchNote(total: number, bankRemaining: number): string | null {
  if (total === bankRemaining) return null;
  return total > bankRemaining
    ? `The bill is more than the bank payment: ${formatPence(bankRemaining)} will be matched and the rest stays owed.`
    : `The bill is less than the bank payment: ${formatPence(bankRemaining - total)} of the payment is left to match or categorise.`;
}

/**
 * The message for a bill that was saved while the form stays open, or null to move on.
 * `matchError` is the server's reason the bank match failed (null if it matched, or for a bill
 * not created from a bank payment).
 */
export function heldBillMessage(o: { fromBank: boolean; attachmentFailed: boolean; matchError: string | null }): string | null {
  const findMatch = 'Match it from the Bank page with Find match.';
  if (o.matchError !== null) {
    return o.attachmentFailed
      ? `Bill saved, but the supplier invoice did not upload and it couldn't be matched to the bank payment: ${o.matchError} ${findMatch}`
      : `Bill saved, but it couldn't be matched to the bank payment: ${o.matchError} ${findMatch}`;
  }
  if (!o.attachmentFailed) return null;
  return o.fromBank
    ? 'Bill saved and matched to the bank payment, but the supplier invoice did not upload. Add it from the bill.'
    : 'Bill saved, but the supplier invoice did not upload. Add it from the bill.';
}

/**
 * The button that sets a one-line bill to the bank amount, and the warning when the VAT rate can't
 * reach it in whole pence (`closestTotal` is the nearest total the rate allows).
 */
export function closestAmountAction(closestTotal: number, bankRemaining: number): { label: string; note: string | null } {
  if (closestTotal === bankRemaining) return { label: 'Match the bank amount', note: null };
  return {
    label: 'Use the closest amount',
    note: `This rate can't land on the bank payment exactly. The closest bill is ${formatPence(closestTotal - bankRemaining)} more, and that penny stays owed.`,
  };
}
