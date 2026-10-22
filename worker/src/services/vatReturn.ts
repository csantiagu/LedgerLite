// The nine boxes of a UK VAT return for a period, worked out from the books.
//
// Standard accounting: sales by invoice and credit note date, purchases by bill date. Cash
// accounting: both by when the money moved (payments received, refunds paid, bills paid).
// Either way, posted bank lines explained by a category (not matched to an invoice or bill) add the
// VAT inside them: to sales or purchases as the category's vat_box says, nothing when 'excluded'.
// Outside-scope sales (services to customers abroad) have no VAT, so they count in box 6 only.
// Boxes 8 and 9 (goods to and from the EU, Northern Ireland only) are always 0 here.
import { netOfVat, vatInGross } from './money';

export type VatScheme = 'standard' | 'cash';

export type VatBoxes = {
  box1: number;  // VAT due on sales
  box2: number;  // VAT due on EU acquisitions (NI only)
  box3: number;  // box 1 + box 2
  box4: number;  // VAT reclaimed on purchases
  box5: number;  // box 3 − box 4: to pay (or, negative, to reclaim)
  box6: number;  // sales excluding VAT
  box7: number;  // purchases excluding VAT
  box8: number;  // goods supplied to the EU (NI only)
  box9: number;  // goods acquired from the EU (NI only)
};

export type VatReturn = VatBoxes & {
  from: string; to: string; scheme: VatScheme;
  /** Where the figures came from, all in pence: VAT and net for each source */
  parts: Array<{ source: string; vat: number; net: number; count: number }>;
  /** Posted bank lines in the period whose VAT was never chosen (counted as no VAT) */
  vatNotSet: number;
};

type Part = { source: string; vat: number; net: number; count: number };

/** Adds up sales and purchases parts into the nine boxes. Pure, so it can be tested on its own. */
export function boxes(sales: Part[], purchases: Part[]): VatBoxes {
  const sum = (parts: Part[], k: 'vat' | 'net') => parts.reduce((n, p) => n + p[k], 0);
  const box1 = sum(sales, 'vat');
  const box4 = sum(purchases, 'vat');
  return {
    box1, box2: 0, box3: box1, box4, box5: box1 - box4,
    box6: sum(sales, 'net'), box7: sum(purchases, 'net'), box8: 0, box9: 0,
  };
}

/** One bank line's unexplained part as VAT and net, signed so money in is positive. */
export function bankLineVat(amount: number, allocated: number, vatRate: number | null): { vat: number; net: number } {
  const sign = amount < 0 ? -1 : 1;
  const remainder = Math.max(0, Math.abs(amount) - allocated);
  const vat = vatInGross(remainder, vatRate);
  // + 0 turns −0 into 0
  return { vat: sign * vat + 0, net: sign * (remainder - vat) + 0 };
}

