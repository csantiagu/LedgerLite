// A supplier bill of £7,700 paid as £5,000, £2,000, then £800. The last payment is £100 more than
// the £700 still owed. That £100 stays as money the supplier has to return, and their refund clears it.
// It is not an expense, and it does not close the books at zero.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import app from '../../src/index';
import { issueAccessToken } from '../../src/middleware/auth';

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
const uid = () => crypto.randomUUID().replace(/-/g, '');
let ownerToken = '';
let ownerId = '';
let vendorId = '';
let categoryId = '';

type Json = Record<string, any>;

async function call(method: string, path: string, body?: unknown) {
  const res = await app.fetch(new Request(`http://api.test${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env, ctx);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) as Json : {} };
}

async function account() {
  const id = uid();
  await env.DB.prepare(
    `INSERT INTO bank_accounts (id, name, bank_name, csv_format, created_by) VALUES (?, 'Overpay', 'Bank', 'monzo', ?)`
  ).bind(id, ownerId).run();
  return id;
}

async function line(accountId: string, amount: number, description: string) {
  const id = uid();
  await env.DB.prepare(
    `INSERT INTO transactions (id, bank_account_id, date, description, amount) VALUES (?, ?, '2026-06-15', ?, ?)`
  ).bind(id, accountId, description, amount).run();
  return id;
}

async function bill(total: number) {
  const id = uid();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO bills (id, vendor_id, bill_number, status, issue_date, due_date, subtotal, total, created_by)
       VALUES (?, ?, 'SUP-7700', 'pending', '2026-06-01', '2026-06-30', ?, ?, ?)`
    ).bind(id, vendorId, total, total, ownerId),
    env.DB.prepare(
      `INSERT INTO bill_items (bill_id, description, quantity, unit_price, tax_rate, amount, expense_category_id)
       VALUES (?, 'Work', 1, ?, 0, ?, ?)`
    ).bind(id, total, total, categoryId),
  ]);
  return id;
}

const pay = (transactionId: string, targetId: string, allocatedAmount: number, overpaymentAmount?: number) =>
  call('POST', '/api/v1/transaction-matches', {
    transactionId, type: 'bill', targetId, allocatedAmount, ...(overpaymentAmount ? { overpaymentAmount } : {}),
  });

beforeAll(async () => {
  ownerId = uid();
  await env.DB.prepare(
    `INSERT INTO users (id, email, name, role, password_hash) VALUES (?, ?, 'O', 'owner', 'x')`
  ).bind(ownerId, `${ownerId}@test.local`).run();
  ownerToken = await issueAccessToken(ownerId, `${ownerId}@test.local`, 'owner', env.JWT_SECRET);
  vendorId = (await call('POST', '/api/v1/vendors', { name: 'Overpay Supplies' })).body.id;
  categoryId = (await env.DB.prepare('SELECT id FROM expense_categories LIMIT 1').first<{ id: string }>())!.id;
});

