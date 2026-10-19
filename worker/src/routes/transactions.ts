import { Hono } from 'hono';
import { z } from 'zod';
import { checkUpload, fileResponse, DOCUMENT_TYPES } from '../services/files';
import { writeAudit } from '../middleware/audit';
import type { Env } from '../types';
import type { AuthUser } from '../types';

const router = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();

const OwnerPatchSchema = z.object({
  expenseCategoryId: z.string().nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
  isReconciled: z.boolean().optional(),
});

const AccountantPatchSchema = z.object({
  flagged: z.boolean().optional(),
  accountantNotes: z.string().max(1000).nullable().optional(),
});

router.get('/', async (c) => {
  const bankAccountId = c.req.query('bankAccountId');
  const from          = c.req.query('from');
  const to            = c.req.query('to');
  const reconciled    = c.req.query('reconciled');
  const category      = c.req.query('category');
  const flagged       = c.req.query('flagged');
  const q             = c.req.query('q')?.trim();
  const unexplained   = c.req.query('unexplained');
  const noReceipt     = c.req.query('noReceipt');

  const clauses: string[] = [];
  const binds: unknown[] = [];

  if (bankAccountId) { clauses.push('t.bank_account_id = ?'); binds.push(bankAccountId); }
  if (from)          { clauses.push('t.date >= ?');            binds.push(from); }
  if (to)            { clauses.push('t.date <= ?');            binds.push(to); }
  if (reconciled === '0' || reconciled === '1') { clauses.push('t.is_reconciled = ?'); binds.push(Number(reconciled)); }
  if (category)      { clauses.push('t.expense_category_id = ?'); binds.push(category); }
  if (flagged === '0' || flagged === '1') { clauses.push('t.flagged = ?'); binds.push(Number(flagged)); }
  if (q)             { clauses.push('t.description LIKE ?'); binds.push(`%${q}%`); }
  // Unexplained = no category and no accepted invoice/bill match
  if (unexplained === '1') {
    clauses.push(`t.expense_category_id IS NULL AND NOT EXISTS (
      SELECT 1 FROM transaction_matches tm
      WHERE tm.transaction_id = t.id AND tm.status IN ('pending','posted'))`);
  }

  // Payments out with no supplier invoice / receipt: nothing attached to the line, and not
  // matched to a bill that has its PDF attached
  if (noReceipt === '1') {
    clauses.push(`t.amount < 0 AND t.attachment_r2_key IS NULL AND NOT EXISTS (
      SELECT 1 FROM transaction_matches tm JOIN bills b ON b.id = tm.bill_id
      WHERE tm.transaction_id = t.id AND tm.status IN ('pending','posted')
        AND b.attachment_r2_key IS NOT NULL)`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const { results } = await c.env.DB.prepare(`
    SELECT t.id, t.bank_account_id, t.date, t.description, t.amount, t.reference,
           t.expense_category_id, t.is_reconciled, t.flagged,
           t.notes, t.accountant_notes,
           t.attachment_r2_key, t.attachment_filename,
           t.categorised_by_rule_id,
      ec.name as category_name,
      (SELECT status FROM transaction_matches WHERE transaction_id = t.id
       ORDER BY CASE status WHEN 'posted' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END LIMIT 1
      ) as match_status,
      (SELECT
         CASE tm.match_type
           WHEN 'invoice' THEN i2.invoice_number || ' — ' || c2.name
           WHEN 'bill'    THEN v2.name || COALESCE(' · ' || b2.bill_number, '')
         END
       FROM transaction_matches tm
       LEFT JOIN invoices i2 ON tm.invoice_id = i2.id
       LEFT JOIN clients c2  ON i2.client_id = c2.id
       LEFT JOIN bills b2    ON tm.bill_id = b2.id
       LEFT JOIN vendors v2  ON b2.vendor_id = v2.id
       WHERE tm.transaction_id = t.id
       ORDER BY CASE tm.status WHEN 'posted' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END LIMIT 1
      ) as match_label
    FROM transactions t
    LEFT JOIN expense_categories ec ON ec.id = t.expense_category_id
    ${where}
    ORDER BY t.date DESC, t.created_at DESC
  `).bind(...binds).all<Record<string, unknown>>();

  return c.json(results);
});

router.patch('/:id', async (c) => {
  const user = c.get('user');
  const id   = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') return c.json({ error: 'Invalid JSON body' }, 400);

  const existing = await c.env.DB.prepare(
    'SELECT id FROM transactions WHERE id = ?'
  ).bind(id).first();
  if (!existing) return c.json({ error: 'Not found' }, 404);

  if (user.role === 'owner') {
    const parsed = OwnerPatchSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const data = parsed.data;
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (Object.hasOwn(data, 'expenseCategoryId')) {
      sets.push('expense_category_id = ?', 'categorised_by_rule_id = NULL');
      vals.push(data.expenseCategoryId ?? null);
    }
    if (Object.hasOwn(data, 'notes'))             { sets.push('notes = ?');               vals.push(data.notes ?? null); }
    if (Object.hasOwn(data, 'isReconciled'))       { sets.push('is_reconciled = ?');       vals.push(data.isReconciled ? 1 : 0); }
    if (!sets.length) return c.json({ ok: true });
    await c.env.DB.prepare(
      `UPDATE transactions SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
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
    if (Object.hasOwn(data, 'flagged'))          { sets.push('flagged = ?');          vals.push(data.flagged ? 1 : 0); }
    if (Object.hasOwn(data, 'accountantNotes'))  { sets.push('accountant_notes = ?'); vals.push(data.accountantNotes ?? null); }
    if (!sets.length) return c.json({ ok: true });
    await c.env.DB.prepare(
      `UPDATE transactions SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
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

// POST /api/v1/transactions/:id/attachments — upload supplier invoice PDF
router.post('/:id/attachments', async (c) => {
  const user = c.get('user');
  if (user.role !== 'owner') return c.json({ error: 'Forbidden' }, 403);

  const id = c.req.param('id');
  const txn = await c.env.DB.prepare('SELECT id FROM transactions WHERE id = ?').bind(id).first();
  if (!txn) return c.json({ error: 'Not found' }, 404);

  const formData = await c.req.formData().catch(() => null);
  const checked = await checkUpload(formData?.get('file') ?? null, DOCUMENT_TYPES, 10 * 1024 * 1024);
  if (!checked.ok) return c.json({ error: checked.error }, 400);
  const file = { name: checked.name };
  const key = `transactions/${id}/attachment.${checked.ext}`;
  await c.env.R2.put(key, checked.bytes, { httpMetadata: { contentType: checked.type } });

  await c.env.DB.prepare(
    `UPDATE transactions SET attachment_r2_key = ?, attachment_filename = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).bind(key, file.name, id).run();

  return c.json({ ok: true, filename: file.name });
});

// GET /api/v1/transactions/:id/attachments — stream the attachment
router.get('/:id/attachments', async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    'SELECT attachment_r2_key, attachment_filename FROM transactions WHERE id = ?'
  ).bind(id).first<{ attachment_r2_key: string | null; attachment_filename: string | null }>();
  if (!row?.attachment_r2_key) return c.json({ error: 'No attachment' }, 404);

  const obj = await c.env.R2.get(row.attachment_r2_key);
  if (!obj) return c.json({ error: 'File not found in storage' }, 404);

  return fileResponse(obj.body, obj.httpMetadata?.contentType, row.attachment_filename ?? 'attachment');
});

export { router as transactionRoutes };
