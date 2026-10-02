import type { D1Database } from '@cloudflare/workers-types';

const INV_RE = /INV-\d{4}-\d{4}/i;

export async function autoSuggestMatches(
  db: D1Database,
  transactionIds: string[]
): Promise<{ suggested: number }> {
  let suggested = 0;

  for (const txnId of transactionIds) {
    const txn = await db
      .prepare('SELECT id, description, amount FROM transactions WHERE id = ?')
      .bind(txnId)
      .first<{ id: string; description: string; amount: number }>();
    if (!txn) continue;

    if (txn.amount > 0) {
      const invRef = txn.description.match(INV_RE)?.[0];
      let candidate: { id: string; outstanding: number } | null = null;

      if (invRef) {
        candidate = await db.prepare(`
          SELECT id, (total - amount_paid) as outstanding
          FROM invoices
          WHERE invoice_number = ? AND status IN ('sent','partial','overdue')
        `).bind(invRef.toUpperCase()).first() ?? null;
      }

      if (!candidate) {
        candidate = await db.prepare(`
          SELECT id, (total - amount_paid) as outstanding
          FROM invoices
          WHERE (total - amount_paid) = ?
            AND status IN ('sent','partial','overdue')
            AND id NOT IN (
              SELECT invoice_id FROM transaction_matches
              WHERE status = 'posted' AND invoice_id IS NOT NULL
            )
          LIMIT 1
        `).bind(txn.amount).first() ?? null;
      }

      if (candidate) {
        const exists = await db.prepare(`
          SELECT id FROM transaction_matches
          WHERE transaction_id = ? AND invoice_id = ?
        `).bind(txnId, candidate.id).first();

        if (!exists) {
          await db.prepare(`
            INSERT INTO transaction_matches
              (transaction_id, match_type, invoice_id, allocated_amount, status)
            VALUES (?, 'invoice', ?, ?, 'suggested')
          `).bind(txnId, candidate.id, txn.amount).run();
          suggested++;
        }
      }

    } else if (txn.amount < 0) {
      const absAmount = Math.abs(txn.amount);

      const candidate = await db.prepare(`
        SELECT id, (total - amount_paid) as outstanding
        FROM bills
        WHERE (total - amount_paid) = ?
          AND status IN ('pending','partial')
          AND id NOT IN (
            SELECT bill_id FROM transaction_matches
            WHERE status = 'posted' AND bill_id IS NOT NULL
          )
        LIMIT 1
      `).bind(absAmount).first<{ id: string; outstanding: number }>() ?? null;

      if (candidate) {
        const exists = await db.prepare(`
          SELECT id FROM transaction_matches
          WHERE transaction_id = ? AND bill_id = ?
        `).bind(txnId, candidate.id).first();

        if (!exists) {
          await db.prepare(`
            INSERT INTO transaction_matches
              (transaction_id, match_type, bill_id, allocated_amount, status)
            VALUES (?, 'bill', ?, ?, 'suggested')
          `).bind(txnId, candidate.id, absAmount).run();
          suggested++;
        }
      }
    }
  }

  return { suggested };
}
