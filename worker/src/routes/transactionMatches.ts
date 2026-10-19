import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import type { AuthUser } from '../types';
import { requireRole } from '../middleware/rbac';
import { writeAudit } from '../middleware/audit';
import { checkAllocation } from '../services/matchAllocation';
import {
  CLEAR_AUTO_CATEGORY_SQL, debtorsControlCategory, FILL_CATEGORY_SQL, markPosted, postPaymentMatches,
} from '../services/bankReview';
import { IMPORTED_PAYMENT_REFERENCE } from '../services/invoiceImport';

const router = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();

// Money already recorded on an imported invoice ('Imported from QuickBooks' payments) that no bank
// line has been linked to yet. `invoice` is SQL for the invoice id: '?' (binds: id,
// IMPORTED_PAYMENT_REFERENCE, id) or a column such as 'i.id' (binds: IMPORTED_PAYMENT_REFERENCE).
export const unlinkedImportedSql = (invoice: '?' | 'i.id') => `(
  (SELECT COALESCE(SUM(pr.amount), 0) FROM payments_received pr
    WHERE pr.invoice_id = ${invoice} AND pr.method = 'other' AND pr.reference = ?)
  - (SELECT COALESCE(SUM(lm.allocated_amount), 0) FROM transaction_matches lm
    WHERE lm.invoice_id = ${invoice} AND lm.kind = 'link'))`;

// How much of a bank line is already allocated to invoices/bills. Binds: transaction id.
const TXN_ALLOCATED_SQL = `(SELECT COALESCE(SUM(am.allocated_amount), 0) FROM transaction_matches am
  WHERE am.transaction_id = ? AND am.status IN ('pending','posted'))`;

router.post('/', requireRole('owner'), async (c) => {
  const body   = await c.req.json().catch(() => null);
  const parsed = z.object({
    transactionId:   z.string(),
    type:            z.enum(['invoice', 'bill']),
    targetId:        z.string(),
    allocatedAmount: z.number().int().positive(),
  }).safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const { transactionId, type, targetId, allocatedAmount } = parsed.data;
  const db = c.env.DB;

  const txn = await db.prepare(
    'SELECT id, amount, is_reconciled FROM transactions WHERE id = ?'
  ).bind(transactionId).first<{ id: string; amount: number; is_reconciled: number }>();
  if (!txn) return c.json({ error: 'Transaction not found' }, 404);
  if (txn.is_reconciled) return c.json({ error: 'Transaction is already reconciled' }, 409);

  const target = await db.prepare(
    type === 'invoice'
      ? 'SELECT status, total - amount_paid AS outstanding FROM invoices WHERE id = ?'
      : 'SELECT status, total - amount_paid AS outstanding FROM bills WHERE id = ?'
  ).bind(targetId).first<{ status: string; outstanding: number }>();
  if (!target) return c.json({ error: `${type === 'invoice' ? 'Invoice' : 'Bill'} not found` }, 404);

  const targetCol = type === 'invoice' ? 'invoice_id' : 'bill_id';
  const existing = await db.prepare(
    `SELECT id, status FROM transaction_matches WHERE transaction_id = ? AND ${targetCol} = ?`
  ).bind(transactionId, targetId).first<{ id: string; status: string }>();
  if (existing?.status === 'posted') return c.json({ error: 'Already posted' }, 409);

  const others = await db.prepare(`
    SELECT
      (SELECT COALESCE(SUM(allocated_amount), 0) FROM transaction_matches
        WHERE transaction_id = ? AND status IN ('pending','posted') AND id != ?) AS other_txn,
      (SELECT COALESCE(SUM(allocated_amount), 0) FROM transaction_matches
        WHERE ${targetCol} = ? AND status = 'pending' AND transaction_id != ?) AS other_target
  `).bind(transactionId, existing?.id ?? '', targetId, transactionId)
    .first<{ other_txn: number; other_target: number }>();

  const error = checkAllocation({
    type,
    txnAmount: txn.amount,
    allocatedAmount,
    otherTxnAllocations: others?.other_txn ?? 0,
    targetStatus: target.status,
    targetOutstanding: target.outstanding,
    otherPendingOnTarget: others?.other_target ?? 0,
  });
  if (error) return c.json({ error }, 422);

  if (existing) {
    await db.prepare(
      `UPDATE transaction_matches SET status = 'pending', allocated_amount = ? WHERE id = ?`
    ).bind(allocatedAmount, existing.id).run();
    return c.json({ id: existing.id, promoted: true });
  }

  const id = crypto.randomUUID();
  await db.prepare(`
    INSERT INTO transaction_matches
      (id, transaction_id, match_type, invoice_id, bill_id, allocated_amount, status)
    VALUES (?, ?, ?, ?, ?, ?, 'pending')
  `).bind(
    id, transactionId, type,
    type === 'invoice' ? targetId : null,
    type === 'bill'    ? targetId : null,
    allocatedAmount
  ).run();

  return c.json({ id }, 201);
});

