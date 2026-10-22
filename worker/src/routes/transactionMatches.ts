import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import type { AuthUser } from '../types';
import { requireRole } from '../middleware/rbac';
import { actorOf, auditStatement, type AuditActor } from '../middleware/audit';
import { checkAllocation } from '../services/matchAllocation';
import {
  CLEAR_AUTO_CATEGORY_SQL, debtorsControlCategory, FILL_CATEGORY_SQL, postMatchesAndReconcile,
} from '../services/bankReview';
import { IMPORTED_PAYMENT_REFERENCE } from '../services/invoiceImport';
import { linksAllowed } from '../services/migration';
import { checkOpen } from '../services/periods';

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
      ? `SELECT status, total - amount_paid AS outstanding, invoice_number AS label, kind = 'credit_note' AS refund
         FROM invoices WHERE id = ?`
      : `SELECT b.status, b.total - b.amount_paid AS outstanding, v.name || COALESCE(' ' || b.bill_number, '') AS label
         FROM bills b JOIN vendors v ON v.id = b.vendor_id WHERE b.id = ?`
  ).bind(targetId).first<{ status: string; outstanding: number; label: string; refund?: number }>();
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
    refund: !!target.refund,
  });
  if (error) return c.json({ error }, 422);

  const id = existing?.id ?? crypto.randomUUID();
  // The checks above, repeated inside the write: two matches racing for the same money (on the
  // bank line or the invoice/bill) can't both land. NULLs (line posted, target closed) fail them too.
  const [table, open] = type === 'invoice'
    ? ['invoices', `'sent','partial','overdue'`] : ['bills', `'pending','partial'`];
  const fits = {
    sql: `(SELECT ABS(amount) FROM transactions WHERE id = ? AND is_reconciled = 0)
            - (SELECT COALESCE(SUM(allocated_amount), 0) FROM transaction_matches
               WHERE transaction_id = ? AND status IN ('pending','posted') AND id != ?) >= ?
          AND (SELECT total - amount_paid FROM ${table} WHERE id = ? AND status IN (${open}))
            - (SELECT COALESCE(SUM(allocated_amount), 0) FROM transaction_matches
               WHERE ${targetCol} = ? AND status = 'pending' AND transaction_id != ?) >= ?
          AND ${existing
            ? `EXISTS (SELECT 1 FROM transaction_matches WHERE id = ? AND status != 'posted')`
            : `NOT EXISTS (SELECT 1 FROM transaction_matches WHERE transaction_id = ? AND ${targetCol} = ?)`}`,
    binds: [
      transactionId, transactionId, id, allocatedAmount,
      targetId, targetId, transactionId, allocatedAmount,
      ...(existing ? [id] : [transactionId, targetId]),
    ],
  };

  // The audit row goes first, under the same condition, so it's written exactly when the match is
  const [, written] = await db.batch([
    auditStatement(db, actorOf(c), {
      action: 'transaction.match_added', resourceType: 'transaction', resourceId: transactionId,
      oldValues: existing ? { matchId: id, status: existing.status } : undefined,
      newValues: { matchId: id, type, targetId, target: target.label, allocatedAmount, status: 'pending' },
      summary: `Matched to ${target.label}`,
    }, fits),
    existing
      ? db.prepare(
          `UPDATE transaction_matches SET status = 'pending', allocated_amount = ? WHERE id = ? AND ${fits.sql}`
        ).bind(allocatedAmount, id, ...fits.binds)
      : db.prepare(`
          INSERT INTO transaction_matches
            (id, transaction_id, match_type, invoice_id, bill_id, allocated_amount, status)
          SELECT ?, ?, ?, ?, ?, ?, 'pending' WHERE ${fits.sql}
        `).bind(
          id, transactionId, type,
          type === 'invoice' ? targetId : null,
          type === 'bill'    ? targetId : null,
          allocatedAmount, ...fits.binds,
        ),
  ]);
  if (!written!.meta.changes) {
    return c.json({ error: 'The bank line or the ' + type + ' changed meanwhile; refresh and try again' }, 409);
  }

  return existing ? c.json({ id, promoted: true }) : c.json({ id }, 201);
});

router.delete('/:id', requireRole('owner'), async (c) => {
  const db = c.env.DB;
  const matchId = c.req.param('id');
  const match = await db.prepare(`
    SELECT tm.status, tm.transaction_id, tm.match_type, tm.invoice_id, tm.bill_id, tm.allocated_amount,
           CASE tm.match_type WHEN 'invoice' THEN i.invoice_number
                              ELSE v.name || COALESCE(' ' || b.bill_number, '') END AS label
    FROM transaction_matches tm
    LEFT JOIN invoices i ON i.id = tm.invoice_id
    LEFT JOIN bills b ON b.id = tm.bill_id
    LEFT JOIN vendors v ON v.id = b.vendor_id
    WHERE tm.id = ?
  `).bind(matchId).first<{
    status: string; transaction_id: string; match_type: 'invoice' | 'bill';
    invoice_id: string | null; bill_id: string | null; allocated_amount: number; label: string | null;
  }>();
  if (!match) return c.json({ error: 'Not found' }, 404);
  if (match.status === 'posted') return c.json({ error: 'Cannot remove a posted match' }, 409);
  await db.batch([
    db.prepare('DELETE FROM transaction_matches WHERE id = ?').bind(matchId),
    // Turning down a suggestion isn't a change to the books; removing a match the owner made is
    ...(match.status === 'pending' ? [auditStatement(db, actorOf(c), {
      action: 'transaction.match_removed', resourceType: 'transaction', resourceId: match.transaction_id,
      oldValues: {
        matchId, type: match.match_type, targetId: match.invoice_id ?? match.bill_id,
        target: match.label, allocatedAmount: match.allocated_amount, status: match.status,
      },
      summary: `Removed match to ${match.label ?? `a ${match.match_type}`}`,
    })] : []),
  ]);
  return c.json({ ok: true });
});

