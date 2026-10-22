// Correcting reviewed VAT quarters: lock snapshots and what has changed since, VAT that can't be
// reclaimed, full credits of imported invoices, and credit note numbers with no gaps. 2016 dates.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import app from '../../src/index';
import { issueAccessToken } from '../../src/middleware/auth';

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
const uid = () => crypto.randomUUID().replace(/-/g, '');
let ownerToken = '';
let ownerId = '';
let clientId = '';
let vendorId = '';
let entertainment = '';

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

/** An issued invoice written straight to the books: one line, with these stored totals. */
async function invoice(date: string, subtotal: number, tax: number, lineRate = 0.2, extra: Json = {}) {
  const id = uid();
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO invoices (id, client_id, invoice_number, status, issue_date, due_date, subtotal, tax_amount, total, created_by, source)
      VALUES (?, ?, ?, 'sent', ?, '2099-01-01', ?, ?, ?, ?, ?)
    `).bind(id, clientId, `VC-${id.slice(0, 10)}`, date, subtotal, tax, subtotal + tax, ownerId, extra.source ?? 'ledgerlite'),
    env.DB.prepare(`
      INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, tax_rate, amount, sort_order)
      VALUES (?, 'Work', 1, ?, ?, ?, 0)
    `).bind(id, subtotal, lineRate, subtotal),
  ]);
  return id;
}

beforeAll(async () => {
  ownerId = uid();
  clientId = uid();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (id, email, name, role, password_hash) VALUES (?, ?, 'O', 'owner', 'x')`)
      .bind(ownerId, `${ownerId}@test.local`),
    env.DB.prepare(`INSERT INTO clients (id, name, created_by) VALUES (?, 'Corrections Ltd', ?)`).bind(clientId, ownerId),
  ]);
  ownerToken = await issueAccessToken(ownerId, `${ownerId}@test.local`, 'owner', env.JWT_SECRET);
  vendorId = (await call('POST', '/api/v1/vendors', { name: 'Restaurant' })).body.id;
  entertainment = (await call('POST', '/api/v1/expense-categories', {
    name: `Entertaining ${uid().slice(0, 4)}`, vatBox: 'purchases', vatReclaim: false, plLine: 'expense',
  })).body.id;
});

describe('VAT that cannot be reclaimed', () => {
  it('keeps a blocked bill VAT out of box 4, on both schemes, but in the net of box 7', async () => {
    const bill = await call('POST', '/api/v1/bills', { vendor_id: vendorId, issue_date: '2016-02-10', items: [
      { description: 'Client dinner', quantity: 1, unit_price: 50_000, tax_rate: 0.2, expense_category_id: entertainment },
    ] });
    expect(bill.status).toBe(201);
    const standard = (await call('GET', '/api/v1/reports/vat-return?from=2016-02-01&to=2016-02-29&scheme=standard')).body;
    expect(standard).toMatchObject({ box4: 0, box7: 50_000 });
    expect(standard.parts).toContainEqual(expect.objectContaining({ source: 'VAT on bills that can’t be reclaimed', vat: -10_000 }));

    await call('POST', `/api/v1/bills/${bill.body.id}/payments`, { amount: 60_000, payment_date: '2016-02-12', method: 'card' });
    const cash = (await call('GET', '/api/v1/reports/vat-return?from=2016-02-01&to=2016-02-29&scheme=cash')).body;
    expect(cash).toMatchObject({ box4: 0, box7: 50_000 });

    // The P&L counts the blocked VAT as part of the cost
    const pl = (await call('GET', '/api/v1/reports/pl?from=2016-02-01&to=2016-02-29')).body;
    const name = (await env.DB.prepare('SELECT name FROM expense_categories WHERE id = ?').bind(entertainment).first<{ name: string }>())!.name;
    expect(pl.expenses.find((e: Json) => e.category === name).total).toBe(60_000);
  });

  it('counts a blocked bank payment gross in the P&L', async () => {
    await env.DB.prepare(`
      INSERT INTO transactions (id, date, description, amount, expense_category_id, vat_rate, is_reconciled)
      VALUES (?, '2016-03-05', 'LUNCH', -2_400, ?, 0.2, 1)
    `).bind(uid(), entertainment).run();
    const pl = (await call('GET', '/api/v1/reports/pl?from=2016-03-01&to=2016-03-31')).body;
    expect(pl.totalExpenses).toBe(2_400);
  });
});

