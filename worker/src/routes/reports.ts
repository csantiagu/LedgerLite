import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { assembleYearEndZip } from '../services/yearEndExport';
import { generateProfitLossPdf } from '../services/pdfGenerator';
import type { Env } from '../types';

const router = new Hono<{ Bindings: Env }>();

const DateRangeSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const TAX_YEARS: Record<string, { from: string; to: string }> = {
  '2024-25': { from: '2024-04-06', to: '2025-04-05' },
  '2025-26': { from: '2025-04-06', to: '2026-04-05' },
  '2026-27': { from: '2026-04-06', to: '2027-04-05' },
};

async function getPl(c: Context<{ Bindings: Env }>, from: string, to: string) {
  const incomeRows = await c.env.DB.prepare(
    `SELECT c.name as client_name, COALESCE(SUM(pr.amount), 0) as total
     FROM payments_received pr
     JOIN invoices i ON pr.invoice_id = i.id
     JOIN clients c ON i.client_id = c.id
     WHERE i.issue_date BETWEEN ? AND ?
     GROUP BY c.id, c.name
     ORDER BY total DESC`
  ).bind(from, to).all<{ client_name: string; total: number }>();

  const billExpenseRows = await c.env.DB.prepare(
    `SELECT ec.name as category, COALESCE(SUM(bi.amount), 0) as total
     FROM bill_items bi
     JOIN bills b ON bi.bill_id = b.id
     LEFT JOIN expense_categories ec ON ec.id = bi.expense_category_id
     WHERE b.issue_date BETWEEN ? AND ? AND b.status != 'void'
     GROUP BY ec.id, ec.name`
  ).bind(from, to).all<{ category: string | null; total: number }>();

  const txnExpenseRows = await c.env.DB.prepare(
    `SELECT ec.name as category, COALESCE(SUM(ABS(t.amount)), 0) as total
     FROM transactions t
     JOIN expense_categories ec ON t.expense_category_id = ec.id
     WHERE t.date BETWEEN ? AND ?
       AND t.amount < 0
       AND t.is_reconciled = 1
       AND t.matched_bill_id IS NULL
     GROUP BY ec.id, ec.name`
  ).bind(from, to).all<{ category: string; total: number }>();

  const expenseMap = new Map<string, number>();
  for (const row of billExpenseRows.results) {
    const key = row.category ?? 'Other';
    expenseMap.set(key, (expenseMap.get(key) || 0) + row.total);
  }
  for (const row of txnExpenseRows.results) {
    const key = row.category || 'Other';
    expenseMap.set(key, (expenseMap.get(key) || 0) + row.total);
  }
  const expenses = Array.from(expenseMap.entries()).map(([category, total]) => ({ category, total }))
    .sort((a, b) => b.total - a.total);

  const income = incomeRows.results;
  const totalIncome = income.reduce((s: number, r: { total: number }) => s + r.total, 0);
  const totalExpenses = expenses.reduce((s: number, r: { total: number }) => s + r.total, 0);
  const net = totalIncome - totalExpenses;
  return { income, expenses, totalIncome, totalExpenses, net };
}