router.post('/post', requireRole('owner'), async (c) => {
  const body   = await c.req.json().catch(() => null);
  const parsed = z.object({ matchIds: z.array(z.string()).min(1).max(50) }).safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const db = c.env.DB;
  const userId = c.get('user').id;
  const actor = actorOf(c);
  const res = await postMatchesAndReconcile(db, userId, [...new Set(parsed.data.matchIds)], r => [
    auditStatement(db, actor, {
      action: 'payment.created', resourceType: r.type, resourceId: r.targetId,
      newValues: { paymentId: r.paymentId, amount: r.total, transactionIds: r.transactionIds },
      summary: 'Payment recorded from the bank',
    }),
    ...r.transactionIds.map(transactionId => auditStatement(db, actor, {
      action: 'transaction.matched', resourceType: 'transaction', resourceId: transactionId,
      newValues: { paymentId: r.paymentId, type: r.type, targetId: r.targetId },
      summary: `Payment posted to the ${r.type}`,
    })),
  ]);
  if (!res.ok) return c.json({ error: res.error }, res.status);

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
  if (!await linksAllowed(db)) {
    return c.json({ error: 'The QuickBooks migration is marked complete, so bank lines can only be matched to open invoices' }, 422);
  }
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
            category?.id ?? null, category ? 0 : null, category?.id ?? null, transactionId, id),
    // Once the line is fully linked it's posted, so suggestions for it are dropped
    db.prepare(`
      DELETE FROM transaction_matches WHERE transaction_id = ? AND status = 'suggested'
        AND (SELECT is_reconciled FROM transactions WHERE id = ?) = 1
    `).bind(transactionId, transactionId),
    // Recorded on both the invoice and the bank line, and only if the link went in
    ...linkAudits(db, actorOf(c), 'transaction.linked', [{ matchId: id, invoiceId }], transactionId, amount,
      { sql: 'EXISTS (SELECT 1 FROM transaction_matches WHERE id = ?)', binds: [id] }),
  ]);
  if (!inserted.meta.changes) {
    return c.json({ error: 'The invoice or bank line changed meanwhile; refresh and try again' }, 409);
  }

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
    `SELECT id, invoice_id, allocated_amount FROM transaction_matches WHERE transaction_id = ? AND kind = 'link'`
  ).bind(transactionId).all<{ id: string; invoice_id: string; allocated_amount: number }>();
  if (!links.length) return c.json({ error: 'This bank line has no links' }, 404);
  const line = await db.prepare('SELECT date FROM transactions WHERE id = ?').bind(transactionId).first<{ date: string }>();
  const locked = await checkOpen(db, line?.date);
  if (locked) return c.json({ error: locked.error }, locked.status);

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
    ...linkAudits(db, actorOf(c), 'transaction.unlinked',
      links.map(l => ({ matchId: l.id, invoiceId: l.invoice_id, amount: l.allocated_amount })), transactionId),
  ]);

  return c.json({ ok: true, removed: links.length });
});

/** Audit rows for linking or unlinking: one on the bank line, one on each invoice. */
function linkAudits(
  db: D1Database, actor: AuditActor, action: 'transaction.linked' | 'transaction.unlinked',
  links: Array<{ matchId: string; invoiceId: string; amount?: number }>, transactionId: string, amount?: number,
  onlyIf?: { sql: string; binds: unknown[] },
): D1PreparedStatement[] {
  const linked = action === 'transaction.linked';
  const values = { links: links.map(l => ({ ...l, amount: l.amount ?? amount })) };
  return [
    auditStatement(db, actor, {
      action, resourceType: 'transaction', resourceId: transactionId,
      ...(linked ? { newValues: values } : { oldValues: values }),
      summary: linked ? 'Linked to an imported QuickBooks payment' : 'Unlinked from imported QuickBooks payments',
    }, onlyIf),
    ...links.map(l => auditStatement(db, actor, {
      action, resourceType: 'invoice', resourceId: l.invoiceId,
      ...(linked
        ? { newValues: { transactionId, matchId: l.matchId, amount: l.amount ?? amount } }
        : { oldValues: { transactionId, matchId: l.matchId, amount: l.amount } }),
      summary: linked ? 'Bank line linked to the imported payment' : 'Bank line unlinked from the imported payment',
    }, onlyIf)),
  ];
}

export { router as transactionMatchRoutes };
