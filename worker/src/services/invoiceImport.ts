// Plans an import of historical invoices (from a QuickBooks Online export) without touching the
// database: each row is checked and turned into the invoice, line and payment to create. The
// route then writes everything in one batch, so an import either lands completely or not at all.

export interface ImportRow {
  invoiceNumber: string;
  customer: string;
  issueDate: string;          // YYYY-MM-DD
  dueDate?: string | null;
  total: number;              // pence, VAT included
  subtotal?: number | null;   // pence, before VAT
  taxAmount?: number | null;  // pence
  openBalance: number;        // pence still owed
  paymentDate?: string | null;
  memo?: string | null;
}

export type RowOutcome =
  | { row: number; invoiceNumber: string; action: 'create'; status: 'paid' | 'partial' | 'sent';
      customer: string; newCustomer: boolean; warnings: string[] }
  | { row: number; invoiceNumber: string; action: 'skip'; reason: string };

export interface PlannedInvoice {
  invoiceNumber: string;
  customerKey: string;        // lower-cased customer name
  customerName: string;
  issueDate: string;
  dueDate: string;
  subtotal: number;
  taxAmount: number;
  total: number;
  amountPaid: number;
  status: 'paid' | 'partial' | 'sent';
  taxRate: number;
  description: string;
  paymentDate: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (s: unknown): s is string =>
  typeof s === 'string' && DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const isPence = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n);

export const customerKey = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

export function planImport(
  rows: ImportRow[],
  existingNumbers: Set<string>,
  existingCustomers: Set<string>,
): { outcomes: RowOutcome[]; invoices: PlannedInvoice[] } {
  const outcomes: RowOutcome[] = [];
  const invoices: PlannedInvoice[] = [];
  const seen = new Set<string>();

  rows.forEach((r, index) => {
    const row = index + 1;
    const invoiceNumber = (r.invoiceNumber ?? '').trim();
    const skip = (reason: string) => outcomes.push({ row, invoiceNumber, action: 'skip', reason });

    if (!invoiceNumber) return skip('No invoice number');
    if (invoiceNumber.length > 50) return skip('Invoice number is too long');
    const customerName = (r.customer ?? '').trim().replace(/\s+/g, ' ');
    if (!customerName) return skip('No customer');
    if (!isDate(r.issueDate)) return skip('Invoice date is missing or not a date');
    if (r.dueDate && !isDate(r.dueDate)) return skip('Due date is not a date');
    if (r.paymentDate && !isDate(r.paymentDate)) return skip('Payment date is not a date');
    if (!isPence(r.total)) return skip('Total is missing');
    if (r.total <= 0) return skip('Credit notes and zero-value invoices are not imported');
    if (!isPence(r.openBalance) || r.openBalance < 0 || r.openBalance > r.total) {
      return skip('Open balance must be between 0 and the total');
    }
    if (existingNumbers.has(invoiceNumber)) return skip('Already in LedgerLite');
    if (seen.has(invoiceNumber)) return skip('Appears twice in this file');

    const warnings: string[] = [];
    let subtotal: number;
    let taxAmount: number;
    if (isPence(r.subtotal) && isPence(r.taxAmount)) {
      if (r.subtotal + r.taxAmount !== r.total) return skip('Net + VAT does not add up to the total');
      subtotal = r.subtotal; taxAmount = r.taxAmount;
    } else if (isPence(r.taxAmount)) {
      subtotal = r.total - r.taxAmount; taxAmount = r.taxAmount;
    } else if (isPence(r.subtotal)) {
      subtotal = r.subtotal; taxAmount = r.total - r.subtotal;
    } else {
      subtotal = r.total; taxAmount = 0;
      warnings.push('No VAT in the file: imported with VAT £0.00');
    }
    if (subtotal < 0 || taxAmount < 0) return skip('Net and VAT must not be negative');

    const amountPaid = r.total - r.openBalance;
    const status = r.openBalance === 0 ? 'paid' : amountPaid === 0 ? 'sent' : 'partial';
    if (amountPaid > 0 && !r.paymentDate) warnings.push('No payment date: payment recorded on the invoice date');

    const key = customerKey(customerName);
    seen.add(invoiceNumber);
    invoices.push({
      invoiceNumber, customerKey: key, customerName,
      issueDate: r.issueDate,
      dueDate: r.dueDate || r.issueDate,
      subtotal, taxAmount, total: r.total, amountPaid, status,
      taxRate: subtotal > 0 ? Math.round((taxAmount / subtotal) * 10_000) / 10_000 : 0,
      description: (r.memo ?? '').trim().slice(0, 500) || 'Imported from QuickBooks',
      paymentDate: r.paymentDate || r.issueDate,
    });
    outcomes.push({
      row, invoiceNumber, action: 'create', status,
      customer: customerName, newCustomer: !existingCustomers.has(key), warnings,
    });
  });

  return { outcomes, invoices };
}

/**
 * The numbering to continue with after importing, e.g. "1043" → no prefix, next 1044, or
 * "INV-0043" → prefix "INV", next 44. Null when the numbers don't follow one pattern.
 */
export function suggestNumbering(numbers: string[]): { prefix: string; next: number } | null {
  const parsed = numbers
    .map(n => /^(.*?)[-\s]?(\d+)$/.exec(n.trim()))
    .filter((m): m is RegExpExecArray => !!m)
    .map(m => ({ prefix: m[1], seq: Number(m[2]) }));
  if (!parsed.length) return null;
  const prefixes = new Set(parsed.map(p => p.prefix));
  if (prefixes.size !== 1) return null;
  return { prefix: parsed[0].prefix, next: Math.max(...parsed.map(p => p.seq)) + 1 };
}
