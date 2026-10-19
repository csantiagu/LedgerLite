// The review fixes: profit and loss, overdue, void/delete guards, duplicate imports, bill status.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import app from '../../src/index';
import { issueAccessToken } from '../../src/middleware/auth';

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
const uid = () => crypto.randomUUID().replace(/-/g, '');
let token = '';
let ownerId = '';
let clientId = '';

const day = (offset: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

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
  return { status: res.status, body: text ? JSON.parse(text) as Record<string, any> : {} };
}

beforeAll(async () => {
  ownerId = uid();
  clientId = uid();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (id, email, name, role, password_hash) VALUES (?, ?, 'O', 'owner', 'x')`)
      .bind(ownerId, `${ownerId}@test.local`),
    env.DB.prepare(`INSERT INTO clients (id, name, created_by) VALUES (?, 'Books Client', ?)`).bind(clientId, ownerId),
  ]);
  token = await issueAccessToken(ownerId, `${ownerId}@test.local`, 'owner', env.JWT_SECRET);
});

describe('profit and loss', () => {
  it('counts the net of a payment in the month it was received, and skips void invoices', async () => {
    const live = uid();
    const voided = uid();
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO invoices (id, client_id, invoice_number, status, issue_date, due_date, subtotal, tax_amount, total, created_by)
        VALUES (?, ?, 'PL-LIVE', 'sent', '2024-03-01', '2099-04-01', 10000, 2000, 12000, ?)
      `).bind(live, clientId, ownerId),
      env.DB.prepare(`
        INSERT INTO payments_received (invoice_id, amount, payment_date, method, created_by)
        VALUES (?, 12000, '2024-04-15', 'bank_transfer', ?)
      `).bind(live, ownerId),
      env.DB.prepare(`
        INSERT INTO invoices (id, client_id, invoice_number, status, issue_date, due_date, subtotal, tax_amount, total, created_by)
        VALUES (?, ?, 'PL-VOID', 'void', '2024-04-01', '2099-04-01', 5000, 0, 5000, ?)
      `).bind(voided, clientId, ownerId),
      env.DB.prepare(`
        INSERT INTO payments_received (invoice_id, amount, payment_date, method, created_by)
        VALUES (?, 5000, '2024-04-15', 'bank_transfer', ?)
      `).bind(voided, ownerId),
    ]);

    const april = await call('GET', '/api/v1/reports/pl?from=2024-04-01&to=2024-04-30');
    const march = await call('GET', '/api/v1/reports/pl?from=2024-03-01&to=2024-03-31');
    const row = (april.body.income as Array<{ client_name: string; total: number }>)
      .find(r => r.client_name === 'Books Client');
    expect(row?.total).toBe(10_000);
    expect(JSON.stringify(march.body.income)).not.toContain('Books Client');
  });

  it('expenses the unmatched part of a bank line that is only partly matched to a bill', async () => {
    const vendor = uid();
    const bill = uid();
    const account = uid();
    const txn = uid();
    const category = uid();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO expense_categories (id, name) VALUES (?, 'Books Remainder')`).bind(category),
      env.DB.prepare(`INSERT INTO vendors (id, name, created_by) VALUES (?, 'Books Vendor', ?)`).bind(vendor, ownerId),
      env.DB.prepare(`INSERT INTO bank_accounts (id, name, bank_name, csv_format, created_by) VALUES (?, 'Books', 'Test', 'monzo', ?)`)
        .bind(account, ownerId),
      env.DB.prepare(`
        INSERT INTO bills (id, vendor_id, status, issue_date, subtotal, tax_amount, total, created_by)
        VALUES (?, ?, 'pending', '2024-04-01', 4000, 0, 4000, ?)
      `).bind(bill, vendor, ownerId),
      env.DB.prepare(`
        INSERT INTO bill_items (bill_id, description, quantity, unit_price, tax_rate, amount, expense_category_id)
        VALUES (?, 'Paper', 1, 4000, 0, 4000, ?)
      `).bind(bill, category),
      env.DB.prepare(`
        INSERT INTO transactions (id, bank_account_id, date, description, amount, expense_category_id)
        VALUES (?, ?, '2024-04-10', 'Card', -10000, ?)
      `).bind(txn, account, category),
    ]);
    const matched = await call('POST', '/api/v1/transaction-matches', {
      transactionId: txn, type: 'bill', targetId: bill, allocatedAmount: 4000,
    });
    expect(matched.status).toBe(201);
    expect((await call('POST', `/api/v1/transactions/${txn}/post`)).status).toBe(200);

    const pl = await call('GET', '/api/v1/reports/pl?from=2024-04-01&to=2024-04-30');
    const row = (pl.body.expenses as Array<{ category: string; total: number }>)
      .find(r => r.category === 'Books Remainder');
    expect(row?.total).toBe(10_000);
  });
});

describe('overdue invoices', () => {
  it('moves a past-due balance onto the overdue card and leaves a future invoice out of the overdue buckets', async () => {
    const before = await call('GET', '/api/v1/reports/dashboard');
    const agedBefore = await call('GET', '/api/v1/reports/aged-debtors');
    const past = uid();
    const future = uid();
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO invoices (id, client_id, invoice_number, status, issue_date, due_date, subtotal, total, created_by)
        VALUES (?, ?, 'DUE', 'sent', '2024-01-01', ?, 5000, 5000, ?)
      `).bind(past, clientId, day(-10), ownerId),
      env.DB.prepare(`
        INSERT INTO invoices (id, client_id, invoice_number, status, issue_date, due_date, subtotal, total, created_by)
        VALUES (?, ?, 'FUTURE', 'sent', '2024-01-01', ?, 7000, 7000, ?)
      `).bind(future, clientId, day(40), ownerId),
    ]);
    const after = await call('GET', '/api/v1/reports/dashboard');
    expect(after.body.overdue_pence - before.body.overdue_pence).toBe(5000);
    expect(after.body.outstanding_pence - before.body.outstanding_pence).toBe(7000);
    const stored = await env.DB.prepare('SELECT status FROM invoices WHERE id = ?').bind(past).first<{ status: string }>();
    expect(stored?.status).toBe('overdue');

    const aged = await call('GET', '/api/v1/reports/aged-debtors');
    expect(aged.body['0_30'] - agedBefore.body['0_30']).toBe(5000);
    expect(aged.body.current - agedBefore.body.current).toBe(7000);
  });
});

