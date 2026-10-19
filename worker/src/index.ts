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
import { transactionMatchRoutes, unlinkedImportedSql } from './routes/transactionMatches';
import { IMPORTED_PAYMENT_REFERENCE } from './services/invoiceImport';
import { reportRoutes } from './routes/reports';
import { companySettingsRoutes } from './routes/companySettings';
import { categorisationRuleRoutes } from './routes/categorisationRules';
import { invoiceImportRoutes } from './routes/invoiceImports';
import { authMiddleware, configProblem } from './middleware/auth';
import { csrfMiddleware } from './middleware/csrf';
import { apiRateLimit } from './middleware/rateLimit';

const app = new Hono<{ Bindings: Env }>();

// Hardening headers on every response (including errors and CORS preflights). The API only
// returns JSON and file downloads, so nothing it serves should render, be framed or be cached.
app.use('*', async (c, next) => {
  await next();
  const headers = c.res.headers;
  const setDefault = (name: string, value: string) => { if (!headers.has(name)) headers.set(name, value); };
  setDefault('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; sandbox");
  setDefault('X-Content-Type-Options', 'nosniff');
  setDefault('X-Frame-Options', 'DENY');
  setDefault('Referrer-Policy', 'no-referrer');
  setDefault('Cache-Control', 'no-store');
  if (c.env.ENVIRONMENT !== 'local') {
    setDefault('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
});

// Before CORS: with ALLOWED_ORIGIN missing, the CORS middleware itself would throw
app.use('*', async (c, next) => {
  const problem = configProblem(c.env);
  if (problem) {
    console.error(`Refusing to serve: ${problem}`);
    return c.json({ error: 'Server is misconfigured' }, 500);
  }
  return next();
});

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
app.route('/api/v1/categorisation-rules', categorisationRuleRoutes);
app.route('/api/v1/invoice-imports', invoiceImportRoutes);

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

  // Paid imported invoices whose QuickBooks payment isn't linked to bank lines yet
  if ((type === 'all' || type === 'invoice') && q) {
    const unlinked = unlinkedImportedSql('i.id');
    let sql = `
      SELECT i.id, i.invoice_number, c.name as client_name, i.total, ${unlinked} as unlinked,
             (SELECT MAX(payment_date) FROM payments_received WHERE invoice_id = i.id) as paid_on
      FROM invoices i JOIN clients c ON i.client_id = c.id
      WHERE i.source = 'quickbooks' AND i.status != 'void'
        AND ${unlinked} > 0
        AND (i.invoice_number LIKE ? OR c.name LIKE ?)
    `;
    const binds: unknown[] = [IMPORTED_PAYMENT_REFERENCE, IMPORTED_PAYMENT_REFERENCE, `%${q}%`, `%${q}%`];
    if (pence) { sql += ` AND ${unlinked} >= ?`; binds.push(IMPORTED_PAYMENT_REFERENCE, pence); }
    sql += ' ORDER BY paid_on DESC LIMIT 10';
    const { results: rows } = await c.env.DB.prepare(sql).bind(...binds).all<Record<string, unknown>>();
    rows.forEach(r => results.push({
      type: 'invoice', id: r.id, link: true,
      label: `${r.invoice_number} — ${r.client_name}`,
      total: r.total, outstanding: r.unlinked, date: r.paid_on,
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
