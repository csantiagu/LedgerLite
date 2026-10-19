import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { requireRole } from '../middleware/rbac';
import { writeAudit } from '../middleware/audit';
import { planImport, suggestNumbering, customerKey, IMPORTED_PAYMENT_REFERENCE } from '../services/invoiceImport';

const router = new Hono<{ Bindings: Env }>();

const pence = z.number().int().nullable().optional();
const RowSchema = z.object({
  invoiceNumber: z.string().max(200),
  customer:      z.string().max(500),
  issueDate:     z.string().max(20),
  dueDate:       z.string().max(20).nullable().optional(),
  total:         z.number().int(),
  subtotal:      pence,
  taxAmount:     pence,
  openBalance:   z.number().int(),
  paymentDate:   z.string().max(20).nullable().optional(),
  memo:          z.string().max(2000).nullable().optional(),
});
const ImportSchema = z.object({
  rows:   z.array(RowSchema).min(1).max(1000),
  dryRun: z.boolean().default(true),
});

// POST /api/v1/invoice-imports — check (dryRun) or import historical invoices from QuickBooks
router.post('/', requireRole('owner'), async (c) => {
  const parsed = ImportSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid import' }, 400);
  const { rows, dryRun } = parsed.data;
  const db = c.env.DB;
  const user = c.get('user');

  const [numbers, clients] = await Promise.all([
    db.prepare('SELECT invoice_number FROM invoices').all<{ invoice_number: string }>(),
    db.prepare('SELECT id, name FROM clients').all<{ id: string; name: string }>(),
  ]);
  const clientIds = new Map(clients.results.map(cl => [customerKey(cl.name), cl.id]));
  const { outcomes, invoices } = planImport(
    rows, new Set(numbers.results.map(n => n.invoice_number)), new Set(clientIds.keys()),
  );

  const summary = {
    toImport: invoices.length,
    skipped: outcomes.length - invoices.length,
    newCustomers: new Set(invoices.filter(i => !clientIds.has(i.customerKey)).map(i => i.customerKey)).size,
    total: invoices.reduce((sum, i) => sum + i.total, 0),
    outstanding: invoices.reduce((sum, i) => sum + i.total - i.amountPaid, 0),
  };
  const numbering = suggestNumbering(invoices.map(i => i.invoiceNumber));
  if (dryRun || !invoices.length) return c.json({ dryRun: true, summary, outcomes, numbering });

  // One batch = one transaction: customers, invoices, lines and payments all land or none do
  const statements: D1PreparedStatement[] = [];
  for (const inv of invoices) {
    if (!clientIds.has(inv.customerKey)) {
      const id = crypto.randomUUID().replace(/-/g, '');
      clientIds.set(inv.customerKey, id);
      statements.push(db.prepare(
        'INSERT INTO clients (id, name, created_by) VALUES (?, ?, ?)'
      ).bind(id, inv.customerName, user.id));
    }
    const invoiceId = crypto.randomUUID().replace(/-/g, '');
    statements.push(
      db.prepare(`
        INSERT INTO invoices (id, client_id, invoice_number, status, issue_date, due_date,
          subtotal, tax_amount, total, amount_paid, sent_at, source, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'quickbooks', ?)
      `).bind(invoiceId, clientIds.get(inv.customerKey), inv.invoiceNumber, inv.status, inv.issueDate,
              inv.dueDate, inv.subtotal, inv.taxAmount, inv.total, inv.amountPaid, inv.issueDate, user.id),
      db.prepare(`
        INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, tax_rate, amount, sort_order)
        VALUES (?, ?, 1, ?, ?, ?, 0)
      `).bind(invoiceId, inv.description, inv.subtotal, inv.taxRate, inv.subtotal),
    );
    if (inv.amountPaid > 0) {
      statements.push(db.prepare(`
        INSERT INTO payments_received (invoice_id, amount, payment_date, method, reference, created_by)
        VALUES (?, ?, ?, 'other', ?, ?)
      `).bind(invoiceId, inv.amountPaid, inv.paymentDate, IMPORTED_PAYMENT_REFERENCE, user.id));
    }
  }

  try {
    await db.batch(statements);
  } catch (err) {
    // Another import or a new invoice took one of these numbers in the meantime
    if (String(err).includes('UNIQUE constraint failed')) {
      return c.json({ error: 'Some of these invoice numbers were added meanwhile; check again' }, 409);
    }
    throw err;
  }

  await writeAudit(c.env, {
    userId: user.id, action: 'invoice.imported', resourceType: 'invoice',
    newValues: { count: invoices.length, numbers: invoices.map(i => i.invoiceNumber) },
    ipAddress: c.req.header('CF-Connecting-IP'), userAgent: c.req.header('User-Agent'),
  });
  return c.json({ dryRun: false, summary, outcomes, numbering });
});

export { router as invoiceImportRoutes };
