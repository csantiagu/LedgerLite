import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types';
import authRoutes from './routes/auth';
import userRoutes from './routes/users';
import { clientRoutes } from './routes/clients';
import { vendorRoutes } from './routes/vendors';
import { expenseCategoryRoutes } from './routes/expenseCategories';
import { invoiceRoutes } from './routes/invoices';
import { billRoutes } from './routes/bills';
import { bankImportRoutes } from './routes/bankImports';
import { transactionRoutes } from './routes/transactions';
import { bankAccountRoutes } from './routes/bankAccounts';
import { transactionMatchRoutes } from './routes/transactionMatches';
import { reportRoutes } from './routes/reports';
import { companySettingsRoutes } from './routes/companySettings';
import { authMiddleware } from './middleware/auth';
import { csrfMiddleware } from './middleware/csrf';
import { apiRateLimit } from './middleware/rateLimit';

const app = new Hono<{ Bindings: Env }>();

app.use('*', async (c, next) => {
  const corsHandler = cors({
    origin: c.env.ALLOWED_ORIGIN,
    credentials: true,
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  });
  return corsHandler(c, next);
});

app.route('/auth', authRoutes);

app.use('/api/*', csrfMiddleware);
app.use('/api/*', authMiddleware);
app.use('/api/*', apiRateLimit);

app.route('/api/v1/users', userRoutes);
app.route('/api/v1/clients', clientRoutes);
app.route('/api/v1/vendors', vendorRoutes);
app.route('/api/v1/expense-categories', expenseCategoryRoutes);
app.route('/api/v1/invoices', invoiceRoutes);
app.route('/api/v1/bills', billRoutes);
app.route('/api/v1/bank-accounts', bankAccountRoutes);
app.route('/api/v1/bank-imports', bankImportRoutes);
app.route('/api/v1/transactions', transactionRoutes);
app.route('/api/v1/transaction-matches', transactionMatchRoutes);
app.route('/api/v1/reports', reportRoutes);
app.route('/api/v1/settings/company', companySettingsRoutes);

app.get('/api/v1/for-review', async (c) => {
  const { results } = await c.env.DB.prepare(`
    SELECT
      tm.id           as match_id,
      tm.status,
      tm.match_type,
      tm.allocated_amount,
      tm.invoice_id,
      tm.bill_id,
      t.id            as transaction_id,
      t.date,
      t.description,
      t.amount,
      ba.name         as account_name,
      i.invoice_number,
      i.total         as inv_total,
      i.amount_paid   as inv_paid,
      ci.name         as client_name,
      i.due_date      as inv_due_date,
      b.bill_number,
      b.total         as bill_total,
      b.amount_paid   as bill_paid,
      v.name          as vendor_name,
      b.due_date      as bill_due_date
    FROM transaction_matches tm
    JOIN transactions t   ON tm.transaction_id = t.id
    LEFT JOIN bank_accounts ba ON t.bank_account_id = ba.id
    LEFT JOIN invoices i  ON tm.invoice_id = i.id
    LEFT JOIN clients ci  ON i.client_id = ci.id
    LEFT JOIN bills b     ON tm.bill_id = b.id
    LEFT JOIN vendors v   ON b.vendor_id = v.id
    WHERE tm.status IN ('suggested','pending')
    ORDER BY tm.match_type, COALESCE(tm.invoice_id, tm.bill_id), t.date
  `).all<Record<string, unknown>>();

  const groups = new Map<string, {
    type: string; targetId: string; label: string;
    total: number; alreadyPaid: number; dueDate: string | null;
    matches: unknown[];
  }>();

  for (const row of results) {
    const key = (row.invoice_id ?? row.bill_id) as string;
    if (!groups.has(key)) {
      groups.set(key, {
        type:        row.match_type as string,
        targetId:    key,
        label:       row.invoice_id
          ? `${row.invoice_number} — ${row.client_name}`
          : `${row.vendor_name}${row.bill_number ? ' · ' + row.bill_number : ''}`,
        total:       (row.inv_total ?? row.bill_total) as number,
        alreadyPaid: (row.inv_paid  ?? row.bill_paid)  as number,
        dueDate:     (row.inv_due_date ?? row.bill_due_date) as string | null,
        matches:     [],
      });
    }
    groups.get(key)!.matches.push({
      matchId:         row.match_id,
      status:          row.status,
      transactionId:   row.transaction_id,
      date:            row.date,
      description:     row.description,
      amount:          row.amount,
      allocatedAmount: row.allocated_amount,
      accountName:     row.account_name,
    });
  }

  return c.json([...groups.values()]);
});

app.get('/api/v1/match-search', async (c) => {
  const q     = c.req.query('q')?.trim() ?? '';
  const type  = c.req.query('type') ?? 'all';
  const pence = c.req.query('amount') ? parseInt(c.req.query('amount')!, 10) : null;
  const results: unknown[] = [];

  if (type === 'all' || type === 'invoice') {
    let sql = `
      SELECT i.id, i.invoice_number, c.name as client_name,
             i.total, (i.total - i.amount_paid) as outstanding, i.due_date
      FROM invoices i JOIN clients c ON i.client_id = c.id
      WHERE i.status IN ('sent','partial','overdue')
    `;
    const binds: unknown[] = [];
    if (q)     { sql += ' AND (i.invoice_number LIKE ? OR c.name LIKE ?)'; binds.push(`%${q}%`, `%${q}%`); }
    if (pence) { sql += ' AND (i.total - i.amount_paid) >= ?'; binds.push(pence); }
    sql += ' ORDER BY i.due_date DESC LIMIT 10';
    const { results: rows } = await c.env.DB.prepare(sql).bind(...binds).all<Record<string, unknown>>();
    rows.forEach(r => results.push({
      type: 'invoice', id: r.id,
      label: `${r.invoice_number} — ${r.client_name}`,
      total: r.total, outstanding: r.outstanding, date: r.due_date,
    }));
  }

  if (type === 'all' || type === 'bill') {
    let sql = `
      SELECT b.id, b.bill_number, v.name as vendor_name,
             b.total, (b.total - b.amount_paid) as outstanding, b.due_date
      FROM bills b JOIN vendors v ON b.vendor_id = v.id
      WHERE b.status IN ('pending','partial')
    `;
    const binds: unknown[] = [];
    if (q)     { sql += ' AND (b.bill_number LIKE ? OR v.name LIKE ?)'; binds.push(`%${q}%`, `%${q}%`); }
    if (pence) { sql += ' AND (b.total - b.amount_paid) >= ?'; binds.push(pence); }
    sql += ' ORDER BY b.due_date DESC LIMIT 10';
    const { results: rows } = await c.env.DB.prepare(sql).bind(...binds).all<Record<string, unknown>>();
    rows.forEach(r => results.push({
      type: 'bill', id: r.id,
      label: `${r.vendor_name}${r.bill_number ? ' · ' + r.bill_number : ''}`,
      total: r.total, outstanding: r.outstanding, date: r.due_date,
    }));
  }

  return c.json(results);
});

app.notFound((c) => c.json({ error: 'Not found' }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'Internal server error' }, 500);
});

export default app;
