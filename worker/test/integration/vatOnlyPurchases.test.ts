// A supplier backdates its VAT registration and charges the VAT on supplies already billed without
// it: a VAT-only bill (reclaimed in box 4, never an expense), or, with no bill, a bank payment in a
// VAT Suspense category. Uses 2015 dates, which no other test touches.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import app from '../../src/index';
import { issueAccessToken } from '../../src/middleware/auth';

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
const uid = () => crypto.randomUUID().replace(/-/g, '');
let ownerToken = '';
let ownerId = '';
let vendorId = '';
let services = '';
let suspense = '';

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

const vatReturn = async (from: string, to: string, scheme: 'standard' | 'cash') =>
  (await call('GET', `/api/v1/reports/vat-return?from=${from}&to=${to}&scheme=${scheme}`)).body;

async function bankLine(date: string, amount: number, category: string | null = null) {
  const id = uid();
  await env.DB.prepare(`
    INSERT INTO transactions (id, date, description, amount, expense_category_id, vat_rate, is_reconciled)
    VALUES (?, ?, 'ALBYTECH IT', ?, ?, ?, ?)
  `).bind(id, date, amount, category, category ? 0 : null, category ? 1 : 0).run();
  return id;
}

beforeAll(async () => {
  ownerId = uid();
  await env.DB.prepare(`INSERT INTO users (id, email, name, role, password_hash) VALUES (?, ?, 'O', 'owner', 'x')`)
    .bind(ownerId, `${ownerId}@test.local`).run();
  ownerToken = await issueAccessToken(ownerId, `${ownerId}@test.local`, 'owner', env.JWT_SECRET);
  vendorId = (await call('POST', '/api/v1/vendors', { name: 'Alby Tech' })).body.id;
  services = (await env.DB.prepare(`SELECT id FROM expense_categories WHERE name = 'Professional Services'`).first<{ id: string }>())!.id;
  suspense = (await env.DB.prepare(`SELECT id, vat_only, pl_line FROM expense_categories WHERE name = 'VAT Suspense'`)
    .first<{ id: string; vat_only: number; pl_line: string }>())!.id;
});

describe('a VAT-only bill', () => {
  it('holds just VAT: no net, nothing in box 7, the VAT in box 4 on its date', async () => {
    // The original supply, billed in January with no VAT
    await call('POST', '/api/v1/bills', { vendor_id: vendorId, bill_number: 'INV-047', issue_date: '2015-01-20', items: [
      { description: 'IT support January', quantity: 1, unit_price: 650_000, tax_rate: 0, expense_category_id: services },
    ] });
    // Alby's VAT invoice for it, after their backdated registration
    const vatBill = await call('POST', '/api/v1/bills', { vendor_id: vendorId, bill_number: 'VAT-047', issue_date: '2015-08-05', items: [
      { description: 'VAT on INV-047', quantity: 1, unit_price: 0, tax_rate: 0.2, vat_amount: 130_000, expense_category_id: services },
    ] });
    expect(vatBill.status).toBe(201);
    expect(vatBill.body.total).toBe(130_000);
    const bill = (await call('GET', `/api/v1/bills/${vatBill.body.id}`)).body;
    expect(bill).toMatchObject({ subtotal: 0, tax_amount: 130_000, total: 130_000 });
    expect(bill.items[0]).toMatchObject({ vat_amount: 130_000, amount: 0 });

    const q1 = await vatReturn('2015-01-01', '2015-03-31', 'standard');
    expect(q1).toMatchObject({ box4: 0, box7: 650_000 });
    const q3 = await vatReturn('2015-07-01', '2015-09-30', 'standard');
    expect(q3).toMatchObject({ box4: 130_000, box7: 0 });
  });

  it('is paid from the bank like any bill, and on cash accounting counts when paid', async () => {
    const vatBill = (await call('POST', '/api/v1/bills', { vendor_id: vendorId, bill_number: 'VAT-048', issue_date: '2015-08-06', items: [
      { description: 'VAT on INV-048', quantity: 1, unit_price: 0, tax_rate: 0.2, vat_amount: 148_000, expense_category_id: services },
    ] })).body;
    const line = await bankLine('2015-10-02', -148_000);
    expect((await call('POST', '/api/v1/transaction-matches', { transactionId: line, type: 'bill', targetId: vatBill.id, allocatedAmount: 148_000 })).status).toBe(201);
    expect((await call('POST', `/api/v1/transactions/${line}/post`)).status).toBe(200);

    expect(await vatReturn('2015-10-01', '2015-12-31', 'cash')).toMatchObject({ box4: 148_000, box7: 0 });
    // Never an expense: the VAT comes back from HMRC
    const pl = (await call('GET', '/api/v1/reports/pl?from=2015-10-01&to=2015-12-31')).body;
    expect(pl.totalExpenses).toBe(0);
  });

  it('refuses a VAT amount on a line that also has a price', async () => {
    const res = await call('POST', '/api/v1/bills', { vendor_id: vendorId, issue_date: '2015-08-07', items: [
      { description: 'Mixed', quantity: 1, unit_price: 1_000, tax_rate: 0.2, vat_amount: 200 },
    ] });
    expect(res.status).toBe(400);
  });
});

