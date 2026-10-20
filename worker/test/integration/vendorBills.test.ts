// A vendor's bills, and a bill created for a bank payment then matched and posted to it
// (the "Create bill" flow from Find match in For Review).
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import app from '../../src/index';
import { issueAccessToken } from '../../src/middleware/auth';

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
const uid = () => crypto.randomUUID().replace(/-/g, '');
let token = '';
let ownerId = '';
let accountId = '';

async function call(method: string, path: string, body?: unknown) {
  const res = await app.fetch(new Request(`http://api.test${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env, ctx);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

const newVendor = async (name: string) => (await call('POST', '/api/v1/vendors', { name })).body.id as string;

const newBill = (vendorId: string, net: number, taxRate = 0, categoryId: string | null = null) =>
  call('POST', '/api/v1/bills', {
    vendor_id: vendorId,
    issue_date: '2026-10-01',
    items: [{ description: 'Receipt', quantity: 1, unit_price: net, tax_rate: taxRate, expense_category_id: categoryId }],
  });

beforeAll(async () => {
  ownerId = uid();
  accountId = uid();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (id, email, name, role, password_hash) VALUES (?, ?, 'O', 'owner', 'x')`)
      .bind(ownerId, `${ownerId}@test.local`),
    env.DB.prepare(`INSERT INTO bank_accounts (id, name, bank_name, csv_format, created_by) VALUES (?, 'V', 'B', 'monzo', ?)`)
      .bind(accountId, ownerId),
  ]);
  token = await issueAccessToken(ownerId, `${ownerId}@test.local`, 'owner', env.JWT_SECRET);
});

describe('vendor bills', () => {
  it('lists only the chosen vendor’s bills with ?vendor_id', async () => {
    const a = await newVendor('Vendor A');
    const b = await newVendor('Vendor B');
    const billA = (await newBill(a, 1_000)).body.id;
    await newBill(b, 2_000);

    const { body: rows } = await call('GET', `/api/v1/bills?vendor_id=${a}`);
    expect(rows.map((r: { id: string }) => r.id)).toEqual([billA]);
  });

  it('returns the server-calculated total when a bill is created', async () => {
    const v = await newVendor('Vendor VAT');
    const res = await newBill(v, 10_000, 0.2);
    expect(res.status).toBe(201);
    expect(res.body.total).toBe(12_000);
  });
});

describe('creating a bill for a bank payment', () => {
  it('matches it to the line, and posting the line pays the bill', async () => {
    const v = await newVendor('Screwfix');
    const txnId = uid();
    await env.DB.prepare(
      `INSERT INTO transactions (id, bank_account_id, date, description, amount) VALUES (?, ?, '2026-10-02', 'SCREWFIX', ?)`
    ).bind(txnId, accountId, -12_000).run();

    const category = await env.DB.prepare('SELECT id FROM expense_categories LIMIT 1').first<{ id: string }>();
    const { body: created } = await newBill(v, 10_000, 0.2, category!.id);
    const match = await call('POST', '/api/v1/transaction-matches', {
      transactionId: txnId, type: 'bill', targetId: created.id, allocatedAmount: created.total,
    });
    expect(match.status).toBe(201);
    const open = await call('GET', `/api/v1/bills/${created.id}`);
    expect(open.body).toMatchObject({ pending_bank_matches: 1, bank_matches: 1 });

    const posted = await call('POST', `/api/v1/transactions/${txnId}/post`);
    expect(posted.body.error).toBeUndefined();
    expect(posted.status).toBe(200);
    const bill = await env.DB.prepare('SELECT status, amount_paid FROM bills WHERE id = ?')
      .bind(created.id).first<{ status: string; amount_paid: number }>();
    expect(bill).toEqual({ status: 'paid', amount_paid: 12_000 });
    // The bank line takes the bill's category, so the P&L counts the payment once, under it
    const line = await env.DB.prepare('SELECT is_reconciled, expense_category_id FROM transactions WHERE id = ?')
      .bind(txnId).first<{ is_reconciled: number; expense_category_id: string }>();
    expect(line).toEqual({ is_reconciled: 1, expense_category_id: category!.id });
  });

  it('refuses to post when a bill line has no category, even if the bank line does', async () => {
    const v = await newVendor('No Category Ltd');
    const txnId = uid();
    const category = await env.DB.prepare('SELECT id FROM expense_categories LIMIT 1').first<{ id: string }>();
    await env.DB.prepare(
      `INSERT INTO transactions (id, bank_account_id, date, description, amount, expense_category_id) VALUES (?, ?, '2026-10-03', 'NOCAT', ?, ?)`
    ).bind(txnId, accountId, -5_000, category!.id).run();
    const { body: created } = await newBill(v, 5_000);
    await call('POST', '/api/v1/transaction-matches', {
      transactionId: txnId, type: 'bill', targetId: created.id, allocatedAmount: 5_000,
    });

    const posted = await call('POST', `/api/v1/transactions/${txnId}/post`);
    expect(posted.status).toBe(422);
    expect(posted.body.error).toMatch(/every line/);
    const bill = await env.DB.prepare('SELECT status, amount_paid FROM bills WHERE id = ?')
      .bind(created.id).first<{ status: string; amount_paid: number }>();
    expect(bill).toEqual({ status: 'pending', amount_paid: 0 });
  });

  it('refuses to post when only some bill lines have a category', async () => {
    const v = await newVendor('Mixed Lines Ltd');
    const txnId = uid();
    await env.DB.prepare(
      `INSERT INTO transactions (id, bank_account_id, date, description, amount) VALUES (?, ?, '2026-10-04', 'MIXED', ?)`
    ).bind(txnId, accountId, -5_000).run();
    const category = await env.DB.prepare('SELECT id FROM expense_categories LIMIT 1').first<{ id: string }>();
    const { body: created } = await newBill(v, 5_000, 0, category!.id);
    await env.DB.prepare(
      `INSERT INTO bill_items (bill_id, description, quantity, unit_price, tax_rate, amount, expense_category_id, sort_order)
       VALUES (?, 'Uncategorised', 1, 3000, 0, 3000, NULL, 1)`
    ).bind(created.id).run();
    await call('POST', '/api/v1/transaction-matches', {
      transactionId: txnId, type: 'bill', targetId: created.id, allocatedAmount: 5_000,
    });

    const posted = await call('POST', `/api/v1/transactions/${txnId}/post`);
    expect(posted.status).toBe(422);
    expect(posted.body.error).toMatch(/every line/);
  });
});