describe('overpaying a supplier bill', () => {
  it('keeps the extra £100 as a refund due, then clears it when the supplier returns it', async () => {
    const acc = await account();
    const id = await bill(770_000);
    const first = await line(acc, -500_000, 'PART 1');
    const second = await line(acc, -200_000, 'PART 2');
    const third = await line(acc, -80_000, 'PART 3');
    expect((await pay(first, id, 500_000)).status).toBe(201);
    expect((await call('POST', `/api/v1/transactions/${first}/post`)).status).toBe(200);
    expect((await pay(second, id, 200_000)).status).toBe(201);
    expect((await call('POST', `/api/v1/transactions/${second}/post`)).status).toBe(200);

    // £800 against the £700 left is refused: the extra has to be recorded as a refund due
    expect((await pay(third, id, 80_000)).status).toBe(422);
    expect((await pay(third, id, 10_000, 10_000)).status).toBe(422);

    const matched = await pay(third, id, 70_000, 10_000);
    expect(matched.status).toBe(201);

    const open = await call('GET', `/api/v1/bills/${id}`);
    expect(open.body).toMatchObject({ status: 'partial', amount_paid: 700_000, refund_due: 10_000 });
    const review = await call('GET', `/api/v1/transactions?bankAccountId=${acc}&reviewed=0&page=1&pageSize=50`);
    const row = (review.body.rows as Json[]).find(r => r.id === third);
    expect(row).toMatchObject({ is_reconciled: 0, allocated_total: 80_000, overpayment_amount: 10_000 });

    expect((await call('POST', `/api/v1/transactions/${third}/post`)).status).toBe(200);
    const paid = await call('GET', `/api/v1/bills/${id}`);
    expect(paid.body).toMatchObject({ status: 'paid', amount_paid: 770_000, refund_due: 10_000 });
    const payments = await env.DB.prepare(
      'SELECT amount FROM payments_made WHERE bill_id = ? ORDER BY amount'
    ).bind(id).all<{ amount: number }>();
    expect(payments.results.map(p => p.amount)).toEqual([70_000, 200_000, 500_000]);

    const refund = await line(acc, 10_000, 'REFUND');
    const search = await call('GET', `/api/v1/match-search?transactionId=${refund}&q=Overpay`);
    const due = (search.body.results as Json[]).find(r => r.type === 'overpayment');
    expect(due).toMatchObject({ outstanding: 10_000, refund: true });

    expect((await call('POST', '/api/v1/transaction-matches', {
      transactionId: refund, type: 'overpayment', targetId: due!.id, allocatedAmount: 10_000,
    })).status).toBe(201);
    expect((await call('POST', '/api/v1/transaction-matches', {
      transactionId: refund, type: 'overpayment', targetId: due!.id, allocatedAmount: 1,
    })).status).toBe(409);
    expect((await call('POST', `/api/v1/transactions/${refund}/post`)).status).toBe(200);
    expect((await call('GET', `/api/v1/bills/${id}`)).body.refund_due).toBe(0);
    const refunded = await env.DB.prepare(
      'SELECT amount, amount_refunded FROM supplier_overpayments WHERE bill_id = ?'
    ).bind(id).first<{ amount: number; amount_refunded: number }>();
    expect(refunded).toEqual({ amount: 10_000, amount_refunded: 10_000 });

    // Undoing the £800 payment takes the refund with it: the extra is no longer in the books
    const undone = await call('POST', `/api/v1/transactions/${third}/undo`);
    expect(undone.status).toBe(200);
    expect(undone.body.alsoReturned).toContain(refund);
    expect((await call('GET', `/api/v1/bills/${id}`)).body).toMatchObject({
      status: 'partial', amount_paid: 700_000, refund_due: 0,
    });
    expect(await env.DB.prepare('SELECT is_reconciled FROM transactions WHERE id = ?').bind(refund)
      .first<{ is_reconciled: number }>()).toEqual({ is_reconciled: 0 });
    expect(await env.DB.prepare('SELECT id FROM supplier_overpayments WHERE bill_id = ?').bind(id).first()).toBeNull();
  });

  it('drops the refund due when the match is removed before it is posted', async () => {
    const acc = await account();
    const id = await bill(70_000);
    const payment = await line(acc, -80_000, 'OVER');
    const matched = await pay(payment, id, 70_000, 10_000);
    expect(matched.status).toBe(201);
    expect((await call('DELETE', `/api/v1/transaction-matches/${matched.body.id}`)).status).toBe(200);
    expect((await call('GET', `/api/v1/bills/${id}`)).body.refund_due).toBe(0);
    expect(await env.DB.prepare('SELECT id FROM supplier_overpayments WHERE bill_id = ?').bind(id).first()).toBeNull();
    const left = await env.DB.prepare(
      'SELECT COALESCE(SUM(allocated_amount), 0) AS n FROM transaction_matches WHERE transaction_id = ?'
    ).bind(payment).first<{ n: number }>();
    expect(left).toEqual({ n: 0 });
  });

  it('refuses to undo the payment while a refund is matched but not posted', async () => {
    const acc = await account();
    const id = await bill(70_000);
    const payment = await line(acc, -80_000, 'OVER');
    expect((await pay(payment, id, 70_000, 10_000)).status).toBe(201);
    expect((await call('POST', `/api/v1/transactions/${payment}/post`)).status).toBe(200);

    const refund = await line(acc, 10_000, 'REFUND');
    const search = await call('GET', `/api/v1/match-search?transactionId=${refund}&q=Overpay`);
    const due = (search.body.results as Json[]).find(r => r.type === 'overpayment');
    const matched = await call('POST', '/api/v1/transaction-matches', {
      transactionId: refund, type: 'overpayment', targetId: due!.id, allocatedAmount: 10_000,
    });
    expect(matched.status).toBe(201);

    const undone = await call('POST', `/api/v1/transactions/${payment}/undo`);
    expect(undone.status).toBe(409);
    expect(await env.DB.prepare(
      'SELECT status FROM transaction_matches WHERE id = ?'
    ).bind(matched.body.id).first()).toEqual({ status: 'pending' });
    expect(await env.DB.prepare(
      'SELECT amount_refunded FROM supplier_overpayments WHERE bill_id = ?'
    ).bind(id).first()).toEqual({ amount_refunded: 0 });

    expect((await call('DELETE', `/api/v1/transaction-matches/${matched.body.id}`)).status).toBe(200);
    expect((await call('POST', `/api/v1/transactions/${payment}/undo`)).status).toBe(200);
  });
});
