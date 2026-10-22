import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { requireRole } from '../middleware/rbac';
import { actorOf, auditStatement, changedFields } from '../middleware/audit';
import { calculateTotals } from '../services/money';
import { deleteDocumentPayment, paymentExistsSql, recordDocumentPayment } from '../services/recordPayment';
import { uploadToR2, getSignedUrl, getFileResponse } from '../services/r2';
import { checkUpload, DOCUMENT_TYPES } from '../services/files';
import type { Env } from '../types';

const router = new Hono<{ Bindings: Env }>();

const ItemSchema = z.object({
  description:         z.string().min(1).max(500),
  quantity:            z.number().positive(),
  unit_price:          z.number().int().min(0),
  tax_rate:            z.number().min(0).max(1).default(0),
  expense_category_id: z.string().length(32).optional().nullable(),
});

const BillSchema = z.object({
  vendor_id:    z.string().length(32),
  bill_number:  z.string().max(100).optional().nullable(),
  issue_date:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  due_date:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  currency:     z.string().max(10).default('GBP'),
  notes:        z.string().max(1000).optional().nullable(),
  items:        z.array(ItemSchema).min(1),
});

const PaymentSchema = z.object({
  amount:       z.number().int().positive(),
  payment_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  method:       z.string().max(50).optional().nullable(),
  reference:    z.string().max(100).optional().nullable(),
  notes:        z.string().max(500).optional().nullable(),
});

const FlagSchema = z.object({
  flagged:          z.boolean(),
  accountant_notes: z.string().max(1000).optional().nullable(),
});

// GET /api/v1/bills
router.get('/', async (c) => {
  const where: string[] = [];
  const binds: string[] = [];
  if (c.req.query('flagged') === '1') where.push('b.flagged = 1');
  const vendorId = c.req.query('vendor_id');
  if (vendorId) { where.push('b.vendor_id = ?'); binds.push(vendorId); }
  const rows = await c.env.DB.prepare(
    `SELECT b.id, b.vendor_id, v.name as vendor_name, b.bill_number, b.status,
            b.issue_date, b.due_date, b.subtotal, b.tax_amount, b.total, b.amount_paid,
            b.flagged, b.created_at
     FROM bills b
     JOIN vendors v ON v.id = b.vendor_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY b.created_at DESC`
  ).bind(...binds).all();
  return c.json(rows.results);
});

// GET /api/v1/bills/:id
router.get('/:id', async (c) => {
  const id = c.req.param('id');
  const bill = await c.env.DB.prepare(
    `SELECT b.*, v.name as vendor_name, v.email as vendor_email, v.address as vendor_address
     FROM bills b
     JOIN vendors v ON v.id = b.vendor_id
     WHERE b.id = ?`
  ).bind(id).first();
  if (!bill) return c.json({ error: 'Not found' }, 404);

  const items = await c.env.DB.prepare(
    `SELECT bi.id, bi.description, bi.quantity, bi.unit_price, bi.tax_rate,
            bi.amount, bi.expense_category_id, bi.sort_order,
            ec.name as expense_category_name
     FROM bill_items bi
     LEFT JOIN expense_categories ec ON ec.id = bi.expense_category_id
     WHERE bi.bill_id = ?
     ORDER BY bi.sort_order ASC`
  ).bind(id).all();

  const payments = await c.env.DB.prepare(
    `SELECT id, amount, payment_date, method, reference, notes
     FROM payments_made WHERE bill_id = ? ORDER BY payment_date DESC`
  ).bind(id).all();

  // A pending match is waiting to pay this bill from the bank. A posted one already did.
  // Either blocks voiding; a pending one also blocks recording a payment by hand.
  // An aggregate without GROUP BY always returns one row
  const bankMatches = (await c.env.DB.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
       COUNT(*) AS blocking
     FROM transaction_matches
     WHERE bill_id = ? AND kind = 'payment' AND status IN ('pending', 'posted')`
  ).bind(id).first<{ pending: number; blocking: number }>())!;

  return c.json({
    ...bill,
    items: items.results,
    payments: payments.results,
    pending_bank_matches: bankMatches.pending,
    bank_matches: bankMatches.blocking,
  });
});

// POST /api/v1/bills
router.post('/', requireRole('owner'), zValidator('json', BillSchema), async (c) => {
  const user = c.get('user');
  const data = c.req.valid('json');

  const vendor = await c.env.DB.prepare('SELECT id FROM vendors WHERE id = ? AND is_active = 1')
    .bind(data.vendor_id).first();
  if (!vendor) return c.json({ error: 'Vendor not found' }, 422);

  const totals = calculateTotals(data.items);
  const id = crypto.randomUUID().replace(/-/g, '');

  const insertBill = c.env.DB.prepare(
    `INSERT INTO bills
      (id, vendor_id, bill_number, status, issue_date, due_date, currency,
       subtotal, tax_amount, total, amount_paid, notes, created_by)
     VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, 0, ?, ?)`
  ).bind(
    id,
    data.vendor_id,
    data.bill_number ?? null,
    data.issue_date ?? null,
    data.due_date ?? null,
    data.currency,
    totals.subtotal,
    totals.tax_amount,
    totals.total,
    data.notes ?? null,
    user.id
  );

  const inserts = data.items.map((item, i) => {
    const lineAmount = Math.round(item.quantity * item.unit_price);
    return c.env.DB.prepare(
      `INSERT INTO bill_items
        (id, bill_id, description, quantity, unit_price, tax_rate, amount, expense_category_id, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      crypto.randomUUID().replace(/-/g, ''),
      id,
      item.description,
      item.quantity,
      item.unit_price,
      item.tax_rate,
      lineAmount,
      item.expense_category_id ?? null,
      i
    );
  });
  await c.env.DB.batch([
    insertBill,
    ...inserts,
    auditStatement(c.env.DB, actorOf(c), {
      action: 'bill.created', resourceType: 'bill', resourceId: id,
      newValues: { ...billFields(data), ...totals },
      summary: `Created bill${data.bill_number ? ` ${data.bill_number}` : ''}`,
    }),
  ]);

  return c.json({ id, total: totals.total }, 201);
});