describe('VAT Suspense', () => {
  it('is set up out of the P&L, with every line entirely VAT', async () => {
    const cat = (await call('GET', '/api/v1/expense-categories')).body.find((c: Json) => c.id === suspense);
    expect(cat).toMatchObject({ vat_only: 1, pl_line: 'excluded', default_vat_rate: 0 });
  });

  it('puts VAT paid with no bill in box 4, and VAT received with no invoice in box 1', async () => {
    await bankLine('2015-05-04', -24_000, suspense);   // VAT paid to a supplier, nothing to match
    await bankLine('2015-05-05', 6_000, suspense);     // a customer paying only their VAT
    for (const scheme of ['standard', 'cash'] as const) {
      expect(await vatReturn('2015-04-01', '2015-06-30', scheme)).toMatchObject({
        box1: 6_000, box4: 24_000, box5: 6_000 - 24_000, box6: 0, box7: 0,
      });
    }
    const pl = (await call('GET', '/api/v1/reports/pl?from=2015-04-01&to=2015-06-30')).body;
    expect(pl.totalExpenses).toBe(0);
    expect(pl.totalIncome).toBe(0);
  });
});

describe('categories on bills', () => {
  it('posts a payment to a VAT-only bill with no category, but not to an ordinary bill without one', async () => {
    const vatBill = (await call('POST', '/api/v1/bills', { vendor_id: vendorId, issue_date: '2015-11-01', items: [
      { description: 'VAT on INV-049', quantity: 1, unit_price: 0, tax_rate: 0.2, vat_amount: 20_000 },
    ] })).body;
    const paid = await bankLine('2015-11-02', -20_000);
    await call('POST', '/api/v1/transaction-matches', { transactionId: paid, type: 'bill', targetId: vatBill.id, allocatedAmount: 20_000 });
    expect((await call('POST', `/api/v1/transactions/${paid}/post`)).status).toBe(200);

    const plain = (await call('POST', '/api/v1/bills', { vendor_id: vendorId, issue_date: '2015-11-03', items: [
      { description: 'Support', quantity: 1, unit_price: 10_000, tax_rate: 0 },
    ] })).body;
    const line = await bankLine('2015-11-04', -10_000);
    await call('POST', '/api/v1/transaction-matches', { transactionId: line, type: 'bill', targetId: plain.id, allocatedAmount: 10_000 });
    const refused = await call('POST', `/api/v1/transactions/${line}/post`);
    expect(refused).toMatchObject({ status: 422, body: { error: expect.stringMatching(/Give every line on the bill a category/) } });

    // Fixed from the bill page, the line then posts. Leaving it with no category is a no-op
    // until one is set; after that, clearing it is refused so the payment can't fall into Other.
    const items = (await call('GET', `/api/v1/bills/${plain.id}`)).body.items;
    expect((await call('PATCH', `/api/v1/bills/${plain.id}/categories`, {
      items: [{ id: items[0].id, expense_category_id: null }],
    })).body).toEqual({ ok: true, changed: 0 });
    const set = await call('PATCH', `/api/v1/bills/${plain.id}/categories`, { items: [{ id: items[0].id, expense_category_id: services }] });
    expect(set.body).toEqual({ ok: true, changed: 1 });
    expect((await call('PATCH', `/api/v1/bills/${plain.id}/categories`, {
      items: [{ id: items[0].id, expense_category_id: null }],
    })).status).toBe(422);
    expect((await call('POST', `/api/v1/transactions/${line}/post`)).status).toBe(200);

    // A VAT-only line may still be given a category and then have it taken off
    const vatItems = (await call('GET', `/api/v1/bills/${vatBill.id}`)).body.items;
    expect((await call('PATCH', `/api/v1/bills/${vatBill.id}/categories`, {
      items: [{ id: vatItems[0].id, expense_category_id: services }],
    })).body.changed).toBe(1);
    expect((await call('PATCH', `/api/v1/bills/${vatBill.id}/categories`, {
      items: [{ id: vatItems[0].id, expense_category_id: null }],
    })).body.changed).toBe(1);
  });

  it('edits an unpaid bill, and moves a paid bill’s category until the quarter is locked', async () => {
    const unpaid = (await call('POST', '/api/v1/bills', { vendor_id: vendorId, issue_date: '2015-11-09', bill_number: 'BEFORE', items: [
      { description: 'Paper', quantity: 1, unit_price: 2_000, tax_rate: 0, expense_category_id: services },
    ] })).body;
    expect((await call('PUT', `/api/v1/bills/${unpaid.id}`, { vendor_id: vendorId, bill_number: 'AFTER', issue_date: '2015-11-09', items: [
      { description: 'Paper', quantity: 1, unit_price: 2_500, tax_rate: 0, expense_category_id: services },
    ] })).status).toBe(200);
    expect((await call('GET', `/api/v1/bills/${unpaid.id}`)).body).toMatchObject({ bill_number: 'AFTER', total: 2_500 });

    const bill = (await call('POST', '/api/v1/bills', { vendor_id: vendorId, issue_date: '2015-11-10', items: [
      { description: 'Laptop', quantity: 1, unit_price: 50_000, tax_rate: 0.2, expense_category_id: services },
    ] })).body;
    await call('POST', `/api/v1/bills/${bill.id}/payments`, { amount: 60_000, payment_date: '2015-11-11', method: 'card' });
    const office = (await env.DB.prepare(`SELECT id FROM expense_categories WHERE name = 'Office Supplies'`).first<{ id: string }>())!.id;
    const itemId = (await call('GET', `/api/v1/bills/${bill.id}`)).body.items[0].id;

    // The full edit is refused once paid; the categories alone are not, and the cost follows them
    expect((await call('PUT', `/api/v1/bills/${bill.id}`, { vendor_id: vendorId, items: [
      { description: 'Laptop', quantity: 1, unit_price: 40_000, tax_rate: 0.2, expense_category_id: services },
    ] })).status).toBe(409);
    expect((await call('PATCH', `/api/v1/bills/${bill.id}/categories`, { items: [{ id: itemId, expense_category_id: office }] })).body.changed).toBe(1);
    const history = (await call('GET', `/api/v1/audit/bill/${bill.id}`)).body;
    expect(history.at(-1)).toMatchObject({ summary: 'Changed the category of 1 line' });
    expect((await call('PATCH', `/api/v1/bills/${bill.id}/categories`, { items: [{ id: 'nope', expense_category_id: office }] })).status).toBe(422);
    expect((await call('PATCH', `/api/v1/bills/${bill.id}/categories`, { items: [{ id: itemId, expense_category_id: null }] })).status).toBe(422);

    const pl = (await call('GET', '/api/v1/reports/pl?from=2015-11-01&to=2015-11-30')).body;
    expect(pl.expenses).toEqual(expect.arrayContaining([
      { category: 'Office Supplies', total: 50_000 },
      { category: 'Professional Services', total: 10_000 },
    ]));

    // A lock covering the payment stops it: the change would move a reviewed quarter's P&L
    const lock = await call('POST', '/api/v1/periods/lock', { periodEnd: '2015-12-31' });
    expect(lock.status, JSON.stringify(lock.body)).toBe(201);
    try {
      expect((await call('PATCH', `/api/v1/bills/${bill.id}/categories`, { items: [{ id: itemId, expense_category_id: services }] })).status).toBe(423);
      expect((await call('GET', `/api/v1/bills/${bill.id}`)).body.items[0].expense_category_id).toBe(office);
    } finally {
      expect((await call('POST', '/api/v1/periods/unlock', { reason: 'Test over' })).status).toBe(200);
    }
  });
});

