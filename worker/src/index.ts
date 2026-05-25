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
import { reportRoutes } from './routes/reports';
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
app.route('/api/v1/bank-imports', bankImportRoutes);
app.route('/api/v1/transactions', transactionRoutes);
app.route('/api/v1/reports', reportRoutes);

app.notFound((c) => c.json({ error: 'Not found' }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'Internal server error' }, 500);
});

export default app;
