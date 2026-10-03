import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { requireRole } from '../middleware/rbac';
import { writeAudit } from '../middleware/audit';
import { calculateTotals } from '../services/money';
import { generateInvoiceNumber } from '../services/invoiceNumber';
import { generateInvoicePdf } from '../services/pdfGenerator';
import { uploadToR2, getSignedUrl, getFileResponse } from '../services/r2';
import { checkUpload } from '../services/files';
import type { Env } from '../types';

const router = new Hono<{ Bindings: Env }>();

const ItemSchema = z.object({
  description: z.string().min(1).max(500),
  quantity:    z.number().positive(),
  unit_price:  z.number().int().min(0),
  tax_rate:    z.number().min(0).max(1).default(0.20),
});

const InvoiceSchema = z.object({
  client_id:  z.string().length(32),
  issue_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  due_date:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes:      z.string().max(1000).optional().nullable(),
  items:      z.array(ItemSchema).min(1),
});

// GET /api/v1/invoices
router.get('/', async (c) => {
  const status = c.req.query('status');
  const clientId = c.req.query('client_id');
  const from = c.req.query('from');
  const to = c.req.query('to');
  const clauses: string[] = [];
  const binds: unknown[] = [];
  if (status) { clauses.push('i.status = ?'); binds.push(status); }
  if (clientId) { clauses.push('i.client_id = ?'); binds.push(clientId); }
  if (from) { clauses.push('i.issue_date >= ?'); binds.push(from); }
  if (to) { clauses.push('i.issue_date <= ?'); binds.push(to); }
  if (c.req.query('source') === 'quickbooks') clauses.push(`i.source = 'quickbooks'`);
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const rows = await c.env.DB.prepare(
    `SELECT i.id, i.invoice_number, i.status, i.source, i.issue_date, i.due_date,
            i.subtotal, i.tax_amount, i.total, i.amount_paid, i.pdf_r2_key IS NOT NULL AS has_pdf,
            c.name as client_name, i.created_at
     FROM invoices i
     JOIN clients c ON c.id = i.client_id
     ${where}
     ORDER BY i.issue_date DESC, i.created_at DESC`
  ).bind(...binds).all();
  return c.json(rows.results);
});

// GET /api/v1/invoices/:id
router.get('/:id', async (c) => {
  const id = c.req.param('id');
  const invoice = await c.env.DB.prepare(
    `SELECT i.*, c.name as client_name, c.email as client_email, c.address as client_address
     FROM invoices i
     JOIN clients c ON c.id = i.client_id
     WHERE i.id = ?`
  ).bind(id).first();
  if (!invoice) return c.json({ error: 'Not found' }, 404);

  const items = await c.env.DB.prepare(
    `SELECT id, description, quantity, unit_price, tax_rate, amount, sort_order
     FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order ASC`
  ).bind(id).all();

  const payments = await c.env.DB.prepare(
    `SELECT id, amount, payment_date, method, reference, notes
     FROM payments_received WHERE invoice_id = ? ORDER BY payment_date DESC`
  ).bind(id).all();

  return c.json({ ...invoice, items: items.results, payments: payments.results });
});

