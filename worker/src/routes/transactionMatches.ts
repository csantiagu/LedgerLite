import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import type { AuthUser } from '../types';
import { requireRole } from '../middleware/rbac';
import { writeAudit } from '../middleware/audit';
import { checkAllocation, isOpenTarget, paymentIdFor, planPost, type PostCandidate } from '../services/matchAllocation';

const router = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();

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
  const matchIds = [...new Set(parsed.data.matchIds)];

  const { results: rows } = await db.prepare(`
    SELECT tm.id, tm.status, tm.invoice_id, tm.bill_id, tm.allocated_amount, tm.transaction_id,
           t.date, t.amount AS txn_amount, t.expense_category_id
    FROM transaction_matches tm JOIN transactions t ON tm.transaction_id = t.id
    WHERE tm.id IN (${matchIds.map(() => '?').join(',')})
  `).bind(...matchIds).all<PostCandidate & { id: string; transaction_id: string; date: string }>();
  if (rows.length !== matchIds.length) return c.json({ error: 'One or more match IDs not found' }, 404);

  const plan = planPost(rows);
  if (!plan.ok) return c.json({ error: plan.error }, plan.status);

  const target = await db.prepare(
    plan.type === 'invoice'
      ? 'SELECT status, total - amount_paid AS outstanding FROM invoices WHERE id = ?'
      : 'SELECT status, total - amount_paid AS outstanding FROM bills WHERE id = ?'
  ).bind(plan.targetId).first<{ status: string; outstanding: number }>();
  if (!target) return c.json({ error: 'Invoice or bill not found' }, 404);
  if (!isOpenTarget(plan.type, target.status)) {
    return c.json({ error: `This ${plan.type} is ${target.status} and cannot take payments` }, 409);
  }
  if (plan.total > target.outstanding) {
    return c.json({ error: `Total allocated exceeds the outstanding balance of the ${plan.type}` }, 422);
  }

  const userId      = c.get('user').id;
  const paymentDate = rows.map(r => r.date).sort().at(-1)!;
  const paymentId   = await paymentIdFor(matchIds);

  // Invoices → Debtors Control Account; bills → the bill's first line category
  const autoCategory = plan.type === 'invoice'
    ? await db.prepare(
        `SELECT id FROM expense_categories WHERE LOWER(name) = 'debtors control account' LIMIT 1`
      ).first<{ id: string }>()
    : await db.prepare(
        `SELECT expense_category_id AS id FROM bill_items
         WHERE bill_id = ? AND expense_category_id IS NOT NULL ORDER BY rowid ASC LIMIT 1`
      ).bind(plan.targetId).first<{ id: string }>();

  const [paymentTable, targetTable, targetCol, openStatuses] = plan.type === 'invoice'
    ? ['payments_received', 'invoices', 'invoice_id', `'sent','partial','overdue'`]
    : ['payments_made', 'bills', 'bill_id', `'pending','partial'`];
  // One D1 batch = one SQL transaction, and any failing statement rolls the whole batch back.
  // The payment insert is the guard: if the target is no longer open with enough balance it
  // inserts a NULL amount and fails NOT NULL; if these matches were already posted, the
  // deterministic paymentId fails the primary key. Either way nothing below it is applied.
  const statements: D1PreparedStatement[] = [
    db.prepare(`
      INSERT INTO ${paymentTable} (id, ${targetCol}, amount, payment_date, method, created_by)
      VALUES (?, ?, (
        SELECT ? FROM ${targetTable}
        WHERE id = ? AND status IN (${openStatuses}) AND total - amount_paid >= ?
      ), ?, 'bank_transfer', ?)
    `).bind(paymentId, plan.targetId, plan.total, plan.targetId, plan.total, paymentDate, userId),
    db.prepare(`
      UPDATE ${targetTable} SET
        amount_paid = amount_paid + ?,
        status = CASE WHEN amount_paid + ? >= total THEN 'paid' ELSE 'partial' END,
        updated_at = datetime('now')
      WHERE id = ?
    `).bind(plan.total, plan.total, plan.targetId),
  ];
  for (const r of rows) {
    statements.push(
      db.prepare(`
        UPDATE transaction_matches
        SET status = 'posted', posted_by = ?, posted_at = datetime('now'), payment_id = ?
        WHERE id = ?
      `).bind(userId, paymentId, r.id),
      db.prepare(`
        UPDATE transactions
        SET is_reconciled = 1,
            expense_category_id = COALESCE(expense_category_id, ?),
            updated_at = datetime('now')
        WHERE id = ?
      `).bind(autoCategory?.id ?? null, r.transaction_id),
    );
  }

  try {
    await db.batch(statements);
  } catch (err) {
    const msg = String(err);
    if (msg.includes('UNIQUE constraint failed')) {
      return c.json({ error: 'These matches have already been posted' }, 409);
    }
    if (msg.includes('NOT NULL constraint failed')) {
      return c.json({ error: `The ${plan.type} changed while posting; refresh and try again` }, 409);
    }
    throw err;
  }

  await writeAudit(c.env, {
    userId,
    action: 'payment.created',
    resourceType: plan.type,
    resourceId:   plan.targetId,
    newValues: { paymentId, totalAllocated: plan.total, matchCount: rows.length },
    ipAddress: c.req.header('CF-Connecting-IP'),
    userAgent: c.req.header('User-Agent'),
  });

  return c.json({ paymentId, totalAllocated: plan.total, matchCount: rows.length });
});

export { router as transactionMatchRoutes };
