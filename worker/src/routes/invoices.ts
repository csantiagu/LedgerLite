import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { requireRole } from '../middleware/rbac';
import { actorOf, auditStatement, changedFields } from '../middleware/audit';
import { checkCreditLines } from '../services/creditNote';
import { calculateTotals, isVatRate, parsePenceText, penceToDecimal, vatOnNet } from '../services/money';
import { markOverdue } from '../services/invoiceStatus';
import { deleteDocumentPayment, paymentExistsSql, recordDocumentPayment } from '../services/recordPayment';
import { generateInvoiceNumber, numberStillNext, peekNumber, takeNumber } from '../services/invoiceNumber';
import { generateInvoicePdf } from '../services/pdfGenerator';
import { uploadToR2, getSignedUrl, getFileResponse } from '../services/r2';
import { checkUpload } from '../services/files';
import { checkOpen } from '../services/periods';
import type { Env } from '../types';
import type { D1Database } from '@cloudflare/workers-types';

const router = new Hono<{ Bindings: Env }>();

const ItemSchema = z.object({
  description: z.string().min(1).max(500),
  quantity:    z.number().positive(),
  unit_price:  z.number().int().min(0),
  tax_rate:    z.number().refine(isVatRate, 'VAT must be 0%, 5% or 20%').default(0.20),
});

const VatTreatment = z.enum(['standard', 'outside_scope']);

/** Lines on an invoice outside the scope of UK VAT (services to a customer abroad) carry no VAT. */
const outsideScopeProblem = (treatment: string, items: Array<{ tax_rate: number }>) =>
  treatment === 'outside_scope' && items.some(i => i.tax_rate !== 0)
    ? 'This invoice is outside the scope of UK VAT (a customer outside the UK): set VAT to 0% on every line'
    : null;

const OUTSIDE_SCOPE_NOTE = 'Outside the scope of UK VAT: services supplied to a customer outside the UK.';

const InvoiceSchema = z.object({
  client_id:  z.string().length(32),
  vat_treatment: VatTreatment.optional(),
  issue_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  due_date:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes:      z.string().max(1000).optional().nullable(),
  items:      z.array(ItemSchema).min(1),
});

type DraftItem = z.infer<typeof ItemSchema>;

/**
 * Writes a draft in one batch. The update must end in `WHERE id = ?`; `AND status = 'draft'`
 * is added here, and line replacement only runs while that is still true. Returns false when
 * the invoice was sent (or otherwise left draft) before the batch ran.
 */
async function writeDraft(
  db: D1Database,
  invoiceId: string,
  updateSql: string,
  updateBinds: unknown[],
  items: DraftItem[] | null,
  /** Audit rows, written only while the invoice is still a draft */
  audit: D1PreparedStatement[] = [],
): Promise<boolean> {
  const statements = [
    db.prepare(`${updateSql} AND status = 'draft'`).bind(...updateBinds),
  ];
  if (items) {
    statements.push(db.prepare(
      `DELETE FROM invoice_items WHERE invoice_id = ?
       AND EXISTS (SELECT 1 FROM invoices WHERE id = ? AND status = 'draft')`
    ).bind(invoiceId, invoiceId));
    for (const [i, item] of items.entries()) {
      statements.push(db.prepare(
        `INSERT INTO invoice_items
           (id, invoice_id, description, quantity, unit_price, tax_rate, amount, sort_order)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM invoices WHERE id = ? AND status = 'draft')`
      ).bind(
        crypto.randomUUID().replace(/-/g, ''), invoiceId,
        item.description, item.quantity, item.unit_price, item.tax_rate,
        Math.round(item.quantity * item.unit_price), i, invoiceId,
      ));
    }
  }
  await db.batch([...statements, ...audit]);
  const row = await db.prepare('SELECT status FROM invoices WHERE id = ?')
    .bind(invoiceId).first<{ status: string }>();
  return row?.status === 'draft';
}

// Status groups the list can filter by, besides a single status
const STATUS_GROUPS: Record<string, string[]> = {
  unpaid: ['sent', 'partial', 'overdue'],
};
const STATUSES = ['draft', 'sent', 'partial', 'paid', 'void', 'overdue'];

// Sortable columns (whitelisted: never put a query value straight into SQL)
const SORTS: Record<string, string> = {
  issue_date: 'i.issue_date',
  due_date:   'i.due_date',
  number:     'i.invoice_number',
  client:     'c.name COLLATE NOCASE',
  total:      'i.total',
  balance:    'i.total - i.amount_paid',
  status:     'i.status',
};

