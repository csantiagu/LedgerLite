import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { requireRole } from '../middleware/rbac';
import { writeAudit } from '../middleware/audit';
import { calculateTotals } from '../services/money';
import { uploadToR2, getSignedUrl, getFileResponse } from '../services/r2';
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
  status:       z.enum(['pending', 'partial', 'paid', 'void']).optional(),
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
  const flaggedOnly = c.req.query('flagged') === '1';
  const rows = await c.env.DB.prepare(
    `SELECT b.id, b.vendor_id, v.name as vendor_name, b.bill_number, b.status,
            b.issue_date, b.due_date, b.subtotal, b.tax_amount, b.total, b.amount_paid,
            b.flagged, b.created_at
     FROM bills b
     JOIN vendors v ON v.id = b.vendor_id
     ${flaggedOnly ? 'WHERE b.flagged = 1' : ''}
     ORDER BY b.created_at DESC`
  ).all();
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

  return c.json({ ...bill, items: items.results, payments: payments.results });
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

  await c.env.DB.prepare(
    `INSERT INTO bills
      (id, vendor_id, bill_number, status, issue_date, due_date, currency,
       subtotal, tax_amount, total, amount_paid, notes, created_by)
     VALUES (?, ?, ?, COALESCE(?, 'pending'), ?, ?, ?, ?, ?, ?, 0, ?, ?)`
  ).bind(
    id,
    data.vendor_id,
    data.bill_number ?? null,
    data.status ?? null,
    data.issue_date ?? null,
    data.due_date ?? null,
    data.currency ?? 'GBP',
    totals.subtotal,
    totals.tax_amount,
    totals.total,
    data.notes ?? null,
    user.id
  ).run();

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
  await c.env.DB.batch(inserts);

  await writeAudit(c.env, {
    userId: user.id,
    action: 'bill.created',
    resourceType: 'bill',
    resourceId: id,
    newValues: { ...data, ...totals },
    ipAddress: c.req.header('CF-Connecting-IP'),
    userAgent: c.req.header('User-Agent'),
  });

  return c.json({ id }, 201);
});

// PUT /api/v1/bills/:id
router.put('/:id', requireRole('owner'), zValidator('json', BillSchema), async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const data = c.req.valid('json');

  const existing = await c.env.DB.prepare('SELECT id FROM bills WHERE id = ?').bind(id).first();
  if (!existing) return c.json({ error: 'Not found' }, 404);

  const payments = await c.env.DB.prepare(
    'SELECT COUNT(*) as n FROM payments_made WHERE bill_id = ?'
  ).bind(id).first<{ n: number }>();
  if ((payments?.n ?? 0) > 0) return c.json({ error: 'Cannot modify bill with existing payments' }, 409);

  const vendor = await c.env.DB.prepare('SELECT id FROM vendors WHERE id = ? AND is_active = 1')
    .bind(data.vendor_id).first();
  if (!vendor) return c.json({ error: 'Vendor not found' }, 422);

  const totals = calculateTotals(data.items);

  await c.env.DB.prepare(
    `UPDATE bills
     SET vendor_id = ?, bill_number = ?, status = ?, issue_date = ?, due_date = ?,
         currency = ?, subtotal = ?, tax_amount = ?, total = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).bind(
    data.vendor_id,
    data.bill_number ?? null,
    data.status ?? 'pending',
    data.issue_date ?? null,
    data.due_date ?? null,
    data.currency ?? 'GBP',
    totals.subtotal,
    totals.tax_amount,
    totals.total,
    data.notes ?? null,
    id
  ).run();

  await c.env.DB.prepare('DELETE FROM bill_items WHERE bill_id = ?').bind(id).run();
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
  await c.env.DB.batch(inserts);

  await writeAudit(c.env, {
    userId: user.id,
    action: 'bill.updated',
    resourceType: 'bill',
    resourceId: id,
    newValues: { ...data, ...totals },
    ipAddress: c.req.header('CF-Connecting-IP'),
    userAgent: c.req.header('User-Agent'),
  });

  return c.json({ ok: true });
});

// DELETE /api/v1/bills/:id
router.delete('/:id', requireRole('owner'), async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');

  const existing = await c.env.DB.prepare('SELECT id, status FROM bills WHERE id = ?')
    .bind(id).first<{ id: string; status: string }>();
  if (!existing) return c.json({ error: 'Not found' }, 404);

  const payments = await c.env.DB.prepare(
    'SELECT COUNT(*) as n FROM payments_made WHERE bill_id = ?'
  ).bind(id).first<{ n: number }>();
  if ((payments?.n ?? 0) > 0) return c.json({ error: 'Cannot delete bill with payments' }, 409);

  await c.env.DB.prepare(
    `UPDATE bills SET status = 'void', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).bind(id).run();

  await writeAudit(c.env, {
    userId: user.id,
    action: 'bill.updated',
    resourceType: 'bill',
    resourceId: id,
    oldValues: { status: existing.status },
    newValues: { status: 'void' },
    ipAddress: c.req.header('CF-Connecting-IP'),
    userAgent: c.req.header('User-Agent'),
  });

  return c.json({ ok: true });
});