router.delete('/:id', requireRole('owner'), async (c) => {
  const match = await c.env.DB
    .prepare('SELECT status FROM transaction_matches WHERE id = ?')
    .bind(c.req.param('id')).first<{ status: string }>();
  if (!match) return c.json({ error: 'Not found' }, 404);
  if (match.status === 'posted') return c.json({ error: 'Cannot remove a posted match' }, 409);
  await c.env.DB.prepare('DELETE FROM transaction_matches WHERE id = ?')
    .bind(c.req.param('id')).run();
  return c.json({ ok: true });
});

router.post('/post', requireRole('owner'), async (c) => {
  const body   = await c.req.json().catch(() => null);
  const parsed = z.object({ matchIds: z.array(z.string()).min(1).max(50) }).safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const db = c.env.DB;
  const userId = c.get('user').id;
  const res = await postPaymentMatches(db, userId, [...new Set(parsed.data.matchIds)]);
  if (!res.ok) return c.json({ error: res.error }, res.status);
  await db.batch(res.transactionIds.map(id => markPosted(db, userId, id)));

  await writeAudit(c.env, {
    userId,
    action: 'payment.created',
    resourceType: res.type,
    resourceId:   res.targetId,
    newValues: { paymentId: res.paymentId, totalAllocated: res.total, matchCount: parsed.data.matchIds.length },
    ipAddress: c.req.header('CF-Connecting-IP'),
    userAgent: c.req.header('User-Agent'),
  });

  return c.json({ paymentId: res.paymentId, totalAllocated: res.total, matchCount: parsed.data.matchIds.length });
});