describe('invoice payments and voiding', () => {
  it('will not void or delete a payment that a bank line created', async () => {
    const invoice = uid();
    const account = uid();
    const txn = uid();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO bank_accounts (id, name, bank_name, csv_format, created_by) VALUES (?, 'Pay', 'Test', 'monzo', ?)`)
        .bind(account, ownerId),
      env.DB.prepare(`
        INSERT INTO invoices (id, client_id, invoice_number, status, issue_date, due_date, subtotal, total, created_by)
        VALUES (?, ?, 'PAY', 'sent', '2024-04-01', '2099-05-01', 8000, 8000, ?)
      `).bind(invoice, clientId, ownerId),
      env.DB.prepare(`
        INSERT INTO transactions (id, bank_account_id, date, description, amount)
        VALUES (?, ?, '2024-04-02', 'Receipt', 8000)
      `).bind(txn, account),
    ]);
    const matched = await call('POST', '/api/v1/transaction-matches', {
      transactionId: txn, type: 'invoice', targetId: invoice, allocatedAmount: 8000,
    });
    expect((await call('POST', `/api/v1/transactions/${txn}/post`)).status).toBe(200);
    const payment = await env.DB.prepare('SELECT id FROM payments_received WHERE invoice_id = ?').bind(invoice).first<{ id: string }>();
    expect((await call('DELETE', `/api/v1/invoices/${invoice}/payments/${payment!.id}`)).status).toBe(409);
    expect((await call('POST', `/api/v1/invoices/${invoice}/void`)).status).toBe(409);
    const still = await env.DB.prepare('SELECT status, amount_paid FROM invoices WHERE id = ?').bind(invoice)
      .first<{ status: string; amount_paid: number }>();
    expect(still).toEqual({ status: 'paid', amount_paid: 8000 });
  });

  it('lets only one of two full payments land', async () => {
    const invoice = uid();
    await env.DB.prepare(`
      INSERT INTO invoices (id, client_id, invoice_number, status, issue_date, due_date, subtotal, total, created_by)
      VALUES (?, ?, 'RACE', 'sent', '2024-04-01', '2099-05-01', 3000, 3000, ?)
    `).bind(invoice, clientId, ownerId).run();
    const body = { amount: 3000, payment_date: '2024-04-02', method: 'cash' };
    const results = await Promise.all([
      call('POST', `/api/v1/invoices/${invoice}/payments`, body),
      call('POST', `/api/v1/invoices/${invoice}/payments`, body),
    ]);
    expect(results.map(r => r.status).sort()).toEqual([201, 409]);
    const paid = await env.DB.prepare('SELECT amount_paid FROM invoices WHERE id = ?').bind(invoice).first<{ amount_paid: number }>();
    expect(paid?.amount_paid).toBe(3000);
  });
});

describe('bills and bank imports', () => {
  it('creates a bill as pending even if the request says it is paid', async () => {
    const vendor = uid();
    await env.DB.prepare(`INSERT INTO vendors (id, name, created_by) VALUES (?, 'Status Vendor', ?)`).bind(vendor, ownerId).run();
    const res = await call('POST', '/api/v1/bills', {
      vendor_id: vendor,
      status: 'paid',
      items: [{ description: 'Work', quantity: 1, unit_price: 100, tax_rate: 0 }],
    });
    expect(res.status).toBe(201);
    const bill = await env.DB.prepare('SELECT status, amount_paid FROM bills WHERE id = ?').bind(res.body.id)
      .first<{ status: string; amount_paid: number }>();
    expect(bill).toEqual({ status: 'pending', amount_paid: 0 });
  });

  it('imports the same row into two bank accounts', async () => {
    const a = uid();
    const b = uid();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO bank_accounts (id, name, bank_name, csv_format, created_by) VALUES (?, 'A', 'Monzo', 'monzo', ?)`).bind(a, ownerId),
      env.DB.prepare(`INSERT INTO bank_accounts (id, name, bank_name, csv_format, created_by) VALUES (?, 'B', 'Monzo', 'monzo', ?)`).bind(b, ownerId),
    ]);
    const csv = 'Date,Description,Amount\n01/04/2024,SAME SHOP,-15.00\n';
    const upload = async (account: string) => {
      const form = new FormData();
      form.append('bankAccountId', account);
      form.append('file', new File([csv], 's.csv', { type: 'text/csv' }));
      const res = await app.fetch(new Request('http://api.test/api/v1/bank-imports', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' },
        body: form,
      }), env, ctx);
      return res.json() as Promise<{ newRowCount: number }>;
    };
    expect(await upload(a)).toMatchObject({ newRowCount: 1 });
    expect(await upload(b)).toMatchObject({ newRowCount: 1 });
  });
});
