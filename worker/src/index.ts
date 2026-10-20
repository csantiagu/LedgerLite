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
import { loadCandidates, pickCandidates, rankCandidates, type BankLine } from './services/matchCandidates';
import { linksAllowed } from './services/migration';
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

// GET /api/v1/match-search?transactionId=…[&q=…][&all=1] — Find match for a bank line: its best
// candidates (number, client/vendor name or amount match), or what `q` picks out, or `all` of them
app.get('/api/v1/match-search', async (c) => {
  const transactionId = c.req.query('transactionId');
  if (!transactionId) return c.json({ error: 'transactionId is required' }, 400);
  const db = c.env.DB;
  const line = await db.prepare(`
    SELECT id, date, description, reference, amount,
      (SELECT COALESCE(SUM(allocated_amount), 0) FROM transaction_matches
        WHERE transaction_id = transactions.id AND status IN ('pending','posted')) AS allocated
    FROM transactions WHERE id = ?
  `).bind(transactionId).first<BankLine>();
  if (!line) return c.json({ error: 'Transaction not found' }, 404);

  const links = line.amount > 0 && await linksAllowed(db);
  const remaining = Math.abs(line.amount) - line.allocated;
  const ranked = rankCandidates(await loadCandidates(db, line, links),
    { description: line.description, reference: line.reference, remaining });
  const { results, hidden } = pickCandidates(ranked, { q: c.req.query('q'), all: c.req.query('all') === '1' });

  return c.json({
    links,
    hidden,
    results: results.map(r => ({
      type: r.type, id: r.id, link: r.link ?? false, reasons: r.reasons,
      label: r.type === 'invoice'
        ? `${r.number}${r.alt_number ? ` (VAT for ${r.alt_number})` : ''} — ${r.party}`
        : `${r.party}${r.number ? ' · ' + r.number : ''}`,
      total: r.total, outstanding: r.outstanding, date: r.date,
    })),
  });
});

app.notFound((c) => c.json({ error: 'Not found' }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'Internal server error' }, 500);
});

export default app;
