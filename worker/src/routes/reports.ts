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
       AND NOT EXISTS (
         SELECT 1 FROM transaction_matches tm
         WHERE tm.transaction_id = t.id
           AND tm.match_type = 'bill'
           AND tm.status = 'posted'
       )
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

  const pence = (v: number) => (v / 100).toFixed(2);

  const incomeRows = [
    ['client_name', 'total_gbp'],
    ...pl.income.map((r: { client_name: string; total: number }) => [r.client_name, pence(r.total)]),
  ];
  const expenseRows = [
    ['category', 'total_gbp'],
    ...pl.expenses.map((r) => [r.category, pence(r.total)]),
  ];

  const bankAccounts = await c.env.DB.prepare(
    `SELECT id, name FROM bank_accounts WHERE is_active = 1 ORDER BY name ASC`
  ).all<{ id: string; name: string }>();

  const accountTransactions: Array<{ accountName: string; rows: string[][] }> = [];
  for (const account of bankAccounts.results) {
    const txns = await c.env.DB.prepare(
      `SELECT t.date, t.description, t.amount, t.reference,
              t.is_reconciled, t.flagged,
              ec.name as category, t.notes, t.accountant_notes
       FROM transactions t
       LEFT JOIN expense_categories ec ON ec.id = t.expense_category_id
       WHERE t.bank_account_id = ? AND t.date BETWEEN ? AND ?
       ORDER BY t.date ASC`
    ).bind(account.id, range.from, range.to).all<{
      date: string; description: string; amount: number; reference: string | null;
      is_reconciled: number; flagged: number;
      category: string | null; notes: string | null; accountant_notes: string | null;
    }>();
    if (txns.results.length === 0) continue;
    accountTransactions.push({
      accountName: account.name,
      rows: [
        ['date', 'description', 'amount_gbp', 'category', 'notes', 'accountant_notes', 'reference', 'is_reconciled', 'flagged'],
        ...txns.results.map((r) => [
          r.date, r.description, pence(r.amount),
          r.category ?? '', r.notes ?? '', r.accountant_notes ?? '',
          r.reference ?? '', String(r.is_reconciled), String(r.flagged),
        ]),
      ],
    });
  }

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

  // Fetch bill attachments (supplier invoices received) for the tax year
  const billAttachmentRows = await c.env.DB.prepare(`
    SELECT b.id, b.bill_number, b.attachment_r2_key, b.attachment_filename
    FROM bills b
    WHERE b.issue_date BETWEEN ? AND ?
      AND b.attachment_r2_key IS NOT NULL
      AND b.status != 'void'
  `).bind(range.from, range.to).all<{
    id: string; bill_number: string | null;
    attachment_r2_key: string; attachment_filename: string | null;
  }>();

  const billAttachments: Array<{ name: string; data: Uint8Array }> = [];
  for (const row of billAttachmentRows.results) {
    const obj = await c.env.R2.get(row.attachment_r2_key);
    if (!obj) continue;
    const bytes = new Uint8Array(await obj.arrayBuffer());
    // Use original filename, prefixed with bill number for easy identification
    const prefix = row.bill_number ?? row.id.slice(0, 8).toUpperCase();
    const origName = row.attachment_filename ?? row.attachment_r2_key.split('/').pop() ?? 'attachment';
    billAttachments.push({ name: `${prefix}-${origName}`, data: bytes });
  }

  // Transaction-level expense receipts (bills attached directly to transactions)
  const txnAttachmentRows = await c.env.DB.prepare(
    `SELECT t.date, t.description, t.amount, t.attachment_r2_key, t.attachment_filename,
            ec.name as category_name
     FROM transactions t
     LEFT JOIN expense_categories ec ON ec.id = t.expense_category_id
     WHERE t.date BETWEEN ? AND ?
       AND t.attachment_r2_key IS NOT NULL
       AND t.amount < 0
     ORDER BY t.date ASC`
  ).bind(range.from, range.to).all<{
    date: string; description: string; amount: number;
    attachment_r2_key: string; attachment_filename: string | null;
    category_name: string | null;
  }>();

  const expenseReceipts: Array<{ name: string; data: Uint8Array }> = [];
  for (const row of txnAttachmentRows.results) {
    const obj = await c.env.R2.get(row.attachment_r2_key);
    if (!obj) continue;
    const bytes = new Uint8Array(await obj.arrayBuffer());
    const ext = row.attachment_filename?.split('.').pop() ?? 'pdf';
    const safeDesc = row.description.replace(/[^a-z0-9]/gi, '-').slice(0, 40);
    const filename = `${row.date}-${safeDesc}.${ext}`;
    expenseReceipts.push({ name: filename, data: bytes });
  }

  // Full invoice register for accountant verification
  const allInvoices = await c.env.DB.prepare(
    `SELECT i.invoice_number, c.name as client_name, i.issue_date, i.due_date,
            i.status, i.subtotal, i.tax_amount, i.total, i.amount_paid, i.notes
     FROM invoices i
     JOIN clients c ON i.client_id = c.id
     WHERE i.issue_date BETWEEN ? AND ?
       AND i.status != 'void'
     ORDER BY i.issue_date ASC`
  ).bind(range.from, range.to).all<{
    invoice_number: string; client_name: string; issue_date: string; due_date: string;
    status: string; subtotal: number; tax_amount: number; total: number; amount_paid: number; notes: string | null;
  }>();

  const invoiceRegisterRows: string[][] = [
    ['invoice_number', 'client', 'issue_date', 'due_date', 'status',
     'subtotal_gbp', 'vat_gbp', 'total_gbp', 'amount_paid_gbp', 'balance_gbp', 'notes'],
    ...allInvoices.results.map((r) => [
      r.invoice_number, r.client_name, r.issue_date, r.due_date, r.status,
      pence(r.subtotal), pence(r.tax_amount), pence(r.total),
      pence(r.amount_paid), pence(r.total - r.amount_paid), r.notes ?? '',
    ]),
  ];

  // Full bill register for accountant verification
  const allBills = await c.env.DB.prepare(
    `SELECT b.bill_number, v.name as vendor_name, b.issue_date, b.due_date,
            b.status, b.subtotal, b.tax_amount, b.total, b.amount_paid,
            b.flagged, b.accountant_notes, b.notes
     FROM bills b
     JOIN vendors v ON b.vendor_id = v.id
     WHERE b.issue_date BETWEEN ? AND ?
       AND b.status != 'void'
     ORDER BY b.issue_date ASC`
  ).bind(range.from, range.to).all<{
    bill_number: string | null; vendor_name: string; issue_date: string; due_date: string | null;
    status: string; subtotal: number; tax_amount: number; total: number; amount_paid: number;
    flagged: number; accountant_notes: string | null; notes: string | null;
  }>();

  const billRegisterRows: string[][] = [
    ['bill_number', 'vendor', 'issue_date', 'due_date', 'status',
     'subtotal_gbp', 'vat_gbp', 'total_gbp', 'amount_paid_gbp', 'balance_gbp',
     'flagged', 'accountant_notes', 'notes'],
    ...allBills.results.map((r) => [
      r.bill_number ?? '', r.vendor_name, r.issue_date, r.due_date ?? '', r.status,
      pence(r.subtotal), pence(r.tax_amount), pence(r.total),
      pence(r.amount_paid), pence(r.total - r.amount_paid),
      r.flagged ? 'yes' : 'no', r.accountant_notes ?? '', r.notes ?? '',
    ]),
  ];

  const zipBytes = assembleYearEndZip({
    incomeRows,
    expenseRows,
    accountTransactions,
    flaggedRows,
    invoiceRegisterRows,
    billRegisterRows,
    invoicePdfs,
    billAttachments,
    expenseReceipts,
    summaryPdf,
  });

  const headers = new Headers();
  headers.set('Content-Type', 'application/zip');
  headers.set('Content-Disposition', `attachment; filename="year-end-${taxYear}.zip"`);
  return new Response(zipBytes, { headers });
});

export { router as reportRoutes };
