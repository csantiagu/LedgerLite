// VAT accuracy: credit notes, refunds, sales outside the scope of UK VAT, and the VAT return
// boxes for a worked quarter (2018, which no other test uses).
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import app from '../../src/index';
import { issueAccessToken } from '../../src/middleware/auth';

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
const uid = () => crypto.randomUUID().replace(/-/g, '');
let ownerToken = '';
let ownerId = '';
let ukClient = '';
let overseasClient = '';
let vendorId = '';
let officeId = '';
let salesId = '';
let loanId = '';

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

const line = (description: string, unit_price: number, tax_rate = 0.2, quantity = 1) =>
  ({ description, quantity, unit_price, tax_rate });

/** A finalised invoice. */
async function issued(client: string, date: string, items: Json[], extra: Json = {}) {
  const created = await call('POST', '/api/v1/invoices', { client_id: client, issue_date: date, due_date: '2099-01-01', items, ...extra });
  expect(created.status).toBe(201);
  expect((await call('POST', `/api/v1/invoices/${created.body.id}/finalize`)).status).toBe(200);
  return created.body as { id: string; invoice_number: string };
}

const invoice = async (id: string) => (await call('GET', `/api/v1/invoices/${id}`)).body;

async function postedLine(date: string, amount: number, category: string, vatRate: number) {
  const id = uid();
  await env.DB.prepare(`
    INSERT INTO transactions (id, date, description, amount, expense_category_id, vat_rate, is_reconciled)
    VALUES (?, ?, 'VAT TEST', ?, ?, ?, 1)
  `).bind(id, date, amount, category, vatRate).run();
  return id;
}

/** A category's id, adding it (with its VAT-return box) when the seed data doesn't have it */
async function categoryId(name: string, vatBox: 'purchases' | 'sales' | 'excluded') {
  const found = await env.DB.prepare('SELECT id FROM expense_categories WHERE name = ?').bind(name).first<{ id: string }>();
  if (found) {
    await call('PUT', `/api/v1/expense-categories/${found.id}`, { name, vatBox });
    return found.id;
  }
  const created = await call('POST', '/api/v1/expense-categories', { name, vatBox });
  expect(created.status).toBe(201);
  return created.body.id as string;
}

beforeAll(async () => {
  ownerId = uid();
  await env.DB.prepare(`INSERT INTO users (id, email, name, role, password_hash) VALUES (?, ?, 'O', 'owner', 'x')`)
    .bind(ownerId, `${ownerId}@test.local`).run();
  ownerToken = await issueAccessToken(ownerId, `${ownerId}@test.local`, 'owner', env.JWT_SECRET);
  ukClient = (await call('POST', '/api/v1/clients', { name: 'UK Client Ltd' })).body.id;
  overseasClient = (await call('POST', '/api/v1/clients', { name: 'Overseas GmbH', vat_treatment: 'outside_scope' })).body.id;
  vendorId = (await call('POST', '/api/v1/vendors', { name: 'VAT Supplies' })).body.id;
  officeId = await categoryId('Office Supplies', 'purchases');
  salesId = await categoryId('Sales Income', 'sales');
  loanId = await categoryId('Loan', 'excluded');
});

describe('VAT rates and overseas customers', () => {
  it('only takes 0%, 5% or 20% on new lines', async () => {
    const res = await call('POST', '/api/v1/invoices', {
      client_id: ukClient, issue_date: '2018-01-05', due_date: '2018-02-05', items: [line('Odd', 1_000, 0.175)],
    });
    expect(res.status).toBe(400);
  });

  it("invoices an overseas customer outside the scope of UK VAT, with no VAT", async () => {
    const refused = await call('POST', '/api/v1/invoices', {
      client_id: overseasClient, issue_date: '2018-01-05', due_date: '2018-02-05', items: [line('Consulting', 10_000)],
    });
    expect(refused).toMatchObject({ status: 422, body: { error: expect.stringMatching(/outside the scope of UK VAT/) } });
    const ok = await issued(overseasClient, '2018-01-06', [line('Consulting', 10_000, 0)]);
    expect(await invoice(ok.id)).toMatchObject({ vat_treatment: 'outside_scope', tax_amount: 0, total: 10_000 });
  });
});

