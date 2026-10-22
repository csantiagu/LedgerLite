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

export type Series = 'invoice' | 'credit_note';

const SERIES = {
  invoice:     { prefix: 'invoice_prefix', seq: 'invoice_next_sequence' },
  credit_note: { prefix: 'credit_note_prefix', seq: 'credit_note_next_sequence' },
} as const;

/** A document number: INV-0042 / CN-0007, or the bare sequence (QuickBooks style) without a prefix. */
export function formatNumber(series: Series, prefix: string | null, seq: number): string {
  if (prefix) return `${prefix}-${String(seq).padStart(4, '0')}`;
  return series === 'credit_note' ? `CN${seq}` : String(seq);
}

/**
 * The number a series will give next, without taking it. The batch that saves the document takes it
 * with `numberStillNext` (a condition on every statement) and `takeNumber`, so a number is only used
 * up by a document that was saved: a refused or lost save leaves no gap in the series.
 */
export async function peekNumber(db: D1Database, series: Series): Promise<{ number: string; seq: number }> {
  const { prefix, seq } = SERIES[series];
  const row = await db.prepare(`SELECT ${prefix} AS prefix, ${seq} AS seq FROM company_settings WHERE id = 1`)
    .first<{ prefix: string | null; seq: number }>();
  const next = row?.seq ?? 1;
  return { number: formatNumber(series, row?.prefix ?? (series === 'credit_note' ? 'CN' : 'INV'), next), seq: next };
}

/** Condition for the save batch: nobody has taken this number meanwhile. */
export const numberStillNext = (series: Series, seq: number) => ({
  sql: `(SELECT ${SERIES[series].seq} FROM company_settings WHERE id = 1) = ?`,
  binds: [seq] as unknown[],
});

/** Moves the series on past `seq`, only if the document `docId` was saved earlier in the batch. */
export const takeNumber = (db: D1Database, series: Series, seq: number, docId: string) => db.prepare(`
  UPDATE company_settings SET ${SERIES[series].seq} = ${SERIES[series].seq} + 1
  WHERE id = 1 AND ${SERIES[series].seq} = ? AND EXISTS (SELECT 1 FROM invoices WHERE id = ?)
`).bind(seq, docId);