// GET /api/v1/invoices
// Query: status (draft|sent|partial|paid|void|overdue|unpaid), client_id, from/to (issue date),
// q (number, client name or amount), source=quickbooks, vat_only=1, sort (issue_date|due_date|
// number|client|total|balance|status) + dir (asc|desc). Without sort, drafts come first, then the
// newest. With page (from 1) and pageSize (≤ 200) the answer is { rows, total, page, pageSize,
// counts } (counts per status for the other filters); without, a plain array of every match.
router.get('/', async (c) => {
  await markOverdue(c.env.DB);
  const status = c.req.query('status');
  const clientId = c.req.query('client_id');
  const from = c.req.query('from');
  const to = c.req.query('to');
  const q = c.req.query('q')?.trim();
  const page = c.req.query('page') ? Math.max(1, Number.parseInt(c.req.query('page')!, 10) || 1) : null;
  const pageSize = Math.min(200, Math.max(1, Number.parseInt(c.req.query('pageSize') ?? '50', 10) || 50));
  const sortKey = c.req.query('sort');
  const dir = c.req.query('dir') === 'asc' ? 'ASC' : 'DESC';

  // Everything but the status filter, so the counts can show what each status would give
  const clauses: string[] = [];
  const binds: unknown[] = [];
  if (clientId) { clauses.push('i.client_id = ?'); binds.push(clientId); }
  if (from) { clauses.push('i.issue_date >= ?'); binds.push(from); }
  if (to) { clauses.push('i.issue_date <= ?'); binds.push(to); }
  if (c.req.query('source') === 'quickbooks') clauses.push(`i.source = 'quickbooks'`);
  if (c.req.query('vat_only') === '1') clauses.push('i.vat_for_invoice_id IS NOT NULL');
  if (c.req.query('kind') === 'credit_note') clauses.push(`i.kind = 'credit_note'`);
  if (c.req.query('kind') === 'invoice') clauses.push(`i.kind = 'invoice'`);
  if (q) {
    const text = ['i.invoice_number LIKE ?', 'c.name LIKE ?'];
    binds.push(`%${q}%`, `%${q}%`);
    const pence = parsePenceText(q);
    if (pence !== null) { text.push('i.total = ?'); binds.push(Math.abs(pence)); }
    clauses.push(`(${text.join(' OR ')})`);
  }
  const baseWhere = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const statusList = status ? (STATUS_GROUPS[status] ?? (STATUSES.includes(status) ? [status] : [])) : null;
  const where = statusList
    ? `${baseWhere ? `${baseWhere} AND` : 'WHERE'} i.status IN (${statusList.length ? statusList.map(() => '?').join(',') : 'NULL'})`
    : baseWhere;
  const whereBinds = statusList ? [...binds, ...statusList] : binds;

  const order = sortKey && SORTS[sortKey]
    ? `${SORTS[sortKey]} ${dir}, i.created_at DESC`
    : `CASE WHEN i.status = 'draft' THEN 0 ELSE 1 END, i.issue_date DESC, i.created_at DESC`;

  const rows = await c.env.DB.prepare(
    `SELECT i.id, i.invoice_number, i.status, i.source, i.vat_for_invoice_id, i.kind, i.credits_invoice_id,
            i.vat_treatment, i.issue_date, i.due_date,
            (SELECT COALESCE(SUM(amount), 0) FROM credit_allocations WHERE invoice_id = i.id) AS credited,
            i.subtotal, i.tax_amount, i.total, i.amount_paid, i.pdf_r2_key IS NOT NULL AS has_pdf,
            i.client_id, c.name as client_name, i.created_at
     FROM invoices i
     JOIN clients c ON c.id = i.client_id
     ${where}
     ORDER BY ${order}
     ${page ? 'LIMIT ? OFFSET ?' : ''}`
  ).bind(...whereBinds, ...(page ? [pageSize, (page - 1) * pageSize] : [])).all();
  if (!page) return c.json(rows.results);

  const [count, byStatus] = await c.env.DB.batch<{ n?: number; status?: string }>([
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM invoices i JOIN clients c ON c.id = i.client_id ${where}`)
      .bind(...whereBinds),
    c.env.DB.prepare(
      `SELECT i.status, COUNT(*) AS n FROM invoices i JOIN clients c ON c.id = i.client_id ${baseWhere} GROUP BY i.status`
    ).bind(...binds),
  ]);
  const counts: Record<string, number> = { all: 0, unpaid: 0 };
  for (const r of byStatus.results) {
    counts[r.status!] = r.n!;
    counts.all += r.n!;
    if (STATUS_GROUPS.unpaid.includes(r.status!)) counts.unpaid += r.n!;
  }
  return c.json({ rows: rows.results, total: count.results[0]?.n ?? 0, page, pageSize, counts });
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

  // An invoice lists its credit notes; a credit note names the invoice it credits
  const { results: credits } = await c.env.DB.prepare(
    `SELECT i.id, i.invoice_number, i.status, i.issue_date, i.total, i.amount_paid, i.credit_reason,
            (SELECT COALESCE(SUM(amount), 0) FROM credit_allocations WHERE credit_note_id = i.id) AS applied
     FROM invoices i WHERE i.credits_invoice_id = ? ORDER BY i.issue_date, i.created_at`
  ).bind(id).all<{ id: string; invoice_number: string; status: string; issue_date: string; total: number; amount_paid: number; applied: number }>();
  const credited = (invoice as { credits_invoice_id: string | null }).credits_invoice_id
    ? await c.env.DB.prepare('SELECT id, invoice_number, issue_date, total FROM invoices WHERE id = ?')
        .bind((invoice as { credits_invoice_id: string }).credits_invoice_id).first()
    : null;
  const applied = (await c.env.DB.prepare(
    'SELECT COALESCE(SUM(amount), 0) AS n FROM credit_allocations WHERE credit_note_id = ? OR invoice_id = ?'
  ).bind(id, id).first<{ n: number }>())!.n;

  return c.json({
    ...invoice, items: items.results, payments: payments.results,
    vat_for: vatFor && { id: vatFor.id, invoice_number: vatFor.invoice_number, issue_date: vatFor.issue_date },
    vat_invoices: vatInvoices.map(({ vat_for_invoice_id: _v, ...rest }) => rest),
    credit_notes: credits,
    credits: credited,
    // Credit applied: on an invoice, from its credit notes; on a credit note, to the invoice it credits
    credit_applied: applied,
    credit_left: (invoice as { kind: string }).kind === 'credit_note'
      ? (invoice as { total: number }).total - (invoice as { amount_paid: number }).amount_paid : null,
  });
});

// POST /api/v1/invoices — creates draft
router.post('/', requireRole('owner'), zValidator('json', InvoiceSchema), async (c) => {
  const user = c.get('user');
  const data = c.req.valid('json');

  const client = await c.env.DB.prepare('SELECT id, vat_treatment FROM clients WHERE id = ? AND is_active = 1')
    .bind(data.client_id).first<{ id: string; vat_treatment: string }>();
  if (!client) return c.json({ error: 'Client not found' }, 422);
  // An overseas client's invoices are outside the scope of UK VAT unless the request says otherwise
  const treatment = data.vat_treatment ?? client.vat_treatment;
  const scopeProblem = outsideScopeProblem(treatment, data.items);
  if (scopeProblem) return c.json({ error: scopeProblem }, 422);

  const totals = calculateTotals(data.items);

  let invoice_number: string;
  try {
    invoice_number = await generateInvoiceNumber(c.env.DB);
  } catch {
    invoice_number = await generateInvoiceNumber(c.env.DB);
  }

  const id = crypto.randomUUID().replace(/-/g, '');

  const insertInvoice = c.env.DB.prepare(
    `INSERT INTO invoices
       (id, invoice_number, client_id, status, issue_date, due_date,
        subtotal, tax_amount, total, amount_paid, notes, vat_treatment, created_by)
     VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, 0, ?, ?, ?)`
  ).bind(
    id, invoice_number, data.client_id, data.issue_date, data.due_date,
    totals.subtotal, totals.tax_amount, totals.total,
    data.notes ?? null, treatment, user.id
  );

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
  await c.env.DB.batch([
    insertInvoice,
    ...inserts,
    auditStatement(c.env.DB, actorOf(c), {
      action: 'invoice.created', resourceType: 'invoice', resourceId: id,
      newValues: {
        invoice_number, client_id: data.client_id, issue_date: data.issue_date, due_date: data.due_date,
        vat_treatment: treatment, ...totals, items: auditItems(data.items),
      },
      summary: `Created draft ${invoice_number}`,
    }),
  ]);

  return c.json({ id, invoice_number }, 201);
});

// PATCH /api/v1/invoices/:id — update draft
router.patch('/:id', requireRole('owner'), zValidator('json', InvoiceSchema.partial()), async (c) => {
  const id = c.req.param('id');
  const data = c.req.valid('json');

  const existing = await draftSnapshot(c.env.DB, id);
  if (!existing) return c.json({ error: 'Not found' }, 404);
  if (existing.status !== 'draft') return c.json({ error: 'Only draft invoices can be edited' }, 422);
  const treatment = data.vat_treatment ?? existing.vat_treatment;
  const scopeProblem = outsideScopeProblem(treatment, data.items ?? existing.items);
  if (scopeProblem) return c.json({ error: scopeProblem }, 422);
  // PATCH never changes the client, so it isn't compared
  const { client_id: _client, ...patch } = data;
  const audit = draftAudit(c, existing, {
    ...patch, ...(data.items && { ...calculateTotals(data.items), items: auditItems(data.items) }),
  });

  if (data.items) {
    const totals = calculateTotals(data.items);
    const saved = await writeDraft(
      c.env.DB, id,
      `UPDATE invoices SET subtotal = ?, tax_amount = ?, total = ?,
       issue_date = COALESCE(?, issue_date), due_date = COALESCE(?, due_date),
       notes = COALESCE(?, notes), vat_treatment = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [totals.subtotal, totals.tax_amount, totals.total,
        data.issue_date ?? null, data.due_date ?? null, data.notes ?? null, treatment, id],
      data.items,
      audit,
    );
    if (!saved) return c.json({ error: 'Only draft invoices can be edited' }, 422);
  } else {
    const fields: string[] = [];
    const vals: unknown[] = [];
    if (data.vat_treatment) { fields.push('vat_treatment = ?'); vals.push(data.vat_treatment); }
    if (data.issue_date) { fields.push('issue_date = ?'); vals.push(data.issue_date); }
    if (data.due_date)   { fields.push('due_date = ?');   vals.push(data.due_date); }
    if (data.notes !== undefined) { fields.push('notes = ?'); vals.push(data.notes ?? null); }
    if (fields.length) {
      const saved = await writeDraft(
        c.env.DB, id,
        `UPDATE invoices SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [...vals, id],
        null,
        audit,
      );
      if (!saved) return c.json({ error: 'Only draft invoices can be edited' }, 422);
    }
  }

  return c.json({ ok: true });
});

// PUT /api/v1/invoices/:id — full draft update
router.put('/:id', requireRole('owner'), zValidator('json', InvoiceSchema), async (c) => {
  const id = c.req.param('id');
  const data = c.req.valid('json');

  const existing = await draftSnapshot(c.env.DB, id);
  if (!existing) return c.json({ error: 'Not found' }, 404);
  if (existing.status !== 'draft') return c.json({ error: 'Only draft invoices can be edited' }, 409);

  const client = await c.env.DB.prepare('SELECT id, vat_treatment FROM clients WHERE id = ? AND is_active = 1')
    .bind(data.client_id).first<{ id: string; vat_treatment: string }>();
  if (!client) return c.json({ error: 'Client not found' }, 422);
  // A change of client brings that client's VAT treatment, unless the request gives one
  const treatment = data.vat_treatment
    ?? (data.client_id === existing.client_id ? existing.vat_treatment : client.vat_treatment);
  const scopeProblem = outsideScopeProblem(treatment, data.items);
  if (scopeProblem) return c.json({ error: scopeProblem }, 422);

  const totals = calculateTotals(data.items);
  const saved = await writeDraft(
    c.env.DB, id,
    `UPDATE invoices
     SET client_id = ?, issue_date = ?, due_date = ?, notes = ?, vat_treatment = ?,
         subtotal = ?, tax_amount = ?, total = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [data.client_id, data.issue_date, data.due_date, data.notes ?? null, treatment,
      totals.subtotal, totals.tax_amount, totals.total, id],
    data.items,
    draftAudit(c, existing, {
      ...data, vat_treatment: treatment, notes: data.notes ?? null, ...totals, items: auditItems(data.items),
    }),
  );
  if (!saved) return c.json({ error: 'Only draft invoices can be edited' }, 409);

  return c.json({ ok: true });
});

type PdfInvoice = {
  id: string; invoice_number: string; issue_date: string; due_date: string;
  subtotal: number; tax_amount: number; total: number; notes: string | null;
  client_name: string; client_address: string | null; vat_for_invoice_id?: string | null;
  kind?: string; vat_treatment?: string;
  /** Lines to draw. Passed when the PDF is stored before the rows exist. */
  items?: Array<{ description: string; quantity: number; unit_price: number; tax_rate: number }>;
};

/** Draws the invoice's PDF from its saved lines and the company settings, stores it in R2 and returns the key. */
async function storeInvoicePdf(env: Env, invoice: PdfInvoice): Promise<string> {
  const [items, settings] = await Promise.all([
    invoice.items
      ? Promise.resolve({ results: invoice.items })
      : env.DB.prepare(
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
      notes: [invoice.notes, invoice.vat_treatment === 'outside_scope' ? OUTSIDE_SCOPE_NOTE : null]
        .filter(Boolean).join('\n\n') || undefined,
      title: invoice.kind === 'credit_note' ? 'CREDIT NOTE' : invoice.vat_for_invoice_id ? 'VAT INVOICE' : undefined,
      credit_note: invoice.kind === 'credit_note',
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
  rate:       z.number().refine(r => r > 0 && isVatRate(r), 'VAT must be 5% or 20%').default(0.2),
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
            i.vat_for_invoice_id, i.kind, i.vat_treatment, c.name AS client_name, c.address AS client_address
     FROM invoices i JOIN clients c ON c.id = i.client_id WHERE i.id = ?`
  ).bind(id).first<{
    id: string; invoice_number: string; status: string; client_id: string; issue_date: string;
    subtotal: number; tax_amount: number; vat_for_invoice_id: string | null; kind: string; vat_treatment: string;
    client_name: string; client_address: string | null;
  }>();
  if (!original) return c.json({ error: 'Not found' }, 404);
  if (original.vat_for_invoice_id) return c.json({ error: 'This is already a VAT-only invoice' }, 409);
  if (original.kind !== 'invoice') return c.json({ error: 'A credit note can’t have VAT charged on it' }, 409);
  if (original.vat_treatment === 'outside_scope') return c.json({ error: 'This invoice is outside the scope of UK VAT' }, 409);
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

  // Dated on the original supply even when that quarter is already reviewed: registration is often
  // approved months after its effective date, and the VAT for those supplies has to be invoiced back.
  const net = data.net ?? original.subtotal;
  if (net > original.subtotal) return c.json({ error: 'The net amount can’t be more than the invoice’s' }, 422);
  const vat = vatOnNet(net, data.rate);
  if (vat <= 0) return c.json({ error: 'There is no VAT to charge' }, 422);

  const newId = crypto.randomUUID().replace(/-/g, '');
  const ratePct = Math.round(data.rate * 10000) / 100;
  const netText = penceToDecimal(net).replace(/\B(?=(\d{3})+(?!\d))/g, ',');   // 380000 → "3,800.00"
  const description = `VAT at ${ratePct}% on £${netText} — invoice ${original.invoice_number} of ${ukDate(original.issue_date)}`;
  const notes = `VAT-only invoice. The goods or services were supplied and invoiced on ${original.invoice_number} `
    + `(${ukDate(original.issue_date)}); this invoice charges the VAT due on them following our VAT registration. `
    + 'No further supply is made.';
  const vatLine = { description, quantity: 1, unit_price: 0, tax_rate: data.rate };
  const db = c.env.DB;
  const actor = actorOf(c);

  // The number is only taken if the invoice is saved (see peekNumber); if another invoice takes it
  // first, nothing is written and the next number is tried
  let invoice_number = '';
  for (let attempt = 0; ; attempt++) {
    const next = await peekNumber(db, 'invoice');
    invoice_number = next.number;
    // The PDF is stored before the rows, so a failed upload leaves the books unchanged
    const r2Key = await storeInvoicePdf(c.env, {
      id: newId, invoice_number, issue_date: data.issue_date, due_date: data.due_date,
      subtotal: 0, tax_amount: vat, total: vat, notes, items: [vatLine],
      client_name: original.client_name, client_address: original.client_address, vat_for_invoice_id: id,
    });
    const free = numberStillNext('invoice', next.seq);
    let results: D1Result[];
    try {
      results = await db.batch([
        auditStatement(db, actor, {
          action: 'invoice.created', resourceType: 'invoice', resourceId: newId,
          newValues: { invoice_number, vat_for_invoice_id: id, net, rate: data.rate, tax_amount: vat, status: 'sent' },
          summary: `Issued VAT-only invoice ${invoice_number} for ${original.invoice_number}`,
        }, free),
        auditStatement(db, actor, {
          action: 'invoice.updated', resourceType: 'invoice', resourceId: id,
          newValues: { vat_invoice_id: newId, vat_invoice_number: invoice_number },
          summary: `VAT charged on ${invoice_number}`,
        }, free),
        db.prepare(
          `INSERT INTO invoices
             (id, invoice_number, client_id, status, issue_date, due_date,
              subtotal, tax_amount, total, amount_paid, notes, vat_for_invoice_id, pdf_r2_key, sent_at, created_by)
           SELECT ?, ?, ?, 'sent', ?, ?, 0, ?, ?, 0, ?, ?, ?, CURRENT_TIMESTAMP, ? WHERE ${free.sql}`
        ).bind(newId, invoice_number, original.client_id, data.issue_date, data.due_date, vat, vat, notes, id, r2Key, user.id, ...free.binds),
        db.prepare(
          `INSERT INTO invoice_items (id, invoice_id, description, quantity, unit_price, tax_rate, amount, sort_order)
           SELECT ?, ?, ?, 1, 0, ?, 0, 0 WHERE EXISTS (SELECT 1 FROM invoices WHERE id = ?)`
        ).bind(crypto.randomUUID().replace(/-/g, ''), newId, description, data.rate, newId),
        takeNumber(db, 'invoice', next.seq, newId),
      ]);
    } catch (err) {
      // A second request can pass the check above; the unique index lets only one live VAT invoice through
      if (/UNIQUE constraint failed: invoices\.vat_for_invoice_id/.test(String(err))) {
        const winner = await db.prepare(
          `SELECT invoice_number FROM invoices WHERE vat_for_invoice_id = ? AND status != 'void' LIMIT 1`
        ).bind(id).first<{ invoice_number: string }>();
        return c.json({
          error: `VAT for this invoice is already charged on ${winner?.invoice_number ?? 'another invoice'}`,
        }, 409);
      }
      throw err;
    }
    if (results[2]!.meta.changes) break;
    if (attempt >= 2) return c.json({ error: 'Invoices are being numbered by someone else right now; try again' }, 409);
  }

  return c.json({ id: newId, invoice_number, tax_amount: vat }, 201);
});

const CreditItemSchema = z.object({
  description: z.string().min(1).max(500),
  quantity:    z.number().positive(),
  unit_price:  z.number().int().min(0),
  // The invoice's own rate, which for a QuickBooks import need not be exactly 0%, 5% or 20%
  tax_rate:    z.number().min(0).max(1),
});

const CreditNoteSchema = z.object({
  issue_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reason:     z.string().trim().min(3, 'Say why the invoice is being credited').max(500),
  // The lines to credit; leave out to credit the whole invoice
  items:      z.array(CreditItemSchema).min(1).optional(),
  // Pence of VAT to credit, for a VAT-only invoice (its lines carry no net amount)
  vat_amount: z.number().int().positive().optional(),
});

// POST /api/v1/invoices/:id/credit-note — credit all or part of an issued invoice. The credit note
// takes the invoice's VAT rates and treatment, is issued straight away with its own number and PDF,
// and first reduces what the customer still owes on the invoice; any credit left can be refunded.
router.post('/:id/credit-note', requireRole('owner'), zValidator('json', CreditNoteSchema), async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const data = c.req.valid('json');
  const db = c.env.DB;

  const original = await db.prepare(
    `SELECT i.id, i.invoice_number, i.kind, i.status, i.client_id, i.issue_date, i.subtotal, i.tax_amount,
            i.total, i.amount_paid, i.vat_treatment, c.name AS client_name, c.address AS client_address
     FROM invoices i JOIN clients c ON c.id = i.client_id WHERE i.id = ?`
  ).bind(id).first<{
    id: string; invoice_number: string; kind: string; status: string; client_id: string; issue_date: string;
    subtotal: number; tax_amount: number; total: number; amount_paid: number; vat_treatment: string;
    client_name: string; client_address: string | null;
  }>();
  if (!original) return c.json({ error: 'Not found' }, 404);
  if (original.kind !== 'invoice') return c.json({ error: 'A credit note can’t itself be credited' }, 409);
  if (original.status === 'draft') return c.json({ error: 'A draft isn’t in the books yet: edit or delete it instead' }, 409);
  if (original.status === 'void') return c.json({ error: 'This invoice is void' }, 409);
  if (data.issue_date < original.issue_date) {
    return c.json({ error: 'A credit note can’t be dated before the invoice it credits' }, 422);
  }
  // Allowed in a reviewed quarter. The credit note's date is the period whose VAT it changes, which
  // is how VAT already sent to HMRC is corrected when the customer will not pay it.

  const [lines, alreadyCredited, priorLines] = await Promise.all([
    db.prepare('SELECT description, quantity, unit_price, tax_rate FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order')
      .bind(id).all<DraftItem>(),
    db.prepare(`SELECT COALESCE(SUM(total), 0) AS n FROM invoices WHERE credits_invoice_id = ? AND status != 'void'`)
      .bind(id).first<{ n: number }>(),
    db.prepare(`
      SELECT ii.quantity, ii.unit_price, ii.tax_rate
      FROM invoice_items ii JOIN invoices cn ON cn.id = ii.invoice_id
      WHERE cn.credits_invoice_id = ? AND cn.status != 'void'
    `).bind(id).all<DraftItem>(),
  ]);
  const creditable = original.total - alreadyCredited!.n;
  if (creditable <= 0) return c.json({ error: 'This invoice is already fully credited' }, 409);
  // A VAT-only invoice stores the VAT on the header and a zero-priced line, so crediting its lines
  // would total nothing. The amount credited is VAT, and it does not reduce the net sale.
  const vatOnly = original.subtotal === 0 && original.tax_amount > 0;
  let items: DraftItem[];
  let totals: { subtotal: number; tax_amount: number; total: number };
  if (vatOnly) {
    if (data.items) return c.json({ error: 'This invoice charges VAT only: say how much VAT to credit' }, 422);
    const amount = data.vat_amount ?? (alreadyCredited!.n === 0 ? original.total : undefined);
    if (amount === undefined) {
      return c.json({ error: 'Part of this VAT has already been credited: say how much VAT to credit' }, 422);
    }
    if (amount > creditable) {
      return c.json({ error: `Only £${penceToDecimal(creditable)} of this VAT is left to credit` }, 422);
    }
    items = [{
      description: `VAT credited — invoice ${original.invoice_number}`,
      quantity: 1, unit_price: 0, tax_rate: lines.results[0]?.tax_rate ?? 0.2,
    }];
    totals = { subtotal: 0, tax_amount: amount, total: amount };
  } else {
    if (data.vat_amount !== undefined) {
      return c.json({ error: 'Credit this invoice by its lines. A VAT amount is for a VAT-only invoice.' }, 422);
    }
    const chosen = data.items ?? (alreadyCredited!.n === 0 ? lines.results : null);
    if (!chosen) return c.json({ error: 'Part of this invoice is already credited: choose the lines and amounts to credit' }, 422);
    const rates = checkCreditLines(lines.results, priorLines.results, chosen);
    if (!rates.ok) return c.json({ error: rates.error }, 422);
    items = chosen;
    // A full credit takes the invoice's own totals: working them out again from the lines can be a
    // penny out (a QuickBooks line keeps its VAT rate to four decimals)
    totals = data.items
      ? calculateTotals(items)
      : { subtotal: original.subtotal, tax_amount: original.tax_amount, total: original.total };
    if (totals.total <= 0) return c.json({ error: 'There is nothing to credit' }, 422);
    if (totals.total > creditable) {
      return c.json({ error: `Only £${penceToDecimal(creditable)} of this invoice is left to credit` }, 422);
    }
  }
  // The credit first settles what's still owed on the invoice; the rest can be refunded
  const applied = Math.min(totals.total, Math.max(0, original.total - original.amount_paid));

  const cnId = crypto.randomUUID().replace(/-/g, '');
  const notes = `Credit note for invoice ${original.invoice_number} of ${ukDate(original.issue_date)}.\nReason: ${data.reason}`;
  const actor = actorOf(c);
  // The number is only taken if the credit note is saved (see peekNumber), so a refused or lost save
  // leaves no gap in the series; if another credit note takes it first, the next one is tried
  let invoice_number = '';
  for (let attempt = 0; ; attempt++) {
    const next = await peekNumber(db, 'credit_note');
    invoice_number = next.number;
    // Stored before the rows, so a failed upload does not leave a credit note the client will retry.
    const r2Key = await storeInvoicePdf(c.env, {
      id: cnId, invoice_number, issue_date: data.issue_date, due_date: data.issue_date,
      ...totals, notes, items, client_name: original.client_name, client_address: original.client_address,
      kind: 'credit_note', vat_treatment: original.vat_treatment,
    });

    // Checked inside the batch too: two credit notes racing can't credit more than the invoice, and
    // a payment landing meanwhile can't leave the applied credit larger than what's owed
    const free = numberStillNext('credit_note', next.seq);
    const fits = {
      sql: `(SELECT total FROM invoices WHERE id = ? AND status NOT IN ('void', 'draft'))
              - (SELECT COALESCE(SUM(total), 0) FROM invoices WHERE credits_invoice_id = ? AND status != 'void') >= ?
            AND (SELECT total - amount_paid FROM invoices WHERE id = ?) >= ?
            AND ${free.sql}`,
      binds: [id, id, totals.total, id, applied, ...free.binds],
    };
    const exists = { sql: 'EXISTS (SELECT 1 FROM invoices WHERE id = ?)', binds: [cnId] };
    const results = await db.batch([
      auditStatement(db, actor, {
        action: 'credit_note.created', resourceType: 'invoice', resourceId: cnId,
        newValues: {
          invoice_number, credits: original.invoice_number, issue_date: data.issue_date, reason: data.reason,
          ...totals, applied, items: auditItems(items),
        },
        summary: `Issued credit note ${invoice_number} for ${original.invoice_number}`,
      }, fits),
      auditStatement(db, actor, {
        action: 'invoice.credited', resourceType: 'invoice', resourceId: id,
        oldValues: { amount_paid: original.amount_paid },
        newValues: { creditNoteId: cnId, creditNote: invoice_number, credit: totals.total, applied },
        summary: `Credited by ${invoice_number}: ${data.reason}`,
      }, fits),
      db.prepare(`
        INSERT INTO invoices
          (id, invoice_number, client_id, status, issue_date, due_date, subtotal, tax_amount, total, amount_paid,
           notes, kind, credits_invoice_id, credit_reason, vat_treatment, pdf_r2_key, sent_at, created_by)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'credit_note', ?, ?, ?, ?, CURRENT_TIMESTAMP, ?
        WHERE ${fits.sql}
      `).bind(
        cnId, invoice_number, original.client_id, applied >= totals.total ? 'paid' : 'sent',
        data.issue_date, data.issue_date, totals.subtotal, totals.tax_amount, totals.total, applied,
        notes, id, data.reason, original.vat_treatment, r2Key, user.id, ...fits.binds,
      ),
      ...items.map((item, i) => db.prepare(`
        INSERT INTO invoice_items (id, invoice_id, description, quantity, unit_price, tax_rate, amount, sort_order)
        SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${exists.sql}
      `).bind(
        crypto.randomUUID().replace(/-/g, ''), cnId, item.description, item.quantity, item.unit_price, item.tax_rate,
        Math.round(item.quantity * item.unit_price), i, ...exists.binds,
      )),
      ...(applied > 0 ? [
        db.prepare(`
          INSERT INTO credit_allocations (credit_note_id, invoice_id, amount, created_by)
          SELECT ?, ?, ?, ? WHERE ${exists.sql}
        `).bind(cnId, id, applied, user.id, ...exists.binds),
        db.prepare(`
          UPDATE invoices SET amount_paid = amount_paid + ?,
            status = CASE WHEN amount_paid + ? >= total THEN 'paid'
                          WHEN due_date < date('now') THEN 'overdue' ELSE 'partial' END,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND ${exists.sql}
        `).bind(applied, applied, id, ...exists.binds),
      ] : []),
      takeNumber(db, 'credit_note', next.seq, cnId),
    ]);
    if (results[2]!.meta.changes) break;
    // Not saved: either another credit note took this number (try the next), or the invoice changed
    const moved = (await peekNumber(db, 'credit_note')).seq !== next.seq;
    if (!moved || attempt >= 2) {
      return c.json({ error: 'The invoice was paid or credited meanwhile; refresh and try again' }, 409);
    }
  }

  return c.json({ id: cnId, invoice_number, total: totals.total, applied, credit_left: totals.total - applied }, 201);
});

// POST /api/v1/invoices/:id/finalize — draft → sent, generates PDF
router.post('/:id/finalize', requireRole('owner'), async (c) => {
  const id = c.req.param('id');

  const invoice = await c.env.DB.prepare(
    `SELECT i.*, c.name as client_name, c.address as client_address
     FROM invoices i JOIN clients c ON c.id = i.client_id WHERE i.id = ?`
  ).bind(id).first<{
    id: string; status: string; invoice_number: string; issue_date: string; due_date: string;
    subtotal: number; tax_amount: number; total: number;
    notes: string | null; client_name: string; client_address: string | null; vat_for_invoice_id: string | null;
    kind: string; vat_treatment: string;
  }>();
  if (!invoice) return c.json({ error: 'Not found' }, 404);
  if (invoice.status !== 'draft') return c.json({ error: 'Already finalized' }, 422);
  // A draft isn't in the books; finalising puts it there on its issue date
  const locked = await checkOpen(c.env.DB, invoice.issue_date);
  if (locked) return c.json({ error: locked.error }, locked.status);

  const r2Key = await storeInvoicePdf(c.env, invoice);

  // Recorded only by the request that actually finalises it (it runs first, while still a draft)
  const [audited] = await c.env.DB.batch([
    auditStatement(c.env.DB, actorOf(c), {
      action: 'invoice.finalized', resourceType: 'invoice', resourceId: id,
      oldValues: { status: 'draft' },
      newValues: { status: 'sent', total: invoice.total, tax_amount: invoice.tax_amount },
      summary: `Finalised ${invoice.invoice_number}`,
    }, { sql: `EXISTS (SELECT 1 FROM invoices WHERE id = ? AND status = 'draft')`, binds: [id] }),
    c.env.DB.prepare(
      `UPDATE invoices SET status = 'sent', pdf_r2_key = ?, sent_at = CURRENT_TIMESTAMP,
       updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'draft'`
    ).bind(r2Key, id),
  ]);
  if (!audited.meta.changes) return c.json({ error: 'Already finalized' }, 422);

  return c.json({ ok: true });
});

// POST /api/v1/invoices/:id/original-pdf — attach the PDF a customer actually received for an
// invoice imported from QuickBooks, or for a VAT-only invoice made elsewhere (it replaces the one
// LedgerLite drew). LedgerLite's other invoices get their PDF when finalised.
router.post('/:id/original-pdf', requireRole('owner'), async (c) => {
  const id = c.req.param('id');
  const invoice = await c.env.DB.prepare('SELECT invoice_number, source, vat_for_invoice_id, pdf_r2_key FROM invoices WHERE id = ?')
    .bind(id).first<{ invoice_number: string; source: string; vat_for_invoice_id: string | null; pdf_r2_key: string | null }>();
  if (!invoice) return c.json({ error: 'Not found' }, 404);
  if (invoice.source !== 'quickbooks' && !invoice.vat_for_invoice_id) {
    return c.json({ error: 'Only imported and VAT-only invoices take an uploaded PDF' }, 409);
  }

  const form = await c.req.formData().catch(() => null);
  const checked = await checkUpload(form?.get('file') ?? null, ['application/pdf'], 10 * 1024 * 1024);
  if (!checked.ok) return c.json({ error: checked.error }, 400);

  // A new key every upload, so a replaced PDF stays in storage for the audit trail and restores
  const key = `invoices/${id}/original-${Date.now()}.pdf`;
  await uploadToR2(c.env.R2, key, checked.bytes, checked.type);
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE invoices SET pdf_r2_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).bind(key, id),
    auditStatement(c.env.DB, actorOf(c), {
      action: 'invoice.original_pdf_uploaded', resourceType: 'invoice', resourceId: id,
      oldValues: invoice.pdf_r2_key ? { key: invoice.pdf_r2_key } : undefined,
      newValues: { file: checked.name, key },
      summary: `Attached the original PDF (${checked.name})`,
    }),
  ]);
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
  const id = c.req.param('id');

  const existing = await c.env.DB.prepare('SELECT id, status, invoice_number, total, issue_date FROM invoices WHERE id = ?')
    .bind(id).first<{ id: string; status: string; invoice_number: string; total: number; issue_date: string }>();
  if (!existing) return c.json({ error: 'Not found' }, 404);
  if (existing.status === 'void') return c.json({ error: 'Already voided' }, 422);
  // A void is allowed in a reviewed quarter: it is one of the two ways (with a credit note) to
  // correct an invoice whose VAT was already sent to HMRC.

  const vatOnly = await c.env.DB.prepare(
    `SELECT invoice_number FROM invoices WHERE vat_for_invoice_id = ? AND status != 'void' LIMIT 1`
  ).bind(id).first<{ invoice_number: string }>();
  if (vatOnly) {
    return c.json({ error: `VAT for this invoice is charged on ${vatOnly.invoice_number}. Void that first.` }, 409);
  }
  const creditNote = await c.env.DB.prepare(
    `SELECT invoice_number FROM invoices WHERE credits_invoice_id = ? AND status != 'void' LIMIT 1`
  ).bind(id).first<{ invoice_number: string }>();
  if (creditNote) {
    return c.json({ error: `This invoice has credit note ${creditNote.invoice_number}. Void that first.` }, 409);
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

  // Re-checked in the batch: a payment, bank match or VAT-only invoice that lands meanwhile stops the void
  const voidable = {
    sql: `EXISTS (SELECT 1 FROM invoices i WHERE i.id = ? AND i.status != 'void'
            AND NOT EXISTS (SELECT 1 FROM payments_received WHERE invoice_id = i.id)
            AND NOT EXISTS (SELECT 1 FROM transaction_matches WHERE invoice_id = i.id AND status IN ('pending','posted'))
            AND NOT EXISTS (SELECT 1 FROM invoices v WHERE v.vat_for_invoice_id = i.id AND v.status != 'void')
            AND NOT EXISTS (SELECT 1 FROM invoices n WHERE n.credits_invoice_id = i.id AND n.status != 'void'))`,
    binds: [id],
  };
  // Voiding a credit note gives the credit it applied back to its invoice (refunds would have
  // blocked the void: they're payments on the credit note)
  const allocations = (await c.env.DB.prepare(
    'SELECT invoice_id, amount FROM credit_allocations WHERE credit_note_id = ?'
  ).bind(id).all<{ invoice_id: string; amount: number }>()).results;
  const [audited] = await c.env.DB.batch([
    auditStatement(c.env.DB, actorOf(c), {
      action: 'invoice.voided', resourceType: 'invoice', resourceId: id,
      oldValues: { status: existing.status }, newValues: { status: 'void', total: existing.total },
      summary: `Voided ${existing.invoice_number}`,
    }, voidable),
    c.env.DB.prepare(`DELETE FROM transaction_matches WHERE invoice_id = ? AND status = 'suggested' AND ${voidable.sql}`)
      .bind(id, ...voidable.binds),
    ...allocations.flatMap(a => [
      c.env.DB.prepare(`
        UPDATE invoices SET amount_paid = MAX(0, amount_paid - ?),
          status = CASE WHEN status = 'void' THEN 'void'
                        WHEN amount_paid - ? <= 0 THEN CASE WHEN due_date < date('now') THEN 'overdue' ELSE 'sent' END
                        WHEN due_date < date('now') THEN 'overdue' ELSE 'partial' END,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND ${voidable.sql}
      `).bind(a.amount, a.amount, a.invoice_id, ...voidable.binds),
      auditStatement(c.env.DB, actorOf(c), {
        action: 'invoice.credit_removed', resourceType: 'invoice', resourceId: a.invoice_id,
        oldValues: { creditNoteId: id, creditNote: existing.invoice_number, amount: a.amount },
        summary: `Credit note ${existing.invoice_number} voided: its credit no longer reduces this invoice`,
      }, voidable),
    ]),
    c.env.DB.prepare(`DELETE FROM credit_allocations WHERE credit_note_id = ? AND ${voidable.sql}`).bind(id, ...voidable.binds),
    c.env.DB.prepare(
      `UPDATE invoices SET status = 'void', amount_paid = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND ${voidable.sql}`
    ).bind(id, ...voidable.binds),
  ]);
  if (!audited!.meta.changes) {
    return c.json({ error: 'This invoice was paid or matched meanwhile; refresh and try again' }, 409);
  }

  return c.json({ ok: true });
});

// DELETE /api/v1/invoices/:id — draft-only soft delete (void)
router.delete('/:id', requireRole('owner'), async (c) => {
  const id = c.req.param('id');

  const existing = await c.env.DB.prepare('SELECT id, status, invoice_number FROM invoices WHERE id = ?')
    .bind(id).first<{ id: string; status: string; invoice_number: string }>();
  if (!existing) return c.json({ error: 'Not found' }, 404);
  if (existing.status !== 'draft') return c.json({ error: 'Only draft invoices can be deleted' }, 409);

  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE invoices SET status = 'void', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).bind(id),
    auditStatement(c.env.DB, actorOf(c), {
      action: 'invoice.deleted', resourceType: 'invoice', resourceId: id,
      oldValues: { status: existing.status }, newValues: { status: 'void' },
      summary: `Deleted draft ${existing.invoice_number}`,
    }),
  ]);

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
  }, paymentId => [auditStatement(c.env.DB, actorOf(c), {
    action: 'payment.created', resourceType: 'invoice', resourceId: id,
    newValues: { paymentId, amount: data.amount, payment_date: data.payment_date, method: data.method, reference: data.reference ?? null },
    summary: 'Payment recorded by hand',
  }, paymentExistsSql('invoice', paymentId))]);
  if (!recorded.ok) return c.json({ error: recorded.error }, recorded.status);
  const paymentId = recorded.id;
  const newStatus = recorded.status;

  return c.json({ id: paymentId, status: newStatus }, 201);
});

router.delete('/:id/payments/:paymentId', requireRole('owner'), async (c) => {
  const id = c.req.param('id');
  const paymentId = c.req.param('paymentId');
  if (!id || !paymentId) return c.json({ error: 'Payment not found' }, 404);

  const removed = await deleteDocumentPayment(c.env.DB, 'invoice', id, paymentId, (amount, before) => [
    auditStatement(c.env.DB, actorOf(c), {
      action: 'payment.deleted', resourceType: 'invoice', resourceId: id,
      oldValues: { paymentId, amount, amount_paid: before.amount_paid, status: before.status },
      summary: 'Payment deleted',
    }, paymentExistsSql('invoice', paymentId)),
  ]);
  if (!removed.ok) return c.json({ error: removed.error }, removed.status);

  return c.json({ ok: true });
});

type DraftSnapshot = {
  status: string; invoice_number: string; client_id: string; issue_date: string; due_date: string; vat_treatment: string;
  notes: string | null; subtotal: number; tax_amount: number; total: number;
  items: ReturnType<typeof auditItems>;
};

/** The draft as it is now, in the shape its audit row compares against */
async function draftSnapshot(db: D1Database, id: string): Promise<DraftSnapshot | null> {
  const row = await db.prepare(
    `SELECT status, invoice_number, client_id, issue_date, due_date, vat_treatment, notes, subtotal, tax_amount, total
     FROM invoices WHERE id = ?`
  ).bind(id).first<Omit<DraftSnapshot, 'items'>>();
  if (!row) return null;
  const { results } = await db.prepare(
    'SELECT description, quantity, unit_price, tax_rate FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order'
  ).bind(id).all<DraftItem>();
  return { ...row, items: auditItems(results) };
}

/** Lines as the audit log stores them */
function auditItems(items: DraftItem[]) {
  return items.map(({ description, quantity, unit_price, tax_rate }) => ({ description, quantity, unit_price, tax_rate }));
}

/** The audit row for a draft edit: only what changed, written only while it's still a draft */
function draftAudit(
  c: Parameters<typeof actorOf>[0], before: DraftSnapshot & { status: string }, after: Record<string, unknown>,
): D1PreparedStatement[] {
  const diff = changedFields(before, after);
  if (!diff) return [];
  const id = c.req.param('id');
  return [auditStatement(c.env.DB, actorOf(c), {
    action: 'invoice.updated', resourceType: 'invoice', resourceId: id, ...diff,
    summary: `Edited draft ${before.invoice_number}`,
  }, { sql: `EXISTS (SELECT 1 FROM invoices WHERE id = ? AND status = 'draft')`, binds: [id] })];
}

export { router as invoiceRoutes };
