import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { requireRole } from '../middleware/rbac';
import { writeAudit } from '../middleware/audit';
import { calculateTotals, penceToDecimal, vatOnNet } from '../services/money';
import { markOverdue } from '../services/invoiceStatus';
import { deleteDocumentPayment, recordDocumentPayment } from '../services/recordPayment';
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
  await markOverdue(c.env.DB);
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
    `SELECT i.id, i.invoice_number, i.status, i.source, i.vat_for_invoice_id, i.issue_date, i.due_date,
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
  await markOverdue(c.env.DB);
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

  // A VAT-only invoice names the invoice it charges VAT on; an invoice lists its VAT-only invoices
  const { results: links } = await c.env.DB.prepare(
    `SELECT id, invoice_number, status, issue_date, total, vat_for_invoice_id FROM invoices
     WHERE (id = (SELECT vat_for_invoice_id FROM invoices WHERE id = ?)) OR vat_for_invoice_id = ?
     ORDER BY issue_date ASC, created_at ASC`
  ).bind(id, id).all<{ id: string; invoice_number: string; status: string; issue_date: string; total: number; vat_for_invoice_id: string | null }>();
  const vatFor = links.find(l => l.vat_for_invoice_id !== id) ?? null;
  const vatInvoices = links.filter(l => l.vat_for_invoice_id === id);

  return c.json({
    ...invoice, items: items.results, payments: payments.results,
    vat_for: vatFor && { id: vatFor.id, invoice_number: vatFor.invoice_number, issue_date: vatFor.issue_date },
    vat_invoices: vatInvoices.map(({ vat_for_invoice_id: _v, ...rest }) => rest),
  });
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

type PdfInvoice = {
  id: string; invoice_number: string; issue_date: string; due_date: string;
  subtotal: number; tax_amount: number; total: number; notes: string | null;
  client_name: string; client_address: string | null; vat_for_invoice_id?: string | null;
};

/** Draws the invoice's PDF from its saved lines and the company settings, stores it in R2 and returns the key. */
async function storeInvoicePdf(env: Env, invoice: PdfInvoice): Promise<string> {
  const [items, settings] = await Promise.all([
    env.DB.prepare(
      `SELECT description, quantity, unit_price, tax_rate
       FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order ASC`
    ).bind(invoice.id).all<{ description: string; quantity: number; unit_price: number; tax_rate: number }>(),
    env.DB.prepare('SELECT * FROM company_settings WHERE id = 1')
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
    const obj = await env.R2.get(settings.logo_r2_key);
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
      title: invoice.vat_for_invoice_id ? 'VAT INVOICE' : undefined,
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

  const r2Key = `invoices/${invoice.id}/${invoice.invoice_number}.pdf`;
  await uploadToR2(env.R2, r2Key, pdfBytes.buffer as ArrayBuffer, 'application/pdf');
  return r2Key;
}

const ukDate = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

const VatInvoiceSchema = z.object({
  rate:       z.number().gt(0).max(1).default(0.20),
  // The net sale the VAT is charged on, in pence (defaults to the whole invoice)
  net:        z.number().int().positive().optional(),
  issue_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  due_date:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

// POST /api/v1/invoices/:id/vat-invoice — after VAT registration, charge the VAT on a sale that was
// invoiced without it. Makes a separate, numbered VAT-only invoice (net £0, VAT only) linked to the
// original, so no new sale is recorded. It's issued straight away with its own PDF.
router.post('/:id/vat-invoice', requireRole('owner'), zValidator('json', VatInvoiceSchema), async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const data = c.req.valid('json');

  const original = await c.env.DB.prepare(
    `SELECT i.id, i.invoice_number, i.status, i.client_id, i.issue_date, i.subtotal, i.tax_amount,
            i.vat_for_invoice_id, c.name AS client_name, c.address AS client_address
     FROM invoices i JOIN clients c ON c.id = i.client_id WHERE i.id = ?`
  ).bind(id).first<{
    id: string; invoice_number: string; status: string; client_id: string; issue_date: string;
    subtotal: number; tax_amount: number; vat_for_invoice_id: string | null;
    client_name: string; client_address: string | null;
  }>();
  if (!original) return c.json({ error: 'Not found' }, 404);
  if (original.vat_for_invoice_id) return c.json({ error: 'This is already a VAT-only invoice' }, 409);
  if (original.status === 'draft') return c.json({ error: 'Finalise the invoice first, or add VAT to its lines instead' }, 409);
  if (original.status === 'void') return c.json({ error: 'This invoice is void' }, 409);
  if (original.tax_amount > 0) return c.json({ error: 'This invoice already charges VAT' }, 409);
  const existing = await c.env.DB.prepare(
    `SELECT invoice_number FROM invoices WHERE vat_for_invoice_id = ? AND status != 'void' LIMIT 1`
  ).bind(id).first<{ invoice_number: string }>();
  if (existing) return c.json({ error: `VAT for this invoice is already charged on ${existing.invoice_number}` }, 409);

  const settings = await c.env.DB.prepare('SELECT vat_number FROM company_settings WHERE id = 1')
    .first<{ vat_number: string | null }>();
  if (!settings?.vat_number?.trim()) {
    return c.json({ error: 'Add your VAT registration number in Settings → Company first: a VAT invoice must show it' }, 422);
  }

  const net = data.net ?? original.subtotal;
  if (net > original.subtotal) return c.json({ error: 'The net amount can’t be more than the invoice’s' }, 422);
  const vat = vatOnNet(net, data.rate);
  if (vat <= 0) return c.json({ error: 'There is no VAT to charge' }, 422);

  let invoice_number: string;
  try {
    invoice_number = await generateInvoiceNumber(c.env.DB);
  } catch {
    invoice_number = await generateInvoiceNumber(c.env.DB);
  }
  const newId = crypto.randomUUID().replace(/-/g, '');
  const ratePct = Math.round(data.rate * 10000) / 100;
  const netText = penceToDecimal(net).replace(/\B(?=(\d{3})+(?!\d))/g, ',');   // 380000 → "3,800.00"
  const description = `VAT at ${ratePct}% on £${netText} — invoice ${original.invoice_number} of ${ukDate(original.issue_date)}`;
  const notes = `VAT-only invoice. The goods or services were supplied and invoiced on ${original.invoice_number} `
    + `(${ukDate(original.issue_date)}); this invoice charges the VAT due on them following our VAT registration. `
    + 'No further supply is made.';

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO invoices
         (id, invoice_number, client_id, status, issue_date, due_date,
          subtotal, tax_amount, total, amount_paid, notes, vat_for_invoice_id, sent_at, created_by)
       VALUES (?, ?, ?, 'sent', ?, ?, 0, ?, ?, 0, ?, ?, CURRENT_TIMESTAMP, ?)`
    ).bind(newId, invoice_number, original.client_id, data.issue_date, data.due_date, vat, vat, notes, id, user.id),
    c.env.DB.prepare(
      `INSERT INTO invoice_items (id, invoice_id, description, quantity, unit_price, tax_rate, amount, sort_order)
       VALUES (?, ?, ?, 1, 0, ?, 0, 0)`
    ).bind(crypto.randomUUID().replace(/-/g, ''), newId, description, data.rate),
  ]);

  const r2Key = await storeInvoicePdf(c.env, {
    id: newId, invoice_number, issue_date: data.issue_date, due_date: data.due_date,
    subtotal: 0, tax_amount: vat, total: vat, notes,
    client_name: original.client_name, client_address: original.client_address, vat_for_invoice_id: id,
  });
  await c.env.DB.prepare('UPDATE invoices SET pdf_r2_key = ? WHERE id = ?').bind(r2Key, newId).run();

  await writeAudit(c.env, {
    userId: user.id,
    action: 'invoice.created',
    resourceType: 'invoice',
    resourceId: newId,
    newValues: { invoice_number, vat_for_invoice_id: id, net, rate: data.rate, tax_amount: vat },
    ipAddress: c.req.header('CF-Connecting-IP'),
    userAgent: c.req.header('User-Agent'),
  });

  return c.json({ id: newId, invoice_number, tax_amount: vat }, 201);
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
    notes: string | null; client_name: string; client_address: string | null; vat_for_invoice_id: string | null;
  }>();
  if (!invoice) return c.json({ error: 'Not found' }, 404);
  if (invoice.status !== 'draft') return c.json({ error: 'Already finalized' }, 422);

  const r2Key = await storeInvoicePdf(c.env, invoice);

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
// invoice imported from QuickBooks, or for a VAT-only invoice made elsewhere (it replaces the one
// LedgerLite drew). LedgerLite's other invoices get their PDF when finalised.
router.post('/:id/original-pdf', requireRole('owner'), async (c) => {
  const id = c.req.param('id');
  const invoice = await c.env.DB.prepare('SELECT invoice_number, source, vat_for_invoice_id FROM invoices WHERE id = ?')
    .bind(id).first<{ invoice_number: string; source: string; vat_for_invoice_id: string | null }>();
  if (!invoice) return c.json({ error: 'Not found' }, 404);
  if (invoice.source !== 'quickbooks' && !invoice.vat_for_invoice_id) {
    return c.json({ error: 'Only imported and VAT-only invoices take an uploaded PDF' }, 409);
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

  const vatOnly = await c.env.DB.prepare(
    `SELECT invoice_number FROM invoices WHERE vat_for_invoice_id = ? AND status != 'void' LIMIT 1`
  ).bind(id).first<{ invoice_number: string }>();
  if (vatOnly) {
    return c.json({ error: `VAT for this invoice is charged on ${vatOnly.invoice_number}. Void that first.` }, 409);
  }

  const payments = await c.env.DB.prepare(
    'SELECT COUNT(*) as n FROM payments_received WHERE invoice_id = ?'
  ).bind(id).first<{ n: number }>();
  if ((payments?.n ?? 0) > 0) {
    return c.json({ error: 'This invoice has payments. Undo the bank line, or delete the payment, before voiding it.' }, 409);
  }
  const matched = await c.env.DB.prepare(
    `SELECT COUNT(*) as n FROM transaction_matches WHERE invoice_id = ? AND status IN ('pending', 'posted')`
  ).bind(id).first<{ n: number }>();
  if ((matched?.n ?? 0) > 0) {
    return c.json({ error: 'This invoice is matched to a bank line. Remove the match before voiding it.' }, 409);
  }

  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM transaction_matches WHERE invoice_id = ? AND status = 'suggested'`).bind(id),
    c.env.DB.prepare(
      `UPDATE invoices SET status = 'void', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).bind(id),
  ]);

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

  const recorded = await recordDocumentPayment(c.env.DB, 'invoice', id, {
    amount: data.amount,
    payment_date: data.payment_date,
    method: data.method,
    reference: data.reference ?? null,
    notes: data.notes ?? null,
    userId: user.id,
  });
  if (!recorded.ok) return c.json({ error: recorded.error }, recorded.status);
  const paymentId = recorded.id;
  const newStatus = recorded.status;

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
  if (!id || !paymentId) return c.json({ error: 'Payment not found' }, 404);

  const removed = await deleteDocumentPayment(c.env.DB, 'invoice', id, paymentId);
  if (!removed.ok) return c.json({ error: removed.error }, removed.status);

  await writeAudit(c.env, {
    userId: user.id,
    action: 'payment.deleted',
    resourceType: 'payment_received',
    resourceId: paymentId,
    oldValues: { invoice_id: id, amount: removed.amount, status: removed.before.status },
    newValues: removed.after,
    ipAddress: c.req.header('CF-Connecting-IP'),
    userAgent: c.req.header('User-Agent'),
  });

  return c.json({ ok: true });
});

export { router as invoiceRoutes };
