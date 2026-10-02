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

  return `${prefix}-${String(next).padStart(4, '0')}`;
}