// GET /api/v1/reports/dashboard
router.get('/dashboard', async (c) => {
  const [outstanding, overdue, bills, ytd] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT COALESCE(SUM(total - amount_paid), 0) as value
       FROM invoices WHERE status IN ('sent', 'partial')`
    ),
    c.env.DB.prepare(
      `SELECT COALESCE(SUM(total - amount_paid), 0) as value
       FROM invoices WHERE status = 'overdue'`
    ),
    c.env.DB.prepare(
      `SELECT COALESCE(SUM(total - amount_paid), 0) as value
       FROM bills WHERE status IN ('pending', 'partial')`
    ),
    c.env.DB.prepare(
      `SELECT COALESCE(SUM(amount), 0) as value
       FROM payments_received
       WHERE payment_date >= date('now', 'start of year')`
    ),
  ]);

  return c.json({
    outstanding_pence: (outstanding.results[0] as { value: number }).value,
    overdue_pence: (overdue.results[0] as { value: number }).value,
    unpaid_bills_pence: (bills.results[0] as { value: number }).value,
    ytd_revenue_pence: (ytd.results[0] as { value: number }).value,
  });
});

router.get('/pl', async (c) => {
  const parsed = DateRangeSchema.safeParse({ from: c.req.query('from'), to: c.req.query('to') });
  if (!parsed.success) return c.json({ error: 'Invalid date range' }, 400);
  return c.json(await getPl(c, parsed.data.from, parsed.data.to));
});

router.get('/outstanding', async (c) => {
  const [inv, bills] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT COALESCE(SUM(total - amount_paid), 0) as value FROM invoices WHERE status IN ('sent','partial','overdue')`),
    c.env.DB.prepare(`SELECT COALESCE(SUM(total - amount_paid), 0) as value FROM bills WHERE status IN ('pending','partial')`),
  ]);
  const invoicesOutstanding = (inv.results[0] as { value: number }).value;
  const billsOutstanding = (bills.results[0] as { value: number }).value;
  return c.json({
    invoices_outstanding_pence: invoicesOutstanding,
    bills_outstanding_pence: billsOutstanding,
    total_outstanding_pence: invoicesOutstanding + billsOutstanding,
  });
});

