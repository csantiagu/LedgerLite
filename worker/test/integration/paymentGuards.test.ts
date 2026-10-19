// Deleting payments by hand, and voiding bills, without leaving balances or bank matches wrong.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import app from '../../src/index';
import { issueAccessToken } from '../../src/middleware/auth';

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
const uid = () => crypto.randomUUID().replace(/-/g, '');
let token = '';
let ownerId = '';
let clientId = '';
let vendorId = '';
let accountId = '';

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
  return { status: res.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
}

async function invoice(total: number, dueDate: string) {
  const id = uid();
  await env.DB.prepare(`
    INSERT INTO invoices (id, client_id, invoice_number, status, issue_date, due_date, subtotal, total, created_by)
    VALUES (?, ?, ?, 'sent', ?, ?, ?, ?, ?)
  `).bind(id, clientId, `PG-${id.slice(0, 12)}`, day(-60), dueDate, total, total, ownerId).run();
  return id;
}

async function bill(total: number) {
  const id = uid();
  await env.DB.prepare(`
    INSERT INTO bills (id, vendor_id, status, issue_date, subtotal, total, created_by)
    VALUES (?, ?, 'pending', ?, ?, ?, ?)
  `).bind(id, vendorId, day(-10), total, total, ownerId).run();
  return id;
}

const pay = async (kind: 'invoices' | 'bills', id: string, amount: number) =>
  (await call('POST', `/api/v1/${kind}/${id}/payments`, { amount, payment_date: day(0), method: 'bank_transfer' })).body.id as string;

const doc = (table: 'invoices' | 'bills', id: string) => env.DB.prepare(
  `SELECT status, amount_paid FROM ${table} WHERE id = ?`
).bind(id).first<{ status: string; amount_paid: number }>();

async function bankLine(amount: number) {
  const id = uid();
  await env.DB.prepare(
    `INSERT INTO transactions (id, bank_account_id, date, description, amount) VALUES (?, ?, ?, 'Line', ?)`
  ).bind(id, accountId, day(-1), amount).run();
  return id;
}