// POST /api/v1/invoices — creates draft
router.post('/', requireRole('owner'), zValidator('json', InvoiceSchema), async (c) => {
  const user = c.get('user');
  const data = c.req.valid('json');

  const client = await c.env.DB.prepare('SELECT id FROM clients WHERE id = ? AND is_active = 1')
    .bind(data.client_id).first();
  if (!client) return c.json({ error: 'Client not found' }, 422);

  const totals = calculateTotals(data.items);

  let invoice_number: string;
  try {
    invoice_number = await generateInvoiceNumber(c.env.DB);
  } catch {
    invoice_number = await generateInvoiceNumber(c.env.DB);
  }

  const id = crypto.randomUUID().replace(/-/g, '');

  await c.env.DB.prepare(
    `INSERT INTO invoices
       (id, invoice_number, client_id, status, issue_date, due_date,
        subtotal, tax_amount, total, amount_paid, notes, created_by)
     VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, 0, ?, ?)`
  ).bind(
    id, invoice_number, data.client_id, data.issue_date, data.due_date,
    totals.subtotal, totals.tax_amount, totals.total,
    data.notes ?? null, user.id
  ).run();

  const inserts = data.items.map((item, i) => {
    const lineAmount = Math.round(item.quantity * item.unit_price);
    return c.env.DB.prepare(
      `INSERT INTO invoice_items
         (id, invoice_id, description, quantity, unit_price, tax_rate, amount, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      crypto.randomUUID().replace(/-/g, ''), id,
      item.description, item.quantity, item.unit_price, item.tax_rate, lineAmount, i
    );
  });
  await c.env.DB.batch(inserts);

  await writeAudit(c.env, {
    userId: user.id,
    action: 'invoice.created',
    resourceType: 'invoice',
    resourceId: id,
    newValues: { invoice_number, ...totals },
    ipAddress: c.req.header('CF-Connecting-IP'),
    userAgent: c.req.header('User-Agent'),
  });

  return c.json({ id, invoice_number }, 201);
});

// PATCH /api/v1/invoices/:id — update draft
router.patch('/:id', requireRole('owner'), zValidator('json', InvoiceSchema.partial()), async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const data = c.req.valid('json');

  const existing = await c.env.DB.prepare('SELECT id, status FROM invoices WHERE id = ?')
    .bind(id).first<{ id: string; status: string }>();
  if (!existing) return c.json({ error: 'Not found' }, 404);
  if (existing.status !== 'draft') return c.json({ error: 'Only draft invoices can be edited' }, 422);

  if (data.items) {
    const totals = calculateTotals(data.items);
    await c.env.DB.prepare(
      `UPDATE invoices SET subtotal = ?, tax_amount = ?, total = ?,
       issue_date = COALESCE(?, issue_date), due_date = COALESCE(?, due_date),
       notes = COALESCE(?, notes), updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).bind(
      totals.subtotal, totals.tax_amount, totals.total,
      data.issue_date ?? null, data.due_date ?? null, data.notes ?? null, id
    ).run();

    await c.env.DB.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').bind(id).run();
    const inserts = data.items.map((item, i) => {
      const lineAmount = Math.round(item.quantity * item.unit_price);
      return c.env.DB.prepare(
        `INSERT INTO invoice_items
           (id, invoice_id, description, quantity, unit_price, tax_rate, amount, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        crypto.randomUUID().replace(/-/g, ''), id,
        item.description, item.quantity, item.unit_price, item.tax_rate, lineAmount, i
      );
    });
    await c.env.DB.batch(inserts);
  } else {
    const fields: string[] = [];
    const vals: unknown[] = [];
    if (data.issue_date) { fields.push('issue_date = ?'); vals.push(data.issue_date); }
    if (data.due_date)   { fields.push('due_date = ?');   vals.push(data.due_date); }
    if (data.notes !== undefined) { fields.push('notes = ?'); vals.push(data.notes ?? null); }
    if (fields.length) {
      await c.env.DB.prepare(`UPDATE invoices SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .bind(...vals, id).run();
    }
  }

  await writeAudit(c.env, {
    userId: user.id,
    action: 'invoice.updated',
    resourceType: 'invoice',
    resourceId: id,
    newValues: data,
    ipAddress: c.req.header('CF-Connecting-IP'),
    userAgent: c.req.header('User-Agent'),
  });

  return c.json({ ok: true });
});

// PUT /api/v1/invoices/:id — full draft update
router.put('/:id', requireRole('owner'), zValidator('json', InvoiceSchema), async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const data = c.req.valid('json');

  const existing = await c.env.DB.prepare('SELECT id, status FROM invoices WHERE id = ?')
    .bind(id).first<{ id: string; status: string }>();
  if (!existing) return c.json({ error: 'Not found' }, 404);
  if (existing.status !== 'draft') return c.json({ error: 'Only draft invoices can be edited' }, 409);

  const client = await c.env.DB.prepare('SELECT id FROM clients WHERE id = ? AND is_active = 1')
    .bind(data.client_id).first();
  if (!client) return c.json({ error: 'Client not found' }, 422);

  const totals = calculateTotals(data.items);
  await c.env.DB.prepare(
    `UPDATE invoices
     SET client_id = ?, issue_date = ?, due_date = ?, notes = ?,
         subtotal = ?, tax_amount = ?, total = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).bind(
    data.client_id, data.issue_date, data.due_date, data.notes ?? null,
    totals.subtotal, totals.tax_amount, totals.total, id
  ).run();

  await c.env.DB.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').bind(id).run();
  const inserts = data.items.map((item, i) => {
    const lineAmount = Math.round(item.quantity * item.unit_price);
    return c.env.DB.prepare(
      `INSERT INTO invoice_items
         (id, invoice_id, description, quantity, unit_price, tax_rate, amount, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      crypto.randomUUID().replace(/-/g, ''), id,
      item.description, item.quantity, item.unit_price, item.tax_rate, lineAmount, i
    );
  });
  await c.env.DB.batch(inserts);

  await writeAudit(c.env, {
    userId: user.id,
    action: 'invoice.updated',
    resourceType: 'invoice',
    resourceId: id,
    newValues: { ...data, ...totals },
    ipAddress: c.req.header('CF-Connecting-IP'),
    userAgent: c.req.header('User-Agent'),
  });

  return c.json({ ok: true });
});

// POST /api/v1/invoices/:id/finalize — draft → sent, generates PDF
router.post('/:id/finalize', requireRole('owner'), async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');

  const invoice = await c.env.DB.prepare(
    `SELECT i.*, c.name as client_name, c.address as client_address
     FROM invoices i JOIN clients c ON c.id = i.client_id WHERE i.id = ?`
  ).bind(id).first<{
    id: string; status: string; invoice_number: string; issue_date: string; due_date: string;
    subtotal: number; tax_amount: number; total: number;
    notes: string | null; client_name: string; client_address: string | null;
  }>();
  if (!invoice) return c.json({ error: 'Not found' }, 404);
  if (invoice.status !== 'draft') return c.json({ error: 'Already finalized' }, 422);

  const [items, settings] = await Promise.all([
    c.env.DB.prepare(
      `SELECT description, quantity, unit_price, tax_rate
       FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order ASC`
    ).bind(id).all<{ description: string; quantity: number; unit_price: number; tax_rate: number }>(),
    c.env.DB.prepare('SELECT * FROM company_settings WHERE id = 1')
      .first<{
        company_name: string | null; company_reg_number: string | null; vat_number: string | null;
        address: string | null; email: string | null; phone: string | null;
        bank_account_name: string | null; bank_sort_code: string | null;
        bank_account_number: string | null; bank_name: string | null;
        logo_r2_key: string | null;
      }>(),
  ]);

  // Fetch logo bytes if available
  let logoBytes: ArrayBuffer | null = null;
  let logoContentType: string | null = null;
  if (settings?.logo_r2_key) {
    const obj = await c.env.R2.get(settings.logo_r2_key);
    if (obj) {
      logoBytes = await obj.arrayBuffer();
      logoContentType = obj.httpMetadata?.contentType ?? 'image/png';
    }
  }

  const pdfBytes = await generateInvoicePdf(
    {
      invoice_number: invoice.invoice_number,
      issue_date: invoice.issue_date,
      due_date: invoice.due_date,
      client_name: invoice.client_name,
      client_address: invoice.client_address ?? undefined,
      items: items.results,
      subtotal: invoice.subtotal,
      tax_amount: invoice.tax_amount,
      total: invoice.total,
      notes: invoice.notes ?? undefined,
    },
    {
      company_name:        settings?.company_name,
      company_reg_number:  settings?.company_reg_number,
      vat_number:          settings?.vat_number,
      address:             settings?.address,
      email:               settings?.email,
      phone:               settings?.phone,
      bank_account_name:   settings?.bank_account_name,
      bank_sort_code:      settings?.bank_sort_code,
      bank_account_number: settings?.bank_account_number,
      bank_name:           settings?.bank_name,
      logo_bytes:          logoBytes,
      logo_content_type:   logoContentType,
    }
  );

  const r2Key = `invoices/${id}/${invoice.invoice_number}.pdf`;
  await uploadToR2(c.env.R2, r2Key, pdfBytes.buffer as ArrayBuffer, 'application/pdf');

  await c.env.DB.prepare(
    `UPDATE invoices SET status = 'sent', pdf_r2_key = ?, sent_at = CURRENT_TIMESTAMP,
     updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).bind(r2Key, id).run();

  await writeAudit(c.env, {
    userId: user.id,
    action: 'invoice.updated',
    resourceType: 'invoice',
    resourceId: id,
    newValues: { status: 'sent' },
    ipAddress: c.req.header('CF-Connecting-IP'),
    userAgent: c.req.header('User-Agent'),
  });

  return c.json({ ok: true });
});

// POST /api/v1/invoices/:id/original-pdf — attach the PDF a customer actually received for an
// invoice imported from QuickBooks. LedgerLite's own invoices get their PDF when finalised.
router.post('/:id/original-pdf', requireRole('owner'), async (c) => {
  const id = c.req.param('id');
  const invoice = await c.env.DB.prepare('SELECT invoice_number, source FROM invoices WHERE id = ?')
    .bind(id).first<{ invoice_number: string; source: string }>();
  if (!invoice) return c.json({ error: 'Not found' }, 404);
  if (invoice.source !== 'quickbooks') {
    return c.json({ error: 'Only imported invoices take an uploaded PDF' }, 409);
  }

  const form = await c.req.formData().catch(() => null);
  const checked = await checkUpload(form?.get('file') ?? null, ['application/pdf'], 10 * 1024 * 1024);
  if (!checked.ok) return c.json({ error: checked.error }, 400);

  const key = `invoices/${id}/original.pdf`;
  await uploadToR2(c.env.R2, key, checked.bytes, checked.type);
  await c.env.DB.prepare(
    `UPDATE invoices SET pdf_r2_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).bind(key, id).run();

  await writeAudit(c.env, {
    userId: c.get('user').id, action: 'invoice.updated', resourceType: 'invoice', resourceId: id,
    newValues: { original_pdf: checked.name },
    ipAddress: c.req.header('CF-Connecting-IP'), userAgent: c.req.header('User-Agent'),
  });
  return c.json({ ok: true, invoiceNumber: invoice.invoice_number });
});