router.get('/aged-debtors', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT due_date, (total - amount_paid) as balance
     FROM invoices
     WHERE status IN ('sent','partial','overdue')
       AND (total - amount_paid) > 0`
  ).all<{ due_date: string; balance: number }>();

  const buckets = { '0_30': 0, '31_60': 0, '61_90': 0, '90_plus': 0 };
  const now = new Date();
  for (const row of rows.results) {
    const due = new Date(row.due_date);
    const days = Math.floor((now.getTime() - due.getTime()) / 86400000);
    if (days <= 30) buckets['0_30'] += row.balance;
    else if (days <= 60) buckets['31_60'] += row.balance;
    else if (days <= 90) buckets['61_90'] += row.balance;
    else buckets['90_plus'] += row.balance;
  }
  return c.json(buckets);
});

router.get('/cash-flow', async (c) => {
  const parsed = DateRangeSchema.safeParse({ from: c.req.query('from'), to: c.req.query('to') });
  if (!parsed.success) return c.json({ error: 'Invalid date range' }, 400);
  const { from, to } = parsed.data;

  const income = await c.env.DB.prepare(
    `SELECT substr(payment_date, 1, 7) as month, COALESCE(SUM(amount), 0) as total
     FROM payments_received
     WHERE payment_date BETWEEN ? AND ?
     GROUP BY month
     ORDER BY month ASC`
  ).bind(from, to).all<{ month: string; total: number }>();

  const out = await c.env.DB.prepare(
    `SELECT substr(payment_date, 1, 7) as month, COALESCE(SUM(amount), 0) as total
     FROM payments_made
     WHERE payment_date BETWEEN ? AND ?
     GROUP BY month
     ORDER BY month ASC`
  ).bind(from, to).all<{ month: string; total: number }>();

  const map = new Map<string, { month: string; in: number; out: number; net: number }>();
  for (const r of income.results) map.set(r.month, { month: r.month, in: r.total, out: 0, net: r.total });
  for (const r of out.results) {
    const curr = map.get(r.month) || { month: r.month, in: 0, out: 0, net: 0 };
    curr.out = r.total;
    curr.net = curr.in - curr.out;
    map.set(r.month, curr);
  }
  return c.json(Array.from(map.values()).sort((a, b) => a.month.localeCompare(b.month)));
});

router.get('/flagged', async (c) => {
  const bills = await c.env.DB.prepare(
    `SELECT id, 'bill' as type, bill_number as ref, accountant_notes, created_at
     FROM bills WHERE flagged = 1`
  ).all();
  const txns = await c.env.DB.prepare(
    `SELECT id, 'transaction' as type, description as ref, accountant_notes, created_at
     FROM transactions WHERE flagged = 1`
  ).all();
  return c.json({ bills: bills.results, transactions: txns.results });
});

router.get('/year-end', async (c) => {
  const taxYear = c.req.query('tax_year') || '';
  const range = TAX_YEARS[taxYear];
  if (!range) return c.json({ error: 'Invalid tax year' }, 400);

  const pl = await getPl(c, range.from, range.to);

  const incomeRows = [
    ['client_name', 'total_pence'],
    ...pl.income.map((r: { client_name: string; total: number }) => [r.client_name, String(r.total)]),
  ];
  const expenseRows = [
    ['category', 'total_pence'],
    ...pl.expenses.map((r) => [r.category, String(r.total)]),
  ];

  const txns = await c.env.DB.prepare(
    `SELECT date, description, amount, reference, is_reconciled, flagged
     FROM transactions
     WHERE date BETWEEN ? AND ?
     ORDER BY date ASC`
  ).bind(range.from, range.to).all<{
    date: string; description: string; amount: number; reference: string | null; is_reconciled: number; flagged: number;
  }>();
  const transactionRows = [
    ['date', 'description', 'amount_pence', 'reference', 'is_reconciled', 'flagged'],
    ...txns.results.map((r) => [r.date, r.description, String(r.amount), r.reference ?? '', String(r.is_reconciled), String(r.flagged)]),
  ];

  const flaggedBills = await c.env.DB.prepare(
    `SELECT 'bill' as type, id, COALESCE(bill_number, id) as ref, accountant_notes
     FROM bills WHERE flagged = 1`
  ).all<{ type: string; id: string; ref: string; accountant_notes: string | null }>();
  const flaggedTxns = await c.env.DB.prepare(
    `SELECT 'transaction' as type, id, description as ref, accountant_notes
     FROM transactions WHERE flagged = 1`
  ).all<{ type: string; id: string; ref: string; accountant_notes: string | null }>();
  const flaggedRows = [
    ['type', 'id', 'ref', 'accountant_notes'],
    ...flaggedBills.results.map((r) => [r.type, r.id, r.ref, r.accountant_notes ?? '']),
    ...flaggedTxns.results.map((r) => [r.type, r.id, r.ref, r.accountant_notes ?? '']),
  ];

  const summaryPdf = await generateProfitLossPdf({
    title: `Profit & Loss (${taxYear})`,
    from: range.from,
    to: range.to,
    income: pl.totalIncome,
    expenses: pl.totalExpenses,
    net: pl.net,
  });

  const invoicePdfRows = await c.env.DB.prepare(
    `SELECT invoice_number, pdf_r2_key
     FROM invoices
     WHERE issue_date BETWEEN ? AND ?
       AND pdf_r2_key IS NOT NULL`
  ).bind(range.from, range.to).all<{ invoice_number: string; pdf_r2_key: string }>();

  const invoicePdfs: Array<{ name: string; data: Uint8Array }> = [];
  for (const row of invoicePdfRows.results) {
    const obj = await c.env.R2.get(row.pdf_r2_key);
    if (!obj) continue;
    const bytes = new Uint8Array(await obj.arrayBuffer());
    invoicePdfs.push({ name: `${row.invoice_number}.pdf`, data: bytes });
  }

  const zipBytes = assembleYearEndZip({
    incomeRows,
    expenseRows,
    transactionRows,
    flaggedRows,
    invoicePdfs,
    summaryPdf,
  });

  const headers = new Headers();
  headers.set('Content-Type', 'application/zip');
  headers.set('Content-Disposition', `attachment; filename="year-end-${taxYear}.zip"`);
  return new Response(zipBytes, { headers });
});

export { router as reportRoutes };