beforeAll(async () => {
  ownerId = uid();
  clientId = uid();
  vendorId = uid();
  accountId = uid();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (id, email, name, role, password_hash) VALUES (?, ?, 'O', 'owner', 'x')`)
      .bind(ownerId, `${ownerId}@test.local`),
    env.DB.prepare(`INSERT INTO clients (id, name, created_by) VALUES (?, 'Guard Client', ?)`).bind(clientId, ownerId),
    env.DB.prepare(`INSERT INTO vendors (id, name, created_by) VALUES (?, 'Guard Vendor', ?)`).bind(vendorId, ownerId),
    env.DB.prepare(`INSERT INTO bank_accounts (id, name, bank_name, csv_format, created_by) VALUES (?, 'G', 'B', 'monzo', ?)`)
      .bind(accountId, ownerId),
  ]);
  token = await issueAccessToken(ownerId, `${ownerId}@test.local`, 'owner', env.JWT_SECRET);
});

describe('deleting an invoice payment', () => {
  it('takes it off the balance and reopens the invoice as sent, part-paid or overdue', async () => {
    const future = await invoice(10_000, day(30));
    const first = await pay('invoices', future, 4_000);
    const second = await pay('invoices', future, 6_000);
    expect(await doc('invoices', future)).toEqual({ status: 'paid', amount_paid: 10_000 });

    expect((await call('DELETE', `/api/v1/invoices/${future}/payments/${second}`)).status).toBe(200);
    expect(await doc('invoices', future)).toEqual({ status: 'partial', amount_paid: 4_000 });
    expect((await call('DELETE', `/api/v1/invoices/${future}/payments/${first}`)).status).toBe(200);
    expect(await doc('invoices', future)).toEqual({ status: 'sent', amount_paid: 0 });

    const pastDue = await invoice(5_000, day(-5));
    const p = await pay('invoices', pastDue, 5_000);
    await call('DELETE', `/api/v1/invoices/${pastDue}/payments/${p}`);
    expect(await doc('invoices', pastDue)).toEqual({ status: 'overdue', amount_paid: 0 });
  });

  it('subtracts a payment once even when it is deleted twice at the same time', async () => {
    const id = await invoice(10_000, day(30));
    await pay('invoices', id, 3_000);
    const p = await pay('invoices', id, 2_000);
    const results = await Promise.all([
      call('DELETE', `/api/v1/invoices/${id}/payments/${p}`),
      call('DELETE', `/api/v1/invoices/${id}/payments/${p}`),
    ]);
    expect(results.map(r => r.status).sort()).toEqual([200, expect.any(Number)]);
    expect(results.filter(r => r.status === 200)).toHaveLength(1);
    expect(await doc('invoices', id)).toEqual({ status: 'partial', amount_paid: 3_000 });
    const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM payments_received WHERE invoice_id = ?').bind(id).first();
    expect(left).toEqual({ n: 1 });
  });

  it('answers 404 for a payment that belongs to another invoice', async () => {
    const a = await invoice(1_000, day(30));
    const b = await invoice(1_000, day(30));
    const p = await pay('invoices', a, 500);
    expect((await call('DELETE', `/api/v1/invoices/${b}/payments/${p}`)).status).toBe(404);
    expect(await doc('invoices', a)).toEqual({ status: 'partial', amount_paid: 500 });
  });
});

describe('deleting a bill payment', () => {
  it('takes it off the balance and reopens the bill', async () => {
    const id = await bill(8_000);
    const first = await pay('bills', id, 3_000);
    const second = await pay('bills', id, 5_000);
    expect(await doc('bills', id)).toEqual({ status: 'paid', amount_paid: 8_000 });
    await call('DELETE', `/api/v1/bills/${id}/payments/${second}`);
    expect(await doc('bills', id)).toEqual({ status: 'partial', amount_paid: 3_000 });
    await call('DELETE', `/api/v1/bills/${id}/payments/${first}`);
    expect(await doc('bills', id)).toEqual({ status: 'pending', amount_paid: 0 });
  });
});

describe('voiding a bill', () => {
  it('refuses while a bank line is matched to it', async () => {
    const id = await bill(1_500);
    const line = await bankLine(-1_500);
    const match = await call('POST', '/api/v1/transaction-matches', {
      transactionId: line, type: 'bill', targetId: id, allocatedAmount: 1_500,
    });
    expect(match.status).toBe(201);
    expect((await call('DELETE', `/api/v1/bills/${id}`)).status).toBe(409);
    expect((await doc('bills', id))?.status).toBe('pending');

    // Once the match is removed it can go
    await call('DELETE', `/api/v1/transaction-matches/${match.body.id}`);
    expect((await call('DELETE', `/api/v1/bills/${id}`)).status).toBe(200);
    expect((await doc('bills', id))?.status).toBe('void');
  });

  it('drops suggestions for it, and refuses to void it twice', async () => {
    const id = await bill(900);
    const line = await bankLine(-900);
    await env.DB.prepare(`
      INSERT INTO transaction_matches (transaction_id, match_type, bill_id, allocated_amount, status)
      VALUES (?, 'bill', ?, 900, 'suggested')
    `).bind(line, id).run();
    expect((await call('DELETE', `/api/v1/bills/${id}`)).status).toBe(200);
    const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM transaction_matches WHERE bill_id = ?').bind(id).first();
    expect(left).toEqual({ n: 0 });
    expect((await call('DELETE', `/api/v1/bills/${id}`)).status).toBe(422);
  });

  it('still refuses a bill with payments', async () => {
    const id = await bill(700);
    await pay('bills', id, 700);
    expect((await call('DELETE', `/api/v1/bills/${id}`)).status).toBe(409);
  });
});
