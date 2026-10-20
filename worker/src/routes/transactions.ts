import { Hono } from 'hono';
import { z } from 'zod';
import { checkUpload, fileResponse, DOCUMENT_TYPES } from '../services/files';
import { writeAudit } from '../middleware/audit';
import { requireRole } from '../middleware/rbac';
import { parsePenceText } from '../services/money';
import { postTransaction, postTransactions, undoTransaction } from '../services/bankReview';
import type { Env } from '../types';
import type { AuthUser } from '../types';

const router = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();

const OwnerPatchSchema = z.object({
  expenseCategoryId: z.string().nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
  // VAT included in the amount: 0 = no VAT, 0.2 = 20%; null = not chosen
  vatRate: z.number().min(0).max(1).nullable().optional(),
});

const AccountantPatchSchema = z.object({
  flagged: z.boolean().optional(),
  accountantNotes: z.string().max(1000).nullable().optional(),
});

// Payments out with no supplier invoice / receipt: nothing attached to the line, and not
// matched to a bill that has its PDF attached
const NO_RECEIPT_SQL = `t.amount < 0 AND t.attachment_r2_key IS NULL AND NOT EXISTS (
  SELECT 1 FROM transaction_matches tm JOIN bills b ON b.id = tm.bill_id
  WHERE tm.transaction_id = t.id AND tm.status IN ('pending','posted')
    AND b.attachment_r2_key IS NOT NULL)`;

// Lines matched or linked to an invoice/bill
const MATCHED_SQL = `EXISTS (SELECT 1 FROM transaction_matches tm
  WHERE tm.transaction_id = t.id AND tm.status IN ('pending','posted'))`;

