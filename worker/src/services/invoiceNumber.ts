import type { D1Database } from '@cloudflare/workers-types';

export async function generateInvoiceNumber(db: D1Database): Promise<string> {
  // Get company settings for prefix and sequence
  const settings = await db
    .prepare('SELECT invoice_prefix, invoice_next_sequence FROM company_settings WHERE id = 1')
    .first<{ invoice_prefix: string; invoice_next_sequence: number }>();

  const prefix = settings?.invoice_prefix ?? 'INV';
  const next = settings?.invoice_next_sequence ?? 1;

  // Increment sequence atomically
  await db
    .prepare('UPDATE company_settings SET invoice_next_sequence = invoice_next_sequence + 1 WHERE id = 1')
    .run();

  // An empty prefix gives plain numbers (1044), which is how QuickBooks numbers invoices
  return prefix ? `${prefix}-${String(next).padStart(4, '0')}` : String(next);
}

/** The next credit note number, e.g. CN-0001: its own sequence, so invoice numbers stay unbroken. */
export async function generateCreditNoteNumber(db: D1Database): Promise<string> {
  // Takes the number and moves the sequence on in one statement, so two credit notes can't share one
  const row = await db.prepare(`
    UPDATE company_settings SET credit_note_next_sequence = credit_note_next_sequence + 1 WHERE id = 1
    RETURNING credit_note_prefix AS prefix, credit_note_next_sequence - 1 AS seq
  `).first<{ prefix: string; seq: number }>();
  const prefix = row?.prefix ?? 'CN';
  const seq = row?.seq ?? 1;
  return prefix ? `${prefix}-${String(seq).padStart(4, '0')}` : `CN${seq}`;
}