// PATCH /api/v1/bills/:id/flag
router.patch('/:id/flag', requireRole('accountant'), zValidator('json', FlagSchema), async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const data = c.req.valid('json');

  const existing = await c.env.DB.prepare('SELECT id, flagged, accountant_notes FROM bills WHERE id = ?')
    .bind(id).first<{ id: string; flagged: number; accountant_notes: string | null }>();
  if (!existing) return c.json({ error: 'Not found' }, 404);

  await c.env.DB.prepare(
    `UPDATE bills
     SET flagged = ?, accountant_notes = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).bind(data.flagged ? 1 : 0, data.accountant_notes ?? null, id).run();

  await writeAudit(c.env, {
    userId: user.id,
    action: 'bill.flagged',
    resourceType: 'bill',
    resourceId: id,
    oldValues: { flagged: existing.flagged, accountant_notes: existing.accountant_notes },
    newValues: { flagged: data.flagged ? 1 : 0, accountant_notes: data.accountant_notes ?? null },
    ipAddress: c.req.header('CF-Connecting-IP'),
    userAgent: c.req.header('User-Agent'),
  });

  return c.json({ ok: true });
});

// POST /api/v1/bills/:id/attachments
router.post('/:id/attachments', requireRole('owner'), async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');

  const existing = await c.env.DB.prepare('SELECT id FROM bills WHERE id = ?').bind(id).first();
  if (!existing) return c.json({ error: 'Not found' }, 404);

  const form = await c.req.formData();
  const file = form.get('file');
  if (!file || typeof file === 'string' || typeof (file as Blob).arrayBuffer !== 'function') {
    return c.json({ error: 'file is required' }, 400);
  }

  const upload = file as File;
  const safeName = upload.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const key = `bills/${id}/${Date.now()}-${safeName}`;
  const data = await upload.arrayBuffer();
  await uploadToR2(c.env.R2, key, data, upload.type || 'application/octet-stream');

  await c.env.DB.prepare(
    `UPDATE bills SET attachment_r2_key = ?, attachment_filename = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).bind(key, upload.name, id).run();

  await writeAudit(c.env, {
    userId: user.id,
    action: 'bill.updated',
    resourceType: 'bill',
    resourceId: id,
    newValues: { attachment_r2_key: key, attachment_filename: upload.name },
    ipAddress: c.req.header('CF-Connecting-IP'),
    userAgent: c.req.header('User-Agent'),
  });

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

  const filename = row.attachment_filename ?? row.attachment_r2_key.split('/').pop() ?? 'attachment';
  return getFileResponse(c, row.attachment_r2_key, filename);
});

// POST /api/v1/bills/:id/payments
router.post('/:id/payments', requireRole('owner'), zValidator('json', PaymentSchema), async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const data = c.req.valid('json');

  const bill = await c.env.DB.prepare(
    `SELECT id, status, total, amount_paid FROM bills WHERE id = ?`
  ).bind(id).first<{ id: string; status: string; total: number; amount_paid: number }>();
  if (!bill) return c.json({ error: 'Not found' }, 404);
  if (bill.status === 'void') return c.json({ error: 'Void bill cannot receive payments' }, 422);

  const newPaid = bill.amount_paid + data.amount;
  if (newPaid > bill.total) return c.json({ error: 'Payment exceeds bill total' }, 422);

  const paymentId = crypto.randomUUID().replace(/-/g, '');
  await c.env.DB.prepare(
    `INSERT INTO payments_made
      (id, bill_id, amount, payment_date, method, reference, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    paymentId,
    id,
    data.amount,
    data.payment_date,
    data.method ?? null,
    data.reference ?? null,
    data.notes ?? null,
    user.id
  ).run();

  const newStatus = newPaid >= bill.total ? 'paid' : newPaid > 0 ? 'partial' : 'pending';
  await c.env.DB.prepare(
    `UPDATE bills SET amount_paid = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).bind(newPaid, newStatus, id).run();

  await writeAudit(c.env, {
    userId: user.id,
    action: 'payment.created',
    resourceType: 'payment_made',
    resourceId: paymentId,
    newValues: { bill_id: id, amount: data.amount, newStatus },
    ipAddress: c.req.header('CF-Connecting-IP'),
    userAgent: c.req.header('User-Agent'),
  });

  return c.json({ id: paymentId, status: newStatus }, 201);
});

// DELETE /api/v1/bills/:id/payments/:paymentId
router.delete('/:id/payments/:paymentId', requireRole('owner'), async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const paymentId = c.req.param('paymentId');

  const payment = await c.env.DB.prepare(
    `SELECT id, amount FROM payments_made WHERE id = ? AND bill_id = ?`
  ).bind(paymentId, id).first<{ id: string; amount: number }>();
  if (!payment) return c.json({ error: 'Payment not found' }, 404);

  const bill = await c.env.DB.prepare(
    `SELECT id, total, amount_paid, status FROM bills WHERE id = ?`
  ).bind(id).first<{ id: string; total: number; amount_paid: number; status: string }>();
  if (!bill) return c.json({ error: 'Bill not found' }, 404);

  await c.env.DB.prepare('DELETE FROM payments_made WHERE id = ?').bind(paymentId).run();

  const newPaid = Math.max(0, bill.amount_paid - payment.amount);
  const newStatus = newPaid >= bill.total ? 'paid' : newPaid > 0 ? 'partial' : 'pending';
  await c.env.DB.prepare(
    `UPDATE bills SET amount_paid = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).bind(newPaid, newStatus, id).run();

  await writeAudit(c.env, {
    userId: user.id,
    action: 'payment.deleted',
    resourceType: 'payment_made',
    resourceId: paymentId,
    oldValues: { bill_id: id, amount: payment.amount, status: bill.status },
    newValues: { amount_paid: newPaid, status: newStatus },
    ipAddress: c.req.header('CF-Connecting-IP'),
    userAgent: c.req.header('User-Agent'),
  });

  return c.json({ ok: true });
});

export { router as billRoutes };
