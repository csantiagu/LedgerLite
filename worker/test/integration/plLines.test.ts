// What the profit and loss counts from bank lines: each category says expense, income, or nothing.
// Loans, transfers and tax payments aren't profit or loss; a supplier refund reduces an expense; a
// card sale with no invoice is other income. Uses 2017 dates, which no other test touches.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import app from '../../src/index';
import { issueAccessToken } from '../../src/middleware/auth';

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
const uid = () => crypto.randomUUID().replace(/-/g, '');
let ownerToken = '';
let ownerId = '';

type Json = any;   // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const res = await app.fetch(new Request(`http://api.test${path}`, {
    method,
    headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env, ctx);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

/** A category for this test, with where it goes in the P&L */
async function category(name: string, plLine: 'expense' | 'income' | 'excluded') {
  const res = await call('POST', '/api/v1/expense-categories', { name: `${name} ${uid().slice(0, 4)}`, plLine });
  expect(res.status).toBe(201);
  return { id: res.body.id as string, name: (await env.DB.prepare('SELECT name FROM expense_categories WHERE id = ?')
    .bind(res.body.id).first<{ name: string }>())!.name };
}

async function posted(date: string, amount: number, categoryId: string, vatRate = 0) {
  const id = uid();
  await env.DB.prepare(`
    INSERT INTO transactions (id, date, description, amount, expense_category_id, vat_rate, is_reconciled)
    VALUES (?, ?, 'PL TEST', ?, ?, ?, 1)
  `).bind(id, date, amount, categoryId, vatRate).run();
  return id;
}

let office: { id: string; name: string };
let wages: { id: string; name: string };
let sales: { id: string; name: string };
let loan: { id: string; name: string };
let transfer: { id: string; name: string };

beforeAll(async () => {
  ownerId = uid();
  await env.DB.prepare(`INSERT INTO users (id, email, name, role, password_hash) VALUES (?, ?, 'O', 'owner', 'x')`)
    .bind(ownerId, `${ownerId}@test.local`).run();
  ownerToken = await issueAccessToken(ownerId, `${ownerId}@test.local`, 'owner', env.JWT_SECRET);
  office = await category('Stationery', 'expense');
  wages = await category('Wages', 'expense');
  sales = await category('Card sales', 'income');
  loan = await category('Bank loan', 'excluded');
  transfer = await category('Transfers', 'excluded');

  await posted('2017-03-01', -12_000, office.id, 0.2);     // £100 + £20 VAT: £100 expense
  await posted('2017-03-02', 2_400, office.id, 0.2);       // supplier refund: −£20 expense
  await posted('2017-03-03', -150_000, wages.id);          // wages: £1,500 expense, no VAT
  await posted('2017-03-04', 6_000, sales.id, 0.2);        // card sale: £50 other income
  await posted('2017-03-05', -50_000, loan.id);            // loan repayment: not in the P&L
  await posted('2017-03-06', -20_000, transfer.id);        // transfer to savings: not in the P&L
  await posted('2017-03-07', 20_000, transfer.id);         // and back: not in the P&L
});

describe('bank lines in the profit and loss', () => {
  it('counts expense and income categories, and leaves loans and transfers out', async () => {
    const pl = (await call('GET', '/api/v1/reports/pl?from=2017-03-01&to=2017-03-31')).body;
    const expense = (name: string) => pl.expenses.find((e: Json) => e.category === name)?.total;
    expect(expense(office.name)).toBe(10_000 - 2_000);
    expect(expense(wages.name)).toBe(150_000);
    expect(expense(loan.name)).toBeUndefined();
    expect(expense(transfer.name)).toBeUndefined();
    expect(pl.income).toContainEqual({ client_name: `Other income: ${sales.name}`, total: 5_000 });
    expect(pl.totalIncome).toBe(5_000);
    expect(pl.totalExpenses).toBe(158_000);
    expect(pl.net).toBe(5_000 - 158_000);
  });

  it('counts only the part of a line not matched to a bill', async () => {
    const vendor = (await call('POST', '/api/v1/vendors', { name: 'PL Supplier' })).body.id;
    const bill = (await call('POST', '/api/v1/bills', { vendor_id: vendor, issue_date: '2017-04-01', items: [
      { description: 'Paper', quantity: 1, unit_price: 3_000, tax_rate: 0, expense_category_id: office.id },
    ] })).body.id;
    const line = await posted('2017-04-02', -5_000, office.id);
    await env.DB.prepare('UPDATE transactions SET is_reconciled = 0 WHERE id = ?').bind(line).run();
    expect((await call('POST', '/api/v1/transaction-matches', { transactionId: line, type: 'bill', targetId: bill, allocatedAmount: 3_000 })).status).toBe(201);
    expect((await call('POST', `/api/v1/transactions/${line}/post`)).status).toBe(200);

    const pl = (await call('GET', '/api/v1/reports/pl?from=2017-04-01&to=2017-04-30')).body;
    // £30 through the bill payment, £20 from the rest of the line: £50 in all, never £80
    expect(pl.expenses.find((e: Json) => e.category === office.name).total).toBe(5_000);
  });

  it('lets the owner move a category in or out of the P&L', async () => {
    await call('PUT', `/api/v1/expense-categories/${loan.id}`, { name: loan.name, plLine: 'expense' });
    const pl = (await call('GET', '/api/v1/reports/pl?from=2017-03-01&to=2017-03-31')).body;
    expect(pl.expenses.find((e: Json) => e.category === loan.name)?.total).toBe(50_000);
    await call('PUT', `/api/v1/expense-categories/${loan.id}`, { name: loan.name, plLine: 'excluded' });
  });

  it("makes the dashboard's revenue this year the P&L's income for the year so far", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const [dashboard, pl] = await Promise.all([
      call('GET', '/api/v1/reports/dashboard'),
      call('GET', `/api/v1/reports/pl?from=${today.slice(0, 4)}-01-01&to=${today}`),
    ]);
    expect(dashboard.body.ytd_revenue_pence).toBe(pl.body.totalIncome);
  });
});