// PUT /api/v1/bills/:id
router.put('/:id', requireRole('owner'), zValidator('json', BillSchema), async (c) => {
  const id = c.req.param('id');
  const data = c.req.valid('json');

  const existing = await c.env.DB.prepare(
    `SELECT vendor_id, bill_number, issue_date, due_date, currency, notes, subtotal, tax_amount, total
     FROM bills WHERE id = ?`
  ).bind(id).first<Record<string, unknown>>();
  if (!existing) return c.json({ error: 'Not found' }, 404);
  const { results: oldItems } = await c.env.DB.prepare(
    `SELECT description, quantity, unit_price, tax_rate, expense_category_id
     FROM bill_items WHERE bill_id = ? ORDER BY sort_order`
  ).bind(id).all<z.infer<typeof ItemSchema>>();

  const payments = (await c.env.DB.prepare(
    'SELECT COUNT(*) as n FROM payments_made WHERE bill_id = ?'
  ).bind(id).first<{ n: number }>())!;
  if (payments.n > 0) return c.json({ error: 'Cannot modify bill with existing payments' }, 409);

  const vendor = await c.env.DB.prepare('SELECT id FROM vendors WHERE id = ? AND is_active = 1')
    .bind(data.vendor_id).first();
  if (!vendor) return c.json({ error: 'Vendor not found' }, 422);

  const totals = calculateTotals(data.items);

  const update = c.env.DB.prepare(
    `UPDATE bills
     SET vendor_id = ?, bill_number = ?, issue_date = ?, due_date = ?,
         currency = ?, subtotal = ?, tax_amount = ?, total = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).bind(
    data.vendor_id,
    data.bill_number ?? null,
    data.issue_date ?? null,
    data.due_date ?? null,
    data.currency,
    totals.subtotal,
    totals.tax_amount,
    totals.total,
    data.notes ?? null,
    id
  );

  const inserts = data.items.map((item, i) => {
    const lineAmount = Math.round(item.quantity * item.unit_price);
    return c.env.DB.prepare(
      `INSERT INTO bill_items
        (id, bill_id, description, quantity, unit_price, tax_rate, amount, expense_category_id, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      crypto.randomUUID().replace(/-/g, ''),
      id,
      item.description,
      item.quantity,
      item.unit_price,
      item.tax_rate,
      lineAmount,
      item.expense_category_id ?? null,
      i
    );
  });
  const diff = changedFields(
    { ...existing, items: auditItems(oldItems) },
    { ...billFields(data), ...totals },
  );
  // The bill, its lines and the audit row are written together
  await c.env.DB.batch([
    update,
    c.env.DB.prepare('DELETE FROM bill_items WHERE bill_id = ?').bind(id),
    ...inserts,
    ...(diff ? [auditStatement(c.env.DB, actorOf(c), {
      action: 'bill.updated', resourceType: 'bill', resourceId: id, ...diff,
      summary: `Edited bill${data.bill_number ? ` ${data.bill_number}` : ''}`,
    })] : []),
  ]);

  return c.json({ ok: true });
});

