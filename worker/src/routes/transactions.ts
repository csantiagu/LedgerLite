import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { writeAudit } from '../middleware/audit';
import type { Env } from '../types';

const router = new Hono<{ Bindings: Env }>();

const OwnerPatchSchema = z.object({
  expenseCategoryId: z.string().length(32).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
  isReconciled: z.boolean().optional(),
});

const AccountantPatchSchema = z.object({
  flagged: z.boolean().optional(),
  accountantNotes: z.string().max(1000).nullable().optional(),
});

const MatchSchema = z.object({
  type: z.enum(['invoice', 'bill']),
  targetId: z.string().length(32),
});

router.get('/', async (c) => {
  const from = c.req.query('from');
  const to = c.req.query('to');
  const reconciled = c.req.query('reconciled');
  const category = c.req.query('category');
  const flagged = c.req.query('flagged');

  const clauses: string[] = [];
  const binds: unknown[] = [];
  if (from) { clauses.push('t.date >= ?'); binds.push(from); }
  if (to) { clauses.push('t.date <= ?'); binds.push(to); }
  if (reconciled === '0' || reconciled === '1') { clauses.push('t.is_reconciled = ?'); binds.push(Number(reconciled)); }
  if (category) { clauses.push('t.expense_category_id = ?'); binds.push(category); }
  if (flagged === '0' || flagged === '1') { clauses.push('t.flagged = ?'); binds.push(Number(flagged)); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const rows = await c.env.DB.prepare(
    `SELECT t.*, ec.name as category_name
     FROM transactions t
     LEFT JOIN expense_categories ec ON ec.id = t.expense_category_id
     ${where}
     ORDER BY t.date DESC, t.created_at DESC`
  ).bind(...binds).all();
  return c.json(rows.results);
});

router.patch('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') return c.json({ error: 'Invalid JSON body' }, 400);

  const existing = await c.env.DB.prepare(
    `SELECT id, expense_category_id, notes, is_reconciled, flagged, accountant_notes
     FROM transactions WHERE id = ?`
  ).bind(id).first();
  if (!existing) return c.json({ error: 'Not found' }, 404);

  if (user.role === 'owner') {
    const parsed = OwnerPatchSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const data = parsed.data;
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (Object.hasOwn(data, 'expenseCategoryId')) { sets.push('expense_category_id = ?'); vals.push(data.expenseCategoryId ?? null); }
    if (Object.hasOwn(data, 'notes')) { sets.push('notes = ?'); vals.push(data.notes ?? null); }
    if (Object.hasOwn(data, 'isReconciled')) { sets.push('is_reconciled = ?'); vals.push(data.isReconciled ? 1 : 0); }
    if (!sets.length) return c.json({ ok: true });
    await c.env.DB.prepare(
      `UPDATE transactions
       SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).bind(...vals, id).run();

    await writeAudit(c.env, {
      userId: user.id,
      action: 'transaction.updated',
      resourceType: 'transaction',
      resourceId: id,
      newValues: data,
      ipAddress: c.req.header('CF-Connecting-IP'),
      userAgent: c.req.header('User-Agent'),
    });
    return c.json({ ok: true });
  }

  if (user.role === 'accountant') {
    const parsed = AccountantPatchSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const data = parsed.data;
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (Object.hasOwn(data, 'flagged')) { sets.push('flagged = ?'); vals.push(data.flagged ? 1 : 0); }
    if (Object.hasOwn(data, 'accountantNotes')) { sets.push('accountant_notes = ?'); vals.push(data.accountantNotes ?? null); }
    if (!sets.length) return c.json({ ok: true });
    await c.env.DB.prepare(
      `UPDATE transactions
       SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).bind(...vals, id).run();

    await writeAudit(c.env, {
      userId: user.id,
      action: 'transaction.updated',
      resourceType: 'transaction',
      resourceId: id,
      newValues: data,
      ipAddress: c.req.header('CF-Connecting-IP'),
      userAgent: c.req.header('User-Agent'),
    });
    return c.json({ ok: true });
  }

  return c.json({ error: 'Forbidden' }, 403);
});

router.post('/:id/match', zValidator('json', MatchSchema), async (c) => {
  const user = c.get('user');
  if (user.role !== 'owner') return c.json({ error: 'Forbidden' }, 403);

  const id = c.req.param('id');
  const data = c.req.valid('json');
  const tx = await c.env.DB.prepare('SELECT id FROM transactions WHERE id = ?').bind(id).first();
  if (!tx) return c.json({ error: 'Transaction not found' }, 404);

  if (data.type === 'invoice') {
    const invoice = await c.env.DB.prepare('SELECT id FROM invoices WHERE id = ?').bind(data.targetId).first();
    if (!invoice) return c.json({ error: 'Invoice not found' }, 404);
    await c.env.DB.prepare(
      `UPDATE transactions
       SET match_type = 'invoice', matched_invoice_id = ?, matched_bill_id = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).bind(data.targetId, id).run();
  } else {
    const bill = await c.env.DB.prepare('SELECT id FROM bills WHERE id = ?').bind(data.targetId).first();
    if (!bill) return c.json({ error: 'Bill not found' }, 404);
    await c.env.DB.prepare(
      `UPDATE transactions
       SET match_type = 'bill', matched_bill_id = ?, matched_invoice_id = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).bind(data.targetId, id).run();
  }

  await writeAudit(c.env, {
    userId: user.id,
    action: 'transaction.matched',
    resourceType: 'transaction',
    resourceId: id,
    newValues: data,
    ipAddress: c.req.header('CF-Connecting-IP'),
    userAgent: c.req.header('User-Agent'),
  });

  return c.json({ ok: true });
});

router.delete('/:id/match', async (c) => {
  const user = c.get('user');
  if (user.role !== 'owner') return c.json({ error: 'Forbidden' }, 403);

  const id = c.req.param('id');
  const tx = await c.env.DB.prepare('SELECT id FROM transactions WHERE id = ?').bind(id).first();
  if (!tx) return c.json({ error: 'Transaction not found' }, 404);

  await c.env.DB.prepare(
    `UPDATE transactions
     SET match_type = NULL, matched_invoice_id = NULL, matched_bill_id = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).bind(id).run();

  await writeAudit(c.env, {
    userId: user.id,
    action: 'transaction.matched',
    resourceType: 'transaction',
    resourceId: id,
    newValues: { type: null, targetId: null },
    ipAddress: c.req.header('CF-Connecting-IP'),
    userAgent: c.req.header('User-Agent'),
  });

  return c.json({ ok: true });
});

export { router as transactionRoutes };