describe('credit notes', () => {
  it('credits a whole unpaid invoice, settling it, with its own number and PDF', async () => {
    const inv = await issued(ukClient, '2018-01-10', [line('Design', 50_000)]);
    const cn = await call('POST', `/api/v1/invoices/${inv.id}/credit-note`, { issue_date: '2018-01-20', reason: 'Wrong client' });
    expect(cn.status).toBe(201);
    expect(cn.body).toMatchObject({ invoice_number: expect.stringMatching(/^CN-\d{4}$/), total: 60_000, applied: 60_000, credit_left: 0 });

    const original = await invoice(inv.id);
    expect(original).toMatchObject({ status: 'paid', amount_paid: 60_000, credit_applied: 60_000 });
    expect(original.credit_notes).toEqual([expect.objectContaining({ id: cn.body.id, total: 60_000, applied: 60_000 })]);
    const note = await invoice(cn.body.id);
    expect(note).toMatchObject({
      kind: 'credit_note', status: 'paid', subtotal: 50_000, tax_amount: 10_000,
      credits: expect.objectContaining({ id: inv.id }), credit_reason: 'Wrong client', credit_left: 0,
    });
    expect(note.pdf_r2_key).toBeTruthy();
    expect((await call('POST', `/api/v1/invoices/${inv.id}/credit-note`, { issue_date: '2018-01-21', reason: 'Again' })).status).toBe(409);
    // A credit note never goes overdue, and isn't money owed to you
    expect((await call('GET', '/api/v1/invoices?kind=credit_note')).body.some((r: Json) => r.status === 'overdue')).toBe(false);
  });

  it('credits part of a paid invoice, leaving the credit to refund', async () => {
    const inv = await issued(ukClient, '2018-02-01', [line('Hours', 10_000, 0.2, 3)]);   // £300 + £60 VAT
    expect((await call('POST', `/api/v1/invoices/${inv.id}/payments`, { amount: 36_000, payment_date: '2018-02-05', method: 'bank_transfer' })).status).toBe(201);

    const tooMuch = await call('POST', `/api/v1/invoices/${inv.id}/credit-note`, {
      issue_date: '2018-02-10', reason: 'Overcharged', items: [line('Hours', 10_000, 0.2, 4)],
    });
    expect(tooMuch.status).toBe(422);
    const wrongRate = await call('POST', `/api/v1/invoices/${inv.id}/credit-note`, {
      issue_date: '2018-02-10', reason: 'Overcharged', items: [line('Hours', 10_000, 0)],
    });
    expect(wrongRate.body.error).toMatch(/takes the VAT rate of the invoice it credits \(20%\)/);

    const cn = await call('POST', `/api/v1/invoices/${inv.id}/credit-note`, {
      issue_date: '2018-02-10', reason: 'One hour overcharged', items: [line('Hours', 10_000)],
    });
    expect(cn.body).toMatchObject({ total: 12_000, applied: 0, credit_left: 12_000 });

    // Refund by hand: a payment on the credit note, money back to the customer
    const refund = await call('POST', `/api/v1/invoices/${cn.body.id}/payments`, { amount: 12_000, payment_date: '2018-02-12', method: 'bank_transfer' });
    expect(refund.status).toBe(201);
    expect(await invoice(cn.body.id)).toMatchObject({ status: 'paid', credit_left: 0 });
    // The refund takes income away in the cash-basis P&L: £300 net received, £100 net refunded
    const pl = (await call('GET', '/api/v1/reports/pl?from=2018-02-01&to=2018-02-28')).body;
    expect(pl.totalIncome).toBe(20_000);
  });

  it('can be refunded from the bank: money out matched to the credit note', async () => {
    const inv = await issued(ukClient, '2018-02-15', [line('Retainer', 5_000)]);
    await call('POST', `/api/v1/invoices/${inv.id}/payments`, { amount: 6_000, payment_date: '2018-02-16', method: 'bank_transfer' });
    const cn = (await call('POST', `/api/v1/invoices/${inv.id}/credit-note`, { issue_date: '2018-02-20', reason: 'Cancelled' })).body;

    const moneyIn = uid();
    const moneyOut = uid();
    await env.DB.batch([moneyIn, moneyOut].map((id, i) => env.DB.prepare(
      `INSERT INTO transactions (id, date, description, amount) VALUES (?, '2018-02-21', 'REFUND', ?)`
    ).bind(id, i ? -6_000 : 6_000)));

    const search = await call('GET', `/api/v1/match-search?transactionId=${moneyOut}&all=1`);
    expect(search.body.results).toContainEqual(expect.objectContaining({ id: cn.id, refund: true }));
    expect((await call('POST', '/api/v1/transaction-matches', { transactionId: moneyIn, type: 'invoice', targetId: cn.id, allocatedAmount: 6_000 })).body.error)
      .toMatch(/Only money going out can be matched to a credit note/);
    expect((await call('POST', '/api/v1/transaction-matches', { transactionId: moneyOut, type: 'invoice', targetId: cn.id, allocatedAmount: 6_000 })).status).toBe(201);
    expect((await call('POST', `/api/v1/transactions/${moneyOut}/post`)).status).toBe(200);
    expect(await invoice(cn.id)).toMatchObject({ status: 'paid', credit_left: 0 });

    // Undo puts the credit back as unrefunded, not overdue
    expect((await call('POST', `/api/v1/transactions/${moneyOut}/undo`)).status).toBe(200);
    expect(await invoice(cn.id)).toMatchObject({ status: 'sent', credit_left: 6_000 });
  });

  it('voids a credit note, giving its credit back to the invoice; the invoice waits for its credit notes', async () => {
    const inv = await issued(ukClient, '2018-03-01', [line('Audit', 20_000)]);
    const cn = (await call('POST', `/api/v1/invoices/${inv.id}/credit-note`, {
      issue_date: '2018-03-02', reason: 'Part cancelled', items: [line('Audit', 5_000)],
    })).body;
    expect(await invoice(inv.id)).toMatchObject({ status: 'partial', amount_paid: 6_000 });
    expect((await call('POST', `/api/v1/invoices/${inv.id}/void`)).body.error).toMatch(/has credit note .* Void that first/);

    expect((await call('POST', `/api/v1/invoices/${cn.id}/void`)).status).toBe(200);
    expect(await invoice(inv.id)).toMatchObject({ status: 'sent', amount_paid: 0, credit_applied: 0 });
    expect((await call('POST', `/api/v1/invoices/${inv.id}/void`)).status).toBe(200);
  });

  it("can't credit a draft, another credit note, or be dated before the invoice", async () => {
    const draft = (await call('POST', '/api/v1/invoices', { client_id: ukClient, issue_date: '2018-03-05', due_date: '2018-04-05', items: [line('X', 100)] })).body;
    expect((await call('POST', `/api/v1/invoices/${draft.id}/credit-note`, { issue_date: '2018-03-06', reason: 'Nope' })).status).toBe(409);
    const inv = await issued(ukClient, '2018-03-05', [line('Y', 100)]);
    expect((await call('POST', `/api/v1/invoices/${inv.id}/credit-note`, { issue_date: '2018-03-04', reason: 'Early' })).status).toBe(422);
    const cn = (await call('POST', `/api/v1/invoices/${inv.id}/credit-note`, { issue_date: '2018-03-06', reason: 'Fine' })).body;
    expect((await call('POST', `/api/v1/invoices/${cn.id}/credit-note`, { issue_date: '2018-03-07', reason: 'Nope' })).status).toBe(409);
  });
});