// DELETE /api/v1/bills/:id
router.delete('/:id', requireRole('owner'), async (c) => {
  const id = c.req.param('id');

  const existing = await c.env.DB.prepare('SELECT id, status, bill_number, total FROM bills WHERE id = ?')
    .bind(id).first<{ id: string; status: string; bill_number: string | null; total: number }>();
  if (!existing) return c.json({ error: 'Not found' }, 404);
  if (existing.status === 'void') return c.json({ error: 'Already voided' }, 422);

  const payments = (await c.env.DB.prepare(
    'SELECT COUNT(*) as n FROM payments_made WHERE bill_id = ?'
  ).bind(id).first<{ n: number }>())!;
  if (payments.n > 0) return c.json({ error: 'Cannot delete bill with payments' }, 409);
  // Same rule as invoices: a bill a bank line is matched to stays until the match is removed
  const matched = (await c.env.DB.prepare(
    `SELECT COUNT(*) as n FROM transaction_matches WHERE bill_id = ? AND status IN ('pending', 'posted')`
  ).bind(id).first<{ n: number }>())!;
  if (matched.n > 0) {
    return c.json({ error: 'This bill is matched to a bank line. Remove the match before voiding it.' }, 409);
  }

  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM transaction_matches WHERE bill_id = ? AND status = 'suggested'`).bind(id),
    c.env.DB.prepare(
      `UPDATE bills SET status = 'void', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).bind(id),
    auditStatement(c.env.DB, actorOf(c), {
      action: 'bill.voided', resourceType: 'bill', resourceId: id,
      oldValues: { status: existing.status }, newValues: { status: 'void', total: existing.total },
      summary: `Voided bill${existing.bill_number ? ` ${existing.bill_number}` : ''}`,
    }),
  ]);

  return c.json({ ok: true });
});

// PATCH /api/v1/bills/:id/flag
router.patch('/:id/flag', requireRole('accountant'), zValidator('json', FlagSchema), async (c) => {
  const id = c.req.param('id');
  const data = c.req.valid('json');

  const existing = await c.env.DB.prepare('SELECT id, flagged, accountant_notes FROM bills WHERE id = ?')
    .bind(id).first<{ id: string; flagged: number; accountant_notes: string | null }>();
  if (!existing) return c.json({ error: 'Not found' }, 404);

  const diff = changedFields(
    { flagged: !!existing.flagged, accountant_notes: existing.accountant_notes },
    { flagged: data.flagged, accountant_notes: data.accountant_notes ?? null },
  );
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE bills
       SET flagged = ?, accountant_notes = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).bind(data.flagged ? 1 : 0, data.accountant_notes ?? null, id),
    ...(diff ? [auditStatement(c.env.DB, actorOf(c), {
      action: 'bill.flagged', resourceType: 'bill', resourceId: id, ...diff,
      summary: Object.hasOwn(diff.newValues, 'flagged')
        ? (data.flagged ? 'Flagged by the accountant' : 'Flag cleared')
        : 'Accountant notes changed',
    })] : []),
  ]);

  return c.json({ ok: true });
});

