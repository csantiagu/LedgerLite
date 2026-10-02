import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import type { AuthUser } from '../types';
import { requireRole } from '../middleware/rbac';
import { writeAudit } from '../middleware/audit';

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

  const txn = await c.env.DB.prepare(
    'SELECT id, amount, is_reconciled FROM transactions WHERE id = ?'
  ).bind(transactionId).first<{ id: string; amount: number; is_reconciled: number }>();
  if (!txn) return c.json({ error: 'Transaction not found' }, 404);
  if (txn.is_reconciled) return c.json({ error: 'Transaction is already reconciled' }, 409);

  const existing = await c.env.DB.prepare(`
    SELECT id, status FROM transaction_matches
    WHERE transaction_id = ? AND (invoice_id = ? OR bill_id = ?)
  `).bind(transactionId, targetId, targetId).first<{ id: string; status: string }>();

  if (existing) {
    if (existing.status === 'posted') return c.json({ error: 'Already posted' }, 409);
    await c.env.DB.prepare(
      'UPDATE transaction_matches SET status = ?, allocated_amount = ? WHERE id = ?'
    ).bind('pending', allocatedAmount, existing.id).run();
    return c.json({ id: existing.id, promoted: true });
  }

  const id = crypto.randomUUID();
  await c.env.DB.prepare(`
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
  const parsed = z.object({ matchIds: z.array(z.string()).min(1) }).safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const matches = await Promise.all(
    parsed.data.matchIds.map(id =>
      c.env.DB.prepare(`
        SELECT tm.*, t.bank_account_id, t.date, t.amount, t.expense_category_id
        FROM transaction_matches tm JOIN transactions t ON tm.transaction_id = t.id
        WHERE tm.id = ?
      `).bind(id).first<Record<string, unknown>>()
    )
  );
  if (matches.some(m => !m)) return c.json({ error: 'One or more match IDs not found' }, 404);
  if (matches.some(m => m!.status === 'posted')) return c.json({ error: 'Some matches are already posted' }, 409);

  // Require category on expense transactions before posting
  const missingCategory = matches.some(m => (m!.amount as number) < 0 && !m!.expense_category_id);
  if (missingCategory) return c.json({ error: 'Select a category on the transaction before posting' }, 422);

  const invoiceIds = [...new Set(matches.map(m => m!.invoice_id as string | null).filter(Boolean))] as string[];
  const billIds    = [...new Set(matches.map(m => m!.bill_id as string | null).filter(Boolean))] as string[];

  if (invoiceIds.length + billIds.length !== 1) {
    return c.json({ error: 'All matches in one post must reference the same invoice or bill' }, 400);
  }

  const totalAllocated = matches.reduce((sum, m) => sum + (m!.allocated_amount as number), 0);
  const paymentDate    = (matches.map(m => m!.date as string).sort().at(-1))!;
  const userId         = c.get('user').id;
  const paymentId      = crypto.randomUUID();

  // Resolve category IDs by exact name for auto-categorisation
  const debtorsCategory = await c.env.DB.prepare(
    `SELECT id FROM expense_categories WHERE LOWER(name) = 'debtors control account' LIMIT 1`
  ).first<{ id: string }>();

  let billCategoryId: string | null = null;
  if (billIds.length === 1) {
    // Use primary expense category from the bill's line items (first non-null)
    const billCat = await c.env.DB.prepare(
      `SELECT expense_category_id FROM bill_items
       WHERE bill_id = ? AND expense_category_id IS NOT NULL
       ORDER BY rowid ASC LIMIT 1`
    ).bind(billIds[0]).first<{ expense_category_id: string }>();
    billCategoryId = billCat?.expense_category_id ?? null;
  }

  if (invoiceIds.length === 1) {
    await c.env.DB.prepare(`
      INSERT INTO payments_received (id, invoice_id, amount, payment_date, method, created_by)
      VALUES (?, ?, ?, ?, 'bank_transfer', ?)
    `).bind(paymentId, invoiceIds[0], totalAllocated, paymentDate, userId).run();

    await c.env.DB.prepare(`
      UPDATE invoices SET
        amount_paid = amount_paid + ?,
        status = CASE
          WHEN amount_paid + ? >= total THEN 'paid'
          ELSE 'partial'
        END,
        updated_at = datetime('now')
      WHERE id = ?
    `).bind(totalAllocated, totalAllocated, invoiceIds[0]).run();
  } else {
    await c.env.DB.prepare(`
      INSERT INTO payments_made (id, bill_id, amount, payment_date, method, created_by)
      VALUES (?, ?, ?, ?, 'bank_transfer', ?)
    `).bind(paymentId, billIds[0], totalAllocated, paymentDate, userId).run();

    await c.env.DB.prepare(`
      UPDATE bills SET
        amount_paid = amount_paid + ?,
        status = CASE
          WHEN amount_paid + ? >= total THEN 'paid'
          ELSE 'partial'
        END,
        updated_at = datetime('now')
      WHERE id = ?
    `).bind(totalAllocated, totalAllocated, billIds[0]).run();
  }

  for (const m of matches) {
    await c.env.DB.prepare(`
      UPDATE transaction_matches
      SET status = 'posted', posted_by = ?, posted_at = datetime('now'), payment_id = ?
      WHERE id = ?
    `).bind(userId, paymentId, m!.id).run();

    // Auto-categorise: invoices → Debtors Control Account; bills → bill's expense category
    const autoCategoryId = invoiceIds.length === 1
      ? (debtorsCategory?.id ?? null)
      : billCategoryId;

    await c.env.DB.prepare(
      `UPDATE transactions
       SET is_reconciled = 1,
           expense_category_id = COALESCE(expense_category_id, ?),
           updated_at = datetime('now')
       WHERE id = ?`
    ).bind(autoCategoryId, m!.transaction_id).run();
  }

  await writeAudit(c.env, {
    userId,
    action: 'payment.created',
    resourceType: invoiceIds.length ? 'invoice' : 'bill',
    resourceId:   invoiceIds[0] ?? billIds[0],
    newValues: { paymentId, totalAllocated, matchCount: matches.length },
    ipAddress: c.req.header('CF-Connecting-IP'),
    userAgent: c.req.header('User-Agent'),
  });

  return c.json({ paymentId, totalAllocated, matchCount: matches.length });
});

export { router as transactionMatchRoutes };