describe('credit notes', () => {
  it("credits an imported invoice in full at its stored totals, even when its lines don't add up to them", async () => {
    // QuickBooks keeps the rate to four decimals: 1,234,567 × 0.1998 = 246,666.49 → 246,666, stored 246,670
    const id = await invoice('2016-04-01', 1_234_567, 246_670, 0.1998, { source: 'quickbooks' });
    const cn = await call('POST', `/api/v1/invoices/${id}/credit-note`, { issue_date: '2016-04-02', reason: 'Cancelled' });
    expect(cn.status).toBe(201);
    expect(cn.body.total).toBe(1_234_567 + 246_670);
    expect((await call('GET', `/api/v1/invoices/${id}`)).body).toMatchObject({ status: 'paid', credit_applied: 1_481_237 });
  });

  it('numbers credit notes made at the same moment one after another, with no gap', async () => {
    const [a, b] = [await invoice('2016-04-10', 1_000, 200), await invoice('2016-04-10', 2_000, 400)];
    const before = (await env.DB.prepare('SELECT credit_note_next_sequence AS n FROM company_settings WHERE id = 1').first<{ n: number }>())!.n;
    const made = await Promise.all([a, b].map(id =>
      call('POST', `/api/v1/invoices/${id}/credit-note`, { issue_date: '2016-04-11', reason: 'Both cancelled' })));
    expect(made.map(m => m.status)).toEqual([201, 201]);
    const numbers = made.map(m => Number(m.body.invoice_number.replace(/\D/g, ''))).sort((x, y) => x - y);
    expect(numbers).toEqual([before, before + 1]);
  });

  it("doesn't use up a number when the credit note is refused", async () => {
    const id = await invoice('2016-04-15', 1_000, 200);
    const seq = async () => (await env.DB.prepare('SELECT credit_note_next_sequence AS n FROM company_settings WHERE id = 1').first<{ n: number }>())!.n;
    const start = await seq();
    expect((await call('POST', `/api/v1/invoices/${id}/credit-note`, {
      issue_date: '2016-04-16', reason: 'Too much', items: [{ description: 'Work', quantity: 2, unit_price: 1_000, tax_rate: 0.2 }],
    })).status).toBe(422);
    expect(await seq()).toBe(start);
  });
});

describe('a reviewed quarter changed after locking', () => {
  it('keeps the figures as locked, and shows what moved since', async () => {
    const sale = await invoice('2016-05-10', 10_000, 2_000);
    const locked = await call('POST', '/api/v1/periods/lock', { periodEnd: '2016-06-30' });
    expect(locked.status).toBe(201);

    const periods = (await call('GET', '/api/v1/periods')).body;
    expect(periods.quarters).toBeDefined();
    const snapshot = await env.DB.prepare(`SELECT boxes FROM period_snapshots WHERE period_end = '2016-06-30'`).first<{ boxes: string }>();
    const before = JSON.parse(snapshot!.boxes);

    // The customer won't pay: a credit note dated back in the locked quarter is still allowed
    const cn = await call('POST', `/api/v1/invoices/${sale}/credit-note`, { issue_date: '2016-06-20', reason: 'Bad debt agreed' });
    expect(cn.status).toBe(201);

    const figures = (await call('GET', '/api/v1/reports/vat-return?from=2016-04-01&to=2016-06-30&scheme=standard')).body;
    expect(figures.locked.boxes.box1).toBe(before.box1);
    expect(figures.box1).toBe(before.box1 - 2_000);

    // The periods API reports the change for that quarter; the list covers three years, so it is
    // checked through the same service the page uses
    const { activeSnapshots, changesSinceLocked } = await import('../../src/services/periodSnapshots');
    const changes = await changesSinceLocked(env.DB, [...(await activeSnapshots(env.DB)).values()]);
    expect(changes.get('2016-06-30')).toContainEqual({ box: 'box1', before: before.box1, now: before.box1 - 2_000 });

    expect((await call('POST', '/api/v1/periods/unlock', { reason: 'Test over' })).status).toBe(200);
  });
});