// POST /api/v1/bills/:id/attachments
router.post('/:id/attachments', requireRole('owner'), async (c) => {
  const id = c.req.param('id');

  const existing = await c.env.DB.prepare('SELECT id, attachment_r2_key, attachment_filename FROM bills WHERE id = ?')
    .bind(id).first<{ id: string; attachment_r2_key: string | null; attachment_filename: string | null }>();
  if (!existing) return c.json({ error: 'Not found' }, 404);

  const form = await c.req.formData().catch(() => null);
  const checked = await checkUpload(form?.get('file') ?? null, DOCUMENT_TYPES, 10 * 1024 * 1024);
  if (!checked.ok) return c.json({ error: checked.error }, 400);
  const upload = { name: checked.name };
  const key = `bills/${id}/${Date.now()}.${checked.ext}`;
  await uploadToR2(c.env.R2, key, checked.bytes, checked.type);

  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE bills SET attachment_r2_key = ?, attachment_filename = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).bind(key, upload.name, id),
    auditStatement(c.env.DB, actorOf(c), {
      action: 'bill.attachment_uploaded', resourceType: 'bill', resourceId: id,
      oldValues: existing.attachment_r2_key ? { file: existing.attachment_filename, key: existing.attachment_r2_key } : undefined,
      newValues: { file: upload.name, key },
      summary: existing.attachment_r2_key ? `Replaced the attachment with ${upload.name}` : `Attached ${upload.name}`,
    }),
  ]);

  return c.json({ key, filename: upload.name }, 201);
});

// GET /api/v1/bills/:id/attachments
router.get('/:id/attachments', async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    `SELECT attachment_r2_key, attachment_filename FROM bills WHERE id = ?`
  ).bind(id).first<{ attachment_r2_key: string | null; attachment_filename: string | null }>();
  if (!row || !row.attachment_r2_key) return c.json({ error: 'Attachment not found' }, 404);

  const signedUrl = await getSignedUrl(c.env.R2, row.attachment_r2_key, 900);
  if (signedUrl) {
    return c.json({ url: signedUrl, filename: row.attachment_filename, expires_in: 900 });
  }

  // split() always returns at least one part
  const filename = row.attachment_filename ?? row.attachment_r2_key.split('/').pop()!;
  return getFileResponse(c, row.attachment_r2_key, filename);
});

// POST /api/v1/bills/:id/payments
router.post('/:id/payments', requireRole('owner'), zValidator('json', PaymentSchema), async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const data = c.req.valid('json');

  const recorded = await recordDocumentPayment(c.env.DB, 'bill', id, {
    amount: data.amount,
    payment_date: data.payment_date,
    method: data.method ?? null,
    reference: data.reference ?? null,
    notes: data.notes ?? null,
    userId: user.id,
  }, paymentId => [auditStatement(c.env.DB, actorOf(c), {
    action: 'payment.created', resourceType: 'bill', resourceId: id,
    newValues: { paymentId, amount: data.amount, payment_date: data.payment_date, method: data.method ?? null, reference: data.reference ?? null },
    summary: 'Payment recorded by hand',
  }, paymentExistsSql('bill', paymentId))]);
  if (!recorded.ok) return c.json({ error: recorded.error }, recorded.status);
  const paymentId = recorded.id;
  const newStatus = recorded.status;

  return c.json({ id: paymentId, status: newStatus }, 201);
});

// DELETE /api/v1/bills/:id/payments/:paymentId
router.delete('/:id/payments/:paymentId', requireRole('owner'), async (c) => {
  // The route only matches with both parts present
  const id = c.req.param('id')!;
  const paymentId = c.req.param('paymentId')!;

  const removed = await deleteDocumentPayment(c.env.DB, 'bill', id, paymentId, (amount, before) => [
    auditStatement(c.env.DB, actorOf(c), {
      action: 'payment.deleted', resourceType: 'bill', resourceId: id,
      oldValues: { paymentId, amount, amount_paid: before.amount_paid, status: before.status },
      summary: 'Payment deleted',
    }, paymentExistsSql('bill', paymentId)),
  ]);
  if (!removed.ok) return c.json({ error: removed.error }, removed.status);

  return c.json({ ok: true });
});

/** A bill's fields as stored (nulls, not missing keys), for its audit rows */
function billFields(data: z.infer<typeof BillSchema>) {
  return {
    vendor_id: data.vendor_id, bill_number: data.bill_number ?? null,
    issue_date: data.issue_date ?? null, due_date: data.due_date ?? null,
    currency: data.currency, notes: data.notes ?? null, items: auditItems(data.items),
  };
}

function auditItems(items: Array<z.infer<typeof ItemSchema>>) {
  return items.map(({ description, quantity, unit_price, tax_rate, expense_category_id }) =>
    ({ description, quantity, unit_price, tax_rate, expense_category_id: expense_category_id ?? null }));
}

export { router as billRoutes };