// GET /api/v1/invoices/:id/pdf
router.get('/:id/pdf', async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    `SELECT pdf_r2_key, invoice_number FROM invoices WHERE id = ?`
  ).bind(id).first<{ pdf_r2_key: string | null; invoice_number: string }>();
  if (!row || !row.pdf_r2_key) return c.json({ error: 'PDF not available' }, 404);
  const signed = await getSignedUrl(c.env.R2, row.pdf_r2_key, 900);
  if (!signed) {
    return getFileResponse(c as never, row.pdf_r2_key, `${row.invoice_number}.pdf`);
  }
  return c.json({ url: signed, expires_in: 900, filename: `${row.invoice_number}.pdf` });
});

// POST /api/v1/invoices/:id/void
router.post('/:id/void', requireRole('owner'), async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');

  const existing = await c.env.DB.prepare('SELECT id, status FROM invoices WHERE id = ?')
    .bind(id).first<{ id: string; status: string }>();
  if (!existing) return c.json({ error: 'Not found' }, 404);
  if (existing.status === 'void') return c.json({ error: 'Already voided' }, 422);

  await c.env.DB.prepare(
    `UPDATE invoices SET status = 'void', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).bind(id).run();

  await writeAudit(c.env, {
    userId: user.id,
    action: 'invoice.voided',
    resourceType: 'invoice',
    resourceId: id,
    ipAddress: c.req.header('CF-Connecting-IP'),
    userAgent: c.req.header('User-Agent'),
  });

  return c.json({ ok: true });
});

// DELETE /api/v1/invoices/:id — draft-only soft delete (void)
router.delete('/:id', requireRole('owner'), async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');

  const existing = await c.env.DB.prepare('SELECT id, status FROM invoices WHERE id = ?')
    .bind(id).first<{ id: string; status: string }>();
  if (!existing) return c.json({ error: 'Not found' }, 404);
  if (existing.status !== 'draft') return c.json({ error: 'Only draft invoices can be deleted' }, 409);

  await c.env.DB.prepare(
    `UPDATE invoices SET status = 'void', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).bind(id).run();

  await writeAudit(c.env, {
    userId: user.id,
    action: 'invoice.voided',
    resourceType: 'invoice',
    resourceId: id,
    oldValues: { status: existing.status },
    newValues: { status: 'void' },
    ipAddress: c.req.header('CF-Connecting-IP'),
    userAgent: c.req.header('User-Agent'),
  });

  return c.json({ ok: true });
});