// Query: bankAccountId, from, to, reviewed (or reconciled) 0|1, direction in|out,
// category <id>|matched|none, receipt missing|attached (noReceipt=1 = missing), flagged 0|1,
// unexplained=1, q (description, reference or amount). With page (from 1) and pageSize (≤ 200)
// the answer is { rows, total, page, pageSize }; without, a plain array of every match.
router.get('/', async (c) => {
  const bankAccountId = c.req.query('bankAccountId');
  const from          = c.req.query('from');
  const to            = c.req.query('to');
  const reviewed      = c.req.query('reviewed') ?? c.req.query('reconciled');
  const direction     = c.req.query('direction');
  const category      = c.req.query('category');
  const receipt       = c.req.query('noReceipt') === '1' ? 'missing' : c.req.query('receipt');
  const flagged       = c.req.query('flagged');
  const q             = c.req.query('q')?.trim();
  const unexplained   = c.req.query('unexplained');
  const page          = c.req.query('page') ? Math.max(1, Number.parseInt(c.req.query('page')!, 10) || 1) : null;
  const pageSize      = Math.min(200, Math.max(1, Number.parseInt(c.req.query('pageSize') ?? '50', 10) || 50));

  const clauses: string[] = [];
  const binds: unknown[] = [];

  if (bankAccountId) { clauses.push('t.bank_account_id = ?'); binds.push(bankAccountId); }
  if (from)          { clauses.push('t.date >= ?');            binds.push(from); }
  if (to)            { clauses.push('t.date <= ?');            binds.push(to); }
  if (reviewed === '0' || reviewed === '1') { clauses.push('t.is_reconciled = ?'); binds.push(Number(reviewed)); }
  if (direction === 'in')  clauses.push('t.amount > 0');
  if (direction === 'out') clauses.push('t.amount < 0');
  if (category === 'matched') clauses.push(MATCHED_SQL);
  else if (category === 'none') clauses.push(`t.expense_category_id IS NULL AND NOT ${MATCHED_SQL}`);
  else if (category) { clauses.push('t.expense_category_id = ?'); binds.push(category); }
  if (receipt === 'missing')  clauses.push(NO_RECEIPT_SQL);
  if (receipt === 'attached') clauses.push(`t.amount < 0 AND NOT (${NO_RECEIPT_SQL})`);
  if (flagged === '0' || flagged === '1') { clauses.push('t.flagged = ?'); binds.push(Number(flagged)); }
  if (q) {
    // An amount matches either direction: "120" finds +£120.00 and −£120.00
    const pence = parsePenceText(q);
    const text = ['t.description LIKE ?', 't.reference LIKE ?'];
    binds.push(`%${q}%`, `%${q}%`);
    if (pence !== null) { text.push('ABS(t.amount) = ?'); binds.push(Math.abs(pence)); }
    clauses.push(`(${text.join(' OR ')})`);
  }
  // Unexplained = no category and no accepted invoice/bill match
  if (unexplained === '1') {
    clauses.push(`t.expense_category_id IS NULL AND NOT EXISTS (
      SELECT 1 FROM transaction_matches tm
      WHERE tm.transaction_id = t.id AND tm.status IN ('pending','posted'))`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const { results } = await c.env.DB.prepare(`
    SELECT t.id, t.bank_account_id, t.date, t.description, t.amount, t.reference,
           t.expense_category_id, t.vat_rate, t.is_reconciled, t.reviewed_at, t.flagged,
           t.notes, t.accountant_notes,
           t.attachment_r2_key, t.attachment_filename,
           t.categorised_by_rule_id,
      ec.name as category_name,
      tm.id as match_id, tm.status as match_status, tm.kind as match_kind, tm.match_type,
      COALESCE(tm.invoice_id, tm.bill_id) as match_target_id, tm.allocated_amount as match_allocated,
      CASE tm.match_type
        WHEN 'invoice' THEN i2.invoice_number || ' — ' || c2.name
        WHEN 'bill'    THEN v2.name || COALESCE(' · ' || b2.bill_number, '')
      END as match_label,
      (SELECT COALESCE(SUM(allocated_amount), 0) FROM transaction_matches
       WHERE transaction_id = t.id AND status IN ('pending','posted')
      ) as allocated_total
    FROM transactions t
    LEFT JOIN expense_categories ec ON ec.id = t.expense_category_id
    -- The match to show for a line: a posted line shows what it was posted against; a line in
    -- review shows what's still waiting (pending, then a suggestion) before what's already done
    LEFT JOIN transaction_matches tm ON tm.id = CASE WHEN t.is_reconciled = 1
      THEN (SELECT id FROM transaction_matches WHERE transaction_id = t.id
            ORDER BY CASE status WHEN 'posted' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, created_at LIMIT 1)
      ELSE (SELECT id FROM transaction_matches WHERE transaction_id = t.id
            ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'suggested' THEN 1 ELSE 2 END, created_at LIMIT 1)
      END
    LEFT JOIN invoices i2 ON tm.invoice_id = i2.id
    LEFT JOIN clients c2  ON i2.client_id = c2.id
    LEFT JOIN bills b2    ON tm.bill_id = b2.id
    LEFT JOIN vendors v2  ON b2.vendor_id = v2.id
    ${where}
    ORDER BY t.date DESC, t.created_at DESC
    ${page ? 'LIMIT ? OFFSET ?' : ''}
  `).bind(...binds, ...(page ? [pageSize, (page - 1) * pageSize] : [])).all<Record<string, unknown>>();

  if (!page) return c.json(results);
  const count = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM transactions t ${where}`)
    .bind(...binds).first<{ n: number }>();
  return c.json({ rows: results, total: count?.n ?? 0, page, pageSize });
});

// GET /review-counts — lines waiting in For Review, per bank account
router.get('/review-counts', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT bank_account_id, COUNT(*) AS n FROM transactions WHERE is_reconciled = 0 GROUP BY bank_account_id`
  ).all<{ bank_account_id: string; n: number }>();
  return c.json(Object.fromEntries(results.map(r => [r.bank_account_id, r.n])));
});

// Lines per bulk post: each line with a pending match costs ~10 D1 queries, and a Worker
// invocation may run at most 50 on the Free plan (1,000 on Paid). The page sends bigger
// selections in chunks of this size.
const MAX_BULK_POST = 25;

// POST /post — post several lines at once (e.g. everything rules have categorised)
router.post('/post', requireRole('owner'), async (c) => {
  const body   = await c.req.json().catch(() => null);
  const parsed = z.object({ ids: z.array(z.string()).min(1).max(MAX_BULK_POST) }).safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const user = c.get('user');
  const { posted, failed } = await postTransactions(c.env.DB, user.id, [...new Set(parsed.data.ids)]);
  if (posted.length) {
    await writeAudit(c.env, {
      userId: user.id, action: 'transaction.posted', resourceType: 'transaction',
      newValues: { ids: posted },
      ipAddress: c.req.header('CF-Connecting-IP'), userAgent: c.req.header('User-Agent'),
    });
  }
  return c.json({ posted: posted.length, failed });
});

// GET /:id — one line with everything about it, for the details panel
router.get('/:id', async (c) => {
  const id = c.req.param('id');
  const txn = await c.env.DB.prepare(`
    SELECT t.id, t.bank_account_id, ba.name AS account_name, t.date, t.description, t.reference,
           t.amount, t.balance, t.expense_category_id, ec.name AS category_name, t.vat_rate,
           t.categorised_by_rule_id, cr.match_text AS rule_text,
           t.notes, t.accountant_notes, t.flagged, t.attachment_r2_key, t.attachment_filename,
           t.is_reconciled, t.reviewed_at, ru.name AS reviewed_by_name, t.created_at
    FROM transactions t
    LEFT JOIN bank_accounts ba ON ba.id = t.bank_account_id
    LEFT JOIN expense_categories ec ON ec.id = t.expense_category_id
    LEFT JOIN categorisation_rules cr ON cr.id = t.categorised_by_rule_id
    LEFT JOIN users ru ON ru.id = t.reviewed_by
    WHERE t.id = ?
  `).bind(id).first<Record<string, unknown>>();
  if (!txn) return c.json({ error: 'Not found' }, 404);

  const { results: matches } = await c.env.DB.prepare(`
    SELECT tm.id, tm.kind, tm.status, tm.match_type, tm.invoice_id, tm.bill_id, tm.allocated_amount,
           tm.posted_at, pu.name AS posted_by_name,
           CASE tm.match_type
             WHEN 'invoice' THEN i.invoice_number || ' — ' || cl.name
             WHEN 'bill'    THEN v.name || COALESCE(' · ' || b.bill_number, '')
           END AS label
    FROM transaction_matches tm
    LEFT JOIN invoices i ON i.id = tm.invoice_id
    LEFT JOIN clients cl ON cl.id = i.client_id
    LEFT JOIN bills b ON b.id = tm.bill_id
    LEFT JOIN vendors v ON v.id = b.vendor_id
    LEFT JOIN users pu ON pu.id = tm.posted_by
    WHERE tm.transaction_id = ?
    ORDER BY CASE tm.status WHEN 'posted' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END
  `).bind(id).all<Record<string, unknown>>();

  return c.json({ ...txn, matches });
});

// POST /:id/post — take one line out of For Review
router.post('/:id/post', requireRole('owner'), async (c) => {
  const user = c.get('user');
  const id = c.req.param('id') ?? '';
  const res = await postTransaction(c.env.DB, user.id, id);
  if (!res.ok) return c.json({ error: res.error }, res.status);
  await writeAudit(c.env, {
    userId: user.id, action: 'transaction.posted', resourceType: 'transaction', resourceId: id,
    newValues: { payments: res.payments },
    ipAddress: c.req.header('CF-Connecting-IP'), userAgent: c.req.header('User-Agent'),
  });
  return c.json(res);
});

// POST /:id/undo — send a posted line back to For Review, reversing any payment it made
router.post('/:id/undo', requireRole('owner'), async (c) => {
  const user = c.get('user');
  const id = c.req.param('id') ?? '';
  const res = await undoTransaction(c.env.DB, id);
  if (!res.ok) return c.json({ error: res.error }, res.status);
  await writeAudit(c.env, {
    userId: user.id, action: 'transaction.unposted', resourceType: 'transaction', resourceId: id,
    oldValues: { reopened: res.reopened, alsoReturned: res.alsoReturned },
    ipAddress: c.req.header('CF-Connecting-IP'), userAgent: c.req.header('User-Agent'),
  });
  return c.json(res);
});

router.patch('/:id', async (c) => {
  const user = c.get('user');
  const id   = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') return c.json({ error: 'Invalid JSON body' }, 400);

  const existing = await c.env.DB.prepare(
    'SELECT id, is_reconciled FROM transactions WHERE id = ?'
  ).bind(id).first<{ id: string; is_reconciled: number }>();
  if (!existing) return c.json({ error: 'Not found' }, 404);

  if (user.role === 'owner') {
    const parsed = OwnerPatchSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const data = parsed.data;
    // A posted line's category and VAT are in the books; change them by sending the line back to review
    if (existing.is_reconciled && (Object.hasOwn(data, 'expenseCategoryId') || Object.hasOwn(data, 'vatRate'))) {
      return c.json({ error: 'This line is posted. Undo it to change its category or VAT.' }, 409);
    }
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (Object.hasOwn(data, 'expenseCategoryId')) {
      sets.push('expense_category_id = ?', 'categorised_by_rule_id = NULL', 'category_auto = 0');
      vals.push(data.expenseCategoryId ?? null);
    }
    if (Object.hasOwn(data, 'vatRate')) {
      sets.push('vat_rate = ?');
      vals.push(data.vatRate ?? null);
    } else if (data.expenseCategoryId) {
      // A new category brings its usual VAT, if it has one
      sets.push('vat_rate = COALESCE((SELECT default_vat_rate FROM expense_categories WHERE id = ?), vat_rate)');
      vals.push(data.expenseCategoryId);
    }
    if (Object.hasOwn(data, 'notes'))             { sets.push('notes = ?');               vals.push(data.notes ?? null); }
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
