import type { D1Database } from '@cloudflare/workers-types';

export async function generateInvoiceNumber(db: D1Database): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `INV-${year}-`;

  const row = await db
    .prepare(
      `SELECT invoice_number FROM invoices
       WHERE invoice_number LIKE ?
       ORDER BY invoice_number DESC LIMIT 1`
    )
    .bind(`${prefix}%`)
    .first<{ invoice_number: string }>();

  const next = row ? parseInt(row.invoice_number.split('-').pop() ?? '0', 10) + 1 : 1;
  return `${prefix}${String(next).padStart(4, '0')}`;
}