// POST /api/v1/invoices/:id/payments
const PaymentSchema = z.object({
  amount:       z.number().int().positive(),
  payment_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  method:       z.enum(['bank_transfer', 'card', 'cash', 'cheque', 'other']),
  reference:    z.string().max(100).optional().nullable(),
  notes:        z.string().max(500).optional().nullable(),
});

router.post('/:id/payments', requireRole('owner'), zValidator('json', PaymentSchema), async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const data = c.req.valid('json');

  const invoice = await c.env.DB.prepare(
    `SELECT id, status, total, amount_paid FROM invoices WHERE id = ?`
  ).bind(id).first<{ id: string; status: string; total: number; amount_paid: number }>();
  if (!invoice) return c.json({ error: 'Not found' }, 404);
  if (!['sent', 'partial', 'overdue'].includes(invoice.status)) {
    return c.json({ error: 'Invoice cannot receive payments in current status' }, 422);
  }

  const newPaid = invoice.amount_paid + data.amount;
  if (newPaid > invoice.total) {
    return c.json({ error: 'Payment exceeds invoice total' }, 422);
  }

  const paymentId = crypto.randomUUID().replace(/-/g, '');
  await c.env.DB.prepare(
    `INSERT INTO payments_received (id, invoice_id, amount, payment_date, method, reference, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(paymentId, id, data.amount, data.payment_date, data.method,
    data.reference ?? null, data.notes ?? null, user.id).run();

  const newStatus = newPaid >= invoice.total ? 'paid'
    : newPaid > 0 ? 'partial'
    : invoice.status;

  await c.env.DB.prepare(
    `UPDATE invoices SET amount_paid = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).bind(newPaid, newStatus, id).run();

  await writeAudit(c.env, {
    userId: user.id,
    action: 'payment.created',
    resourceType: 'payment_received',
    resourceId: paymentId,
    newValues: { invoice_id: id, amount: data.amount, newStatus },
    ipAddress: c.req.header('CF-Connecting-IP'),
    userAgent: c.req.header('User-Agent'),
  });

  return c.json({ id: paymentId, status: newStatus }, 201);
});

