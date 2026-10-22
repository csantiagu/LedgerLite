// Building a credit note from an invoice's lines, and naming credit note states.
import { parsePence } from './quickbooksImport';

export type CreditLine = { description: string; quantity: string; unit_price: string; tax_rate: number; include: boolean };
export type InvoiceLine = { description: string; quantity: number; unit_price: number; tax_rate: number };

/** The invoice's lines as editable credit lines (prices in pounds text, all ticked). */
export const creditLinesFrom = (items: InvoiceLine[]): CreditLine[] => items.map(i => ({
  description: i.description, quantity: String(i.quantity), unit_price: (i.unit_price / 100).toFixed(2),
  tax_rate: i.tax_rate, include: true,
}));

/**
 * The ticked lines as the API takes them (pence), with the credit's total worked out the way the
 * server does it. `error` says what's wrong with the first bad line.
 */
export function creditPayload(lines: CreditLine[]): {
  items: InvoiceLine[]; subtotal: number; vat: number; total: number; error: string | null;
} {
  const items: InvoiceLine[] = [];
  let subtotal = 0;
  let vat = 0;
  for (const l of lines.filter(x => x.include)) {
    const quantity = Number(l.quantity);
    const unit = parsePence(l.unit_price);
    if (!l.description.trim()) return { items, subtotal, vat, total: subtotal + vat, error: 'Every line needs a description' };
    if (!(quantity > 0)) return { items, subtotal, vat, total: subtotal + vat, error: `“${l.description}”: the quantity must be more than 0` };
    if (unit === null || Number.isNaN(unit) || unit < 0) {
      return { items, subtotal, vat, total: subtotal + vat, error: `“${l.description}”: enter a price in pounds, such as 12.50` };
    }
    const net = Math.round(quantity * unit);
    subtotal += net;
    vat += Math.round(net * l.tax_rate);
    items.push({ description: l.description.trim(), quantity, unit_price: unit, tax_rate: l.tax_rate });
  }
  if (!items.length) return { items, subtotal, vat, total: 0, error: 'Tick at least one line to credit' };
  return { items, subtotal, vat, total: subtotal + vat, error: null };
}

/** A credit note's status in words: it's settled when all its credit is used or refunded. */
export const creditStatusLabel: Record<string, string> = {
  sent: 'Credit to refund',
  partial: 'Part refunded',
  paid: 'Settled',
  void: 'Void',
};
