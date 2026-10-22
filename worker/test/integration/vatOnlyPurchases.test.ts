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