export async function vatReturn(db: D1Database, from: string, to: string, scheme: VatScheme): Promise<VatReturn> {
  const sales: Part[] = [];
  const purchases: Part[] = [];

  if (scheme === 'standard') {
    const [docs, bills] = await db.batch([
      db.prepare(`
        SELECT kind, vat_treatment, COUNT(*) AS n, COALESCE(SUM(subtotal), 0) AS net, COALESCE(SUM(tax_amount), 0) AS vat
        FROM invoices WHERE status NOT IN ('draft', 'void') AND issue_date BETWEEN ? AND ?
        GROUP BY kind, vat_treatment
      `).bind(from, to),
      db.prepare(`
        SELECT COUNT(*) AS n, COALESCE(SUM(subtotal), 0) AS net, COALESCE(SUM(tax_amount), 0) AS vat
        FROM bills WHERE status != 'void' AND COALESCE(issue_date, date(created_at)) BETWEEN ? AND ?
      `).bind(from, to),
    ]);
    for (const r of docs!.results as Array<{ kind: string; vat_treatment: string; n: number; net: number; vat: number }>) {
      const credit = r.kind === 'credit_note';
      const sign = credit ? -1 : 1;
      sales.push({
        source: `${credit ? 'Credit notes' : 'Invoices'}${r.vat_treatment === 'outside_scope' ? ' (outside the scope of UK VAT)' : ''}`,
        vat: sign * r.vat, net: sign * r.net, count: r.n,
      });
    }
    const b = bills!.results[0] as { n: number; net: number; vat: number };
    purchases.push({ source: 'Supplier bills', vat: b.vat, net: b.net, count: b.n });
  } else {
    const [received, made] = await db.batch([
      db.prepare(`
        SELECT pr.amount, i.subtotal, i.total, i.kind FROM payments_received pr
        JOIN invoices i ON i.id = pr.invoice_id
        WHERE i.status != 'void' AND pr.payment_date BETWEEN ? AND ?
      `).bind(from, to),
      db.prepare(`
        SELECT pm.amount, b.subtotal, b.total FROM payments_made pm
        JOIN bills b ON b.id = pm.bill_id
        WHERE b.status != 'void' AND pm.payment_date BETWEEN ? AND ?
      `).bind(from, to),
    ]);
    const paid = { source: 'Payments received on invoices', vat: 0, net: 0, count: 0 };
    const refunded = { source: 'Refunds paid on credit notes', vat: 0, net: 0, count: 0 };
    for (const r of received!.results as Array<{ amount: number; subtotal: number; total: number; kind: string }>) {
      const part = r.kind === 'credit_note' ? refunded : paid;
      const sign = r.kind === 'credit_note' ? -1 : 1;
      const net = netOfVat(r.amount, r.subtotal, r.total);
      part.net += sign * net;
      part.vat += sign * (r.amount - net);
      part.count += 1;
    }
    sales.push(paid, refunded);
    const billsPaid = { source: 'Payments made on bills', vat: 0, net: 0, count: 0 };
    for (const r of made!.results as Array<{ amount: number; subtotal: number; total: number }>) {
      const net = netOfVat(r.amount, r.subtotal, r.total);
      billsPaid.net += net;
      billsPaid.vat += r.amount - net;
      billsPaid.count += 1;
    }
    purchases.push(billsPaid);
  }

  // Bank lines explained by a category: only the part not matched or linked to an invoice or bill
  const { results: lines } = await db.prepare(`
    SELECT t.amount, t.vat_rate, ec.vat_box,
      (SELECT COALESCE(SUM(allocated_amount), 0) FROM transaction_matches
        WHERE transaction_id = t.id AND status = 'posted') AS allocated
    FROM transactions t JOIN expense_categories ec ON ec.id = t.expense_category_id
    WHERE t.is_reconciled = 1 AND t.date BETWEEN ? AND ? AND ec.vat_box != 'excluded'
  `).bind(from, to).all<{ amount: number; vat_rate: number | null; vat_box: string; allocated: number }>();
  const bankSales = { source: 'Bank lines in sales categories', vat: 0, net: 0, count: 0 };
  const bankPurchases = { source: 'Bank lines in purchase categories', vat: 0, net: 0, count: 0 };
  let vatNotSet = 0;
  for (const l of lines) {
    if (Math.abs(l.amount) <= l.allocated) continue;
    if (l.vat_rate === null) vatNotSet += 1;
    const { vat, net } = bankLineVat(l.amount, l.allocated, l.vat_rate);
    if (l.vat_box === 'sales') {
      bankSales.vat += vat; bankSales.net += net; bankSales.count += 1;
    } else {
      // Money out is a purchase; money in (a refund from a supplier) takes one away
      bankPurchases.vat -= vat; bankPurchases.net -= net; bankPurchases.count += 1;
    }
  }
  sales.push(bankSales);
  purchases.push(bankPurchases);

  return {
    from, to, scheme, ...boxes(sales, purchases),
    parts: [...sales, ...purchases].filter(p => p.count > 0),
    vatNotSet,
  };
}