router.delete('/:id/payments/:paymentId', requireRole('owner'), async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const paymentId = c.req.param('paymentId');

  const payment = await c.env.DB.prepare(
    `SELECT id, amount FROM payments_received WHERE id = ? AND invoice_id = ?`
  ).bind(paymentId, id).first<{ id: string; amount: number }>();
  if (!payment) return c.json({ error: 'Payment not found' }, 404);

  const invoice = await c.env.DB.prepare(
    `SELECT id, total, amount_paid, status FROM invoices WHERE id = ?`
  ).bind(id).first<{ id: string; total: number; amount_paid: number; status: string }>();
  if (!invoice) return c.json({ error: 'Invoice not found' }, 404);

  await c.env.DB.prepare('DELETE FROM payments_received WHERE id = ?').bind(paymentId).run();

  const newPaid = Math.max(0, invoice.amount_paid - payment.amount);
  const newStatus = newPaid >= invoice.total ? 'paid'
    : newPaid > 0 ? 'partial'
    : 'sent';
  await c.env.DB.prepare(
    `UPDATE invoices SET amount_paid = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).bind(newPaid, newStatus, id).run();

  await writeAudit(c.env, {
    userId: user.id,
    action: 'payment.deleted',
    resourceType: 'payment_received',
    resourceId: paymentId,
    oldValues: { invoice_id: id, amount: payment.amount, status: invoice.status },
    newValues: { amount_paid: newPaid, status: newStatus },
    ipAddress: c.req.header('CF-Connecting-IP'),
    userAgent: c.req.header('User-Agent'),
  });

  return c.json({ ok: true });
});

export { router as invoiceRoutes };