describe('the VAT return', () => {
  // A quarter of its own: Apr–Jun 2018
  beforeAll(async () => {
    await issued(ukClient, '2018-04-05', [line('Website', 100_000)]);                        // £1,000 + £200 VAT
    const part = await issued(ukClient, '2018-04-10', [line('Support', 20_000)]);            // £200 + £40 VAT
    await call('POST', `/api/v1/invoices/${part.id}/credit-note`, { issue_date: '2018-05-01', reason: 'Half refunded', items: [line('Support', 10_000)] });
    await issued(overseasClient, '2018-04-20', [line('Consulting abroad', 50_000, 0)]);       // £500, outside scope
    const bill = await call('POST', '/api/v1/bills', { vendor_id: vendorId, issue_date: '2018-05-10', items: [
      { description: 'Laptop', quantity: 1, unit_price: 80_000, tax_rate: 0.2, expense_category_id: officeId },
    ] });                                                                                      // £800 + £160 VAT
    expect(bill.status).toBe(201);
    await postedLine('2018-06-01', -2_400, officeId, 0.2);     // £20 + £4 VAT
    await postedLine('2018-06-02', 1_200, officeId, 0.2);      // a supplier refund: −£10, −£2 VAT
    await postedLine('2018-06-03', 3_600, salesId, 0.2);       // card sale with no invoice: £30 + £6 VAT
    await postedLine('2018-06-04', -50_000, loanId, 0);        // a loan repayment: not in the return
  });

  it('works out the nine boxes on standard accounting (by invoice and bill date)', async () => {
    const r = (await call('GET', '/api/v1/reports/vat-return?from=2018-04-01&to=2018-06-30&scheme=standard')).body;
    expect(r).toMatchObject({
      scheme: 'standard',
      box1: 20_000 + 4_000 - 2_000 + 600,                // invoices − credit note + card sale
      box4: 16_000 + 400 - 200,                          // bill + bank purchase − supplier refund
      box6: 100_000 + 20_000 - 10_000 + 50_000 + 3_000,  // outside-scope sale counted, no VAT
      box7: 80_000 + 2_000 - 1_000,                      // the loan repayment is left out
      box2: 0, box8: 0, box9: 0, vatNotSet: 0,
    });
    expect(r.box3).toBe(r.box1);
    expect(r.box5).toBe(r.box1 - r.box4);
    expect(r.parts).toContainEqual(expect.objectContaining({ source: 'Invoices (outside the scope of UK VAT)', vat: 0, net: 50_000 }));
  });

  it('works out the boxes on cash accounting (by when money moved)', async () => {
    const r = (await call('GET', '/api/v1/reports/vat-return?from=2018-04-01&to=2018-06-30&scheme=cash')).body;
    // No invoice or bill in the quarter was paid: only the bank lines count
    expect(r).toMatchObject({ box1: 600, box4: 200, box6: 3_000, box7: 1_000 });
  });

  it('follows the company setting when no scheme is asked for', async () => {
    await call('PATCH', '/api/v1/settings/company', { vat_scheme: 'cash' });
    expect((await call('GET', '/api/v1/reports/vat-return?from=2018-04-01&to=2018-06-30')).body.scheme).toBe('cash');
    await call('PATCH', '/api/v1/settings/company', { vat_scheme: 'standard' });
  });
});
