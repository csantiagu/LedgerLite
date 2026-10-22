import { IMPORTED_PAYMENT_REFERENCE } from './invoiceImport';
import { checkOpen } from './periods';

export type PaymentWrite =
  | { ok: true; id: string; status: string }
  | { ok: false; status: 404 | 409 | 422 | 423; error: string };

/**
 * Records a payment only while the invoice or bill is still open with enough balance.
 * The insert and the balance update are one D1 batch, so two requests can't both pass
 * a check against the same amount_paid.
 */
export async function recordDocumentPayment(
  db: D1Database,
  kind: 'invoice' | 'bill',
  targetId: string,
  payment: {
    amount: number;
    payment_date: string;
    method: string | null;
    reference: string | null;
    notes: string | null;
    userId: string;
  },
  /** Audit rows for the new payment, written in the same batch. Make them conditional on the
   *  payment row existing (see `paymentExistsSql`) since the insert writes nothing when it fails its check. */
  audit?: (paymentId: string) => D1PreparedStatement[],
): Promise<PaymentWrite> {
  const invoice = kind === 'invoice';
  const parent = invoice ? 'invoices' : 'bills';
  const payments = invoice ? 'payments_received' : 'payments_made';
  const fk = invoice ? 'invoice_id' : 'bill_id';
  const open = invoice ? `'sent','partial','overdue'` : `'pending','partial'`;
  const partial = invoice
    ? `CASE WHEN kind = 'invoice' AND due_date < date('now') THEN 'overdue' ELSE 'partial' END`
    : `'partial'`;

  const existing = await db.prepare(
    `SELECT status FROM ${parent} WHERE id = ?`
  ).bind(targetId).first<{ status: string }>();
  if (!existing) return { ok: false, status: 404, error: 'Not found' };
  if (existing.status === 'void') {
    return { ok: false, status: 422, error: invoice ? 'A void invoice cannot receive payments' : 'Void bill cannot receive payments' };
  }
  const allowed = invoice ? ['sent', 'partial', 'overdue'] : ['pending', 'partial'];
  if (!allowed.includes(existing.status)) {
    return { ok: false, status: 422, error: `${invoice ? 'Invoice' : 'Bill'} cannot receive payments in current status` };
  }

  const locked = await checkOpen(db, payment.payment_date);
  if (locked) return locked;

  const id = crypto.randomUUID().replace(/-/g, '');
  let inserted;
  try {
    [inserted] = await db.batch([
      db.prepare(`
        INSERT INTO ${payments} (id, ${fk}, amount, payment_date, method, reference, notes, created_by)
        VALUES (?, ?, (
          SELECT ? FROM ${parent}
          WHERE id = ? AND status IN (${open}) AND total - amount_paid >= ?
        ), ?, ?, ?, ?, ?)
      `).bind(
        id, targetId, payment.amount, targetId, payment.amount,
        payment.payment_date, payment.method, payment.reference, payment.notes, payment.userId,
      ),
      db.prepare(`
        UPDATE ${parent} SET
          amount_paid = amount_paid + ?,
          status = CASE WHEN amount_paid + ? >= total THEN 'paid' ELSE ${partial} END,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND EXISTS (SELECT 1 FROM ${payments} WHERE id = ?)
      `).bind(payment.amount, payment.amount, targetId, id),
      ...(audit?.(id) ?? []),
    ]);
  } catch (err) {
    const msg = String(err);
    if (msg.includes('NOT NULL constraint failed')) {
      return { ok: false, status: 409, error: 'Payment exceeds the outstanding balance' };
    }
    throw err;
  }
  if (!inserted?.meta.changes) {
    return { ok: false, status: 409, error: 'Payment exceeds the outstanding balance' };
  }

  const updated = await db.prepare(`SELECT status FROM ${parent} WHERE id = ?`)
    .bind(targetId).first<{ status: string }>();
  return { ok: true, id, status: updated?.status ?? 'partial' };
}

/** Condition for `auditStatement`'s onlyIf: the payment row exists. */
export const paymentExistsSql = (kind: 'invoice' | 'bill', paymentId: string) => ({
  sql: `EXISTS (SELECT 1 FROM ${kind === 'invoice' ? 'payments_received' : 'payments_made'} WHERE id = ?)`,
  binds: [paymentId],
});

