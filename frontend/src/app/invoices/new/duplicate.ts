import { addDays, daysBetween } from '@/lib/dates';

/** The parts of an invoice (as GET /api/v1/invoices/:id returns it) a duplicate copies */
export type SourceInvoice = {
  id: string; invoice_number: string; client_id: string;
  issue_date: string; due_date: string; notes: string | null;
  items: Array<{ description: string; quantity: number; unit_price: number; tax_rate: number }>;
};

// The rates a new invoice line may take (the API refuses others; QuickBooks imports can have any)
const VAT_RATES = [0, 0.05, 0.2];

// What a QuickBooks import calls its one line when the export had no memo (services/invoiceImport.ts)
const IMPORT_PLACEHOLDER = 'Imported from QuickBooks';

/**
 * A new draft from an existing invoice: same client, lines (prices in pence) and notes, issued on
 * `today` and due after the same number of days as the original. `warnings` lists what had to
 * change and needs checking before it's saved.
 */
export function duplicateInvoice(source: SourceInvoice, today: string) {
  const term = Math.max(0, daysBetween(source.issue_date, source.due_date));
  let vatReset = false;
  let placeholder = false;
  const items = source.items.map(i => {
    const ok = VAT_RATES.includes(i.tax_rate);
    if (!ok) vatReset = true;
    // A line called 'Imported from QuickBooks' describes the import, not the work: leave it to be written
    const isPlaceholder = i.description.trim() === IMPORT_PLACEHOLDER;
    if (isPlaceholder) placeholder = true;
    return {
      description: isPlaceholder ? '' : i.description,
      quantity: i.quantity, unit_price: i.unit_price, tax_rate: ok ? i.tax_rate : 0.2,
    };
  });
  const warnings = [
    ...(vatReset ? ['Some lines had a VAT rate new invoices can’t use, so they’re set to 20%: check them.'] : []),
    ...(placeholder ? ['The original line had no description (only “Imported from QuickBooks”): describe the work.'] : []),
  ];
  return {
    initial: {
      client_id: source.client_id,
      issue_date: today,
      due_date: addDays(today, term),
      notes: source.notes ?? '',
      items,
    },
    warnings,
  };
}