// POST /link — explain a bank receipt with money already recorded on an invoice imported from
// QuickBooks. Posted straight away: it creates no payment and leaves amount_paid alone, so the
// money is never counted twice. A bank line can be linked to several invoices until it's used up.
router.post('/link', requireRole('owner'), async (c) => {
  const body   = await c.req.json().catch(() => null);
  const parsed = z.object({ transactionId: z.string(), invoiceId: z.string() }).safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const { transactionId, invoiceId } = parsed.data;
  const db = c.env.DB;

  const txn = await db.prepare(
    `SELECT amount, is_reconciled, ${TXN_ALLOCATED_SQL} AS allocated FROM transactions WHERE id = ?`
  ).bind(transactionId, transactionId).first<{ amount: number; is_reconciled: number; allocated: number }>();
  if (!txn) return c.json({ error: 'Transaction not found' }, 404);
  if (txn.amount <= 0) return c.json({ error: 'Only money coming in can be linked to a sales invoice' }, 422);
  if (txn.is_reconciled) return c.json({ error: 'Transaction is already reconciled' }, 409);

  const invoice = await db.prepare(
    `SELECT source, status, ${unlinkedImportedSql('?')} AS unlinked FROM invoices WHERE id = ?`
  ).bind(invoiceId, IMPORTED_PAYMENT_REFERENCE, invoiceId, invoiceId)
    .first<{ source: string; status: string; unlinked: number }>();
  if (!invoice) return c.json({ error: 'Invoice not found' }, 404);
  if (invoice.source !== 'quickbooks') {
    return c.json({ error: 'Only invoices imported from QuickBooks have a payment to link to' }, 422);
  }
  if (invoice.status === 'void') return c.json({ error: 'This invoice is void' }, 422);
  if (invoice.unlinked <= 0) {
    return c.json({ error: 'The QuickBooks payment on this invoice is already linked to bank lines' }, 409);
  }

  const already = await db.prepare(
    'SELECT 1 FROM transaction_matches WHERE transaction_id = ? AND invoice_id = ?'
  ).bind(transactionId, invoiceId).first();
  if (already) return c.json({ error: 'This bank line is already matched to that invoice' }, 409);

  const amount = Math.min(txn.amount - txn.allocated, invoice.unlinked);
  if (amount <= 0) return c.json({ error: 'This bank line is already fully allocated' }, 409);

  const userId = c.get('user').id;
  const category = await debtorsControlCategory(db);
  const id = crypto.randomUUID();
  // The insert re-checks both limits, so two links racing for the same money can't both land;
  // the transaction update only runs if the insert did.
  const [inserted] = await db.batch([
    db.prepare(`
      INSERT INTO transaction_matches
        (id, transaction_id, match_type, invoice_id, allocated_amount, status, kind, posted_by, posted_at)
      SELECT ?, ?, 'invoice', ?, ?, 'posted', 'link', ?, datetime('now')
      WHERE ${unlinkedImportedSql('?')} >= ?
        AND (SELECT amount FROM transactions WHERE id = ?) - ${TXN_ALLOCATED_SQL} >= ?
    `).bind(id, transactionId, invoiceId, amount, userId,
            invoiceId, IMPORTED_PAYMENT_REFERENCE, invoiceId, amount,
            transactionId, transactionId, amount),
    db.prepare(`
      UPDATE transactions SET
        is_reconciled = CASE WHEN ${TXN_ALLOCATED_SQL} >= amount THEN 1 ELSE 0 END,
        reviewed_at = CASE WHEN ${TXN_ALLOCATED_SQL} >= amount THEN datetime('now') END,
        reviewed_by = CASE WHEN ${TXN_ALLOCATED_SQL} >= amount THEN ? END,
        ${FILL_CATEGORY_SQL},
        updated_at = datetime('now')
      WHERE id = ? AND EXISTS (SELECT 1 FROM transaction_matches WHERE id = ?)
    `).bind(transactionId, transactionId, transactionId, userId,
            category?.id ?? null, category?.id ?? null, transactionId, id),
    // Once the line is fully linked it's posted, so suggestions for it are dropped
    db.prepare(`
      DELETE FROM transaction_matches WHERE transaction_id = ? AND status = 'suggested'
        AND (SELECT is_reconciled FROM transactions WHERE id = ?) = 1
    `).bind(transactionId, transactionId),
  ]);
  if (!inserted.meta.changes) {
    return c.json({ error: 'The invoice or bank line changed meanwhile; refresh and try again' }, 409);
  }

  await writeAudit(c.env, {
    userId,
    action: 'transaction.linked',
    resourceType: 'invoice',
    resourceId: invoiceId,
    newValues: { transactionId, matchId: id, allocatedAmount: amount },
    ipAddress: c.req.header('CF-Connecting-IP'),
    userAgent: c.req.header('User-Agent'),
  });

  return c.json({ id, allocatedAmount: amount, reconciled: txn.allocated + amount >= txn.amount }, 201);
});

// POST /unlink — undo every link on a bank line. Nothing about the invoices changes.
router.post('/unlink', requireRole('owner'), async (c) => {
  const body   = await c.req.json().catch(() => null);
  const parsed = z.object({ transactionId: z.string() }).safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const { transactionId } = parsed.data;
  const db = c.env.DB;

  const { results: links } = await db.prepare(
    `SELECT id, invoice_id FROM transaction_matches WHERE transaction_id = ? AND kind = 'link'`
  ).bind(transactionId).all<{ id: string; invoice_id: string }>();
  if (!links.length) return c.json({ error: 'This bank line has no links' }, 404);

  await db.batch([
    db.prepare(`DELETE FROM transaction_matches WHERE transaction_id = ? AND kind = 'link'`).bind(transactionId),
    // Only reopen the line if no real payment is posted against it; the category goes only if
    // linking filled it in
    db.prepare(`
      UPDATE transactions SET
        is_reconciled = 0, reviewed_at = NULL, reviewed_by = NULL,
        ${CLEAR_AUTO_CATEGORY_SQL},
        updated_at = datetime('now')
      WHERE id = ? AND NOT EXISTS (
        SELECT 1 FROM transaction_matches WHERE transaction_id = ? AND status = 'posted')
    `).bind(transactionId, transactionId),
  ]);

  await writeAudit(c.env, {
    userId: c.get('user').id,
    action: 'transaction.unlinked',
    resourceType: 'transaction',
    resourceId: transactionId,
    oldValues: { links: links.map(l => ({ matchId: l.id, invoiceId: l.invoice_id })) },
    ipAddress: c.req.header('CF-Connecting-IP'),
    userAgent: c.req.header('User-Agent'),
  });

  return c.json({ ok: true, removed: links.length });
});

export { router as transactionMatchRoutes };