/** Why a payment must not be deleted, or null when it is safe. Bank-posted payments stay until the line is undone. */
export async function paymentDeleteBlock(
  db: D1Database,
  kind: 'invoice' | 'bill',
  paymentId: string,
): Promise<string | null> {
  const tied = await db.prepare(
    `SELECT 1 AS n FROM transaction_matches WHERE payment_id = ? AND status = 'posted'`
  ).bind(paymentId).first();
  if (tied) {
    return 'This payment is tied to a bank line. Undo that line in Transactions instead of deleting it.';
  }
  if (kind === 'invoice') {
    const linked = await db.prepare(`
      SELECT 1 AS n FROM payments_received p
      WHERE p.id = ? AND p.reference = ?
        AND EXISTS (
          SELECT 1 FROM transaction_matches tm
          WHERE tm.invoice_id = p.invoice_id AND tm.kind = 'link' AND tm.status = 'posted'
        )
    `).bind(paymentId, IMPORTED_PAYMENT_REFERENCE).first();
    if (linked) {
      return 'This payment is linked to a bank line. Unlink it in Transactions before deleting it.';
    }
  }
  return null;
}

export type PaymentDelete =
  | { ok: true; amount: number; before: { amount_paid: number; status: string }; after: { amount_paid: number; status: string } }
  | { ok: false; status: 404 | 409 | 423; error: string };

/**
 * Deletes a payment and takes it off the invoice or bill in one D1 batch. The balance update
 * runs first and only while the payment still exists, so two requests deleting the same payment
 * can't both subtract it. Status is worked out from the stored row, not a value read earlier.
 */
export async function deleteDocumentPayment(
  db: D1Database,
  kind: 'invoice' | 'bill',
  targetId: string,
  paymentId: string,
  /** Audit rows, run first in the batch: make them conditional on the payment still existing
   *  (`paymentExistsSql`), so only the request that removes it records it */
  audit?: (amount: number, before: { amount_paid: number; status: string }) => D1PreparedStatement[],
): Promise<PaymentDelete> {
  const invoice = kind === 'invoice';
  const parent = invoice ? 'invoices' : 'bills';
  const payments = invoice ? 'payments_received' : 'payments_made';
  const fk = invoice ? 'invoice_id' : 'bill_id';
  // A past-due invoice reopens as overdue; bills have no overdue status
  const unpaid = invoice
    ? `WHEN kind = 'invoice' AND due_date < date('now') THEN 'overdue' WHEN amount_paid - ? > 0 THEN 'partial' ELSE 'sent'`
    : `WHEN amount_paid - ? > 0 THEN 'partial' ELSE 'pending'`;

  const payment = await db.prepare(`SELECT amount, payment_date FROM ${payments} WHERE id = ? AND ${fk} = ?`)
    .bind(paymentId, targetId).first<{ amount: number; payment_date: string }>();
  if (!payment) return { ok: false, status: 404, error: 'Payment not found' };
  const locked = await checkOpen(db, payment.payment_date);
  if (locked) return locked;
  const blocked = await paymentDeleteBlock(db, kind, paymentId);
  if (blocked) return { ok: false, status: 409, error: blocked };
  const before = await db.prepare(`SELECT amount_paid, status FROM ${parent} WHERE id = ?`)
    .bind(targetId).first<{ amount_paid: number; status: string }>();
  if (!before) return { ok: false, status: 404, error: `${invoice ? 'Invoice' : 'Bill'} not found` };

  const auditRows = audit?.(payment.amount, before) ?? [];
  const results = await db.batch([
    ...auditRows,
    db.prepare(`
      UPDATE ${parent} SET
        amount_paid = MAX(0, amount_paid - ?),
        status = CASE WHEN status = 'void' THEN 'void'
                      WHEN amount_paid - ? >= total THEN 'paid'
                      ${unpaid} END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND EXISTS (SELECT 1 FROM ${payments} WHERE id = ? AND ${fk} = ?)
    `).bind(payment.amount, payment.amount, payment.amount, targetId, paymentId, targetId),
    db.prepare(`DELETE FROM ${payments} WHERE id = ? AND ${fk} = ?`).bind(paymentId, targetId),
  ]);
  const updated = results[auditRows.length];
  if (!updated?.meta.changes) return { ok: false, status: 409, error: 'This payment was already removed' };

  const after = await db.prepare(`SELECT amount_paid, status FROM ${parent} WHERE id = ?`)
    .bind(targetId).first<{ amount_paid: number; status: string }>();
  return { ok: true, amount: payment.amount, before, after: after ?? before };
}
