// The rarer paths through posting and undoing bank lines: unknown matches, lines blocked by a
// problem or by other matches, rows that vanish mid-post, and batches that fail (a second post
// racing the first, the bill changing underneath, or anything else).
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import app from '../../src/index';
import { issueAccessToken } from '../../src/middleware/auth';
import {
  postMatchesAndReconcile, postTransaction, postTransactions, undoTransaction,
} from '../../src/services/bankReview';

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
const uid = () => crypto.randomUUID().replace(/-/g, '');
let token = '';
let ownerId = '';
let accountId = '';
let vendorId = '';
let categoryId = '';

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

/**
 * The test database, except that `batch` throws `batchError` and statements whose SQL matches
 * `vanish` find no row, as if another request had changed things in between.
 */
function faultyDb(opts: { batchError?: string; vanish?: (sql: string) => boolean }): D1Database {
  return new Proxy(env.DB, {
    get(target, prop) {
      if (prop === 'batch' && opts.batchError) {
        return async () => { throw new Error(opts.batchError); };
      }
      if (prop === 'prepare' && opts.vanish) {
        return (sql: string) => (opts.vanish!(sql)
          ? { bind: () => ({ first: async () => null }) }
          : target.prepare(sql));
      }
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function line(amount: number, category: string | null = null) {
  const id = uid();
  await env.DB.prepare(
    `INSERT INTO transactions (id, bank_account_id, date, description, amount, expense_category_id, vat_rate)
     VALUES (?, ?, '2026-05-01', 'Edge', ?, ?, ?)`
  ).bind(id, accountId, amount, category, category ? 0 : null).run();
  return id;
}

async function bill(total: number) {
  const id = uid();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO bills (id, vendor_id, status, subtotal, total, created_by) VALUES (?, ?, 'pending', ?, ?, ?)`)
      .bind(id, vendorId, total, total, ownerId),
    env.DB.prepare(`
      INSERT INTO bill_items (bill_id, description, quantity, unit_price, tax_rate, amount, expense_category_id)
      VALUES (?, 'Goods', 1, ?, 0, ?, ?)
    `).bind(id, total, total, categoryId),
  ]);
  return id;
}

async function match(transactionId: string, targetId: string, allocatedAmount: number) {
  const res = await call('POST', '/api/v1/transaction-matches', { transactionId, type: 'bill', targetId, allocatedAmount });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

const isPosted = async (id: string) =>
  (await env.DB.prepare('SELECT is_reconciled FROM transactions WHERE id = ?').bind(id).first<{ is_reconciled: number }>())!
    .is_reconciled;

beforeAll(async () => {
  ownerId = uid();
  accountId = uid();
  vendorId = uid();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (id, email, name, role, password_hash) VALUES (?, ?, 'O', 'owner', 'x')`)
      .bind(ownerId, `${ownerId}@test.local`),
    env.DB.prepare(`INSERT INTO vendors (id, name, created_by) VALUES (?, 'Edge Vendor', ?)`).bind(vendorId, ownerId),
    env.DB.prepare(`INSERT INTO bank_accounts (id, name, bank_name, csv_format, created_by) VALUES (?, 'E', 'B', 'monzo', ?)`)
      .bind(accountId, ownerId),
  ]);
  token = await issueAccessToken(ownerId, `${ownerId}@test.local`, 'owner', env.JWT_SECRET);
  categoryId = (await env.DB.prepare('SELECT id FROM expense_categories LIMIT 1').first<{ id: string }>())!.id;
});

describe('posting matches by id', () => {
  it('is 404 when a match id is unknown', async () => {
    const res = await call('POST', '/api/v1/transaction-matches/post', { matchIds: [uid()] });
    expect(res).toMatchObject({ status: 404, body: { error: 'One or more match IDs not found' } });
  });

  it('leaves a line with other pending matches in For Review', async () => {
    const txn = await line(-3_000);
    const first = await match(txn, await bill(1_000), 1_000);
    await match(txn, await bill(2_000), 2_000);

    const res = await call('POST', '/api/v1/transaction-matches/post', { matchIds: [first] });
    expect(res).toMatchObject({ status: 422, body: { error: 'This line has other matches. Post them together.' } });
    expect(await isPosted(txn)).toBe(0);
  });

  it('leaves a line that is only partly explained in For Review', async () => {
    const txn = await line(-3_000);
    const m = await match(txn, await bill(1_000), 1_000);

    const res = await call('POST', '/api/v1/transaction-matches/post', { matchIds: [m] });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/not matched yet/);
  });

  it('is 404 if the bank line disappears while posting', async () => {
    const txn = await line(-1_000);
    const m = await match(txn, await bill(1_000), 1_000);
    const db = faultyDb({ vanish: sql => sql.includes('AS pending') });
    expect(await postMatchesAndReconcile(db, ownerId, [m])).toMatchObject({ ok: false, status: 404 });
  });

  it('maps a lost race to 409, and passes on any other database error', async () => {
    const txn = await line(-1_000);
    const m = await match(txn, await bill(1_000), 1_000);

    expect(await postMatchesAndReconcile(faultyDb({ batchError: 'UNIQUE constraint failed: payments_made.id' }), ownerId, [m]))
      .toEqual({ ok: false, status: 409, error: 'These matches have already been posted' });
    expect(await postMatchesAndReconcile(faultyDb({ batchError: 'NOT NULL constraint failed: payments_made.amount' }), ownerId, [m]))
      .toEqual({ ok: false, status: 409, error: 'The bill changed while posting; refresh and try again' });
    await expect(postMatchesAndReconcile(faultyDb({ batchError: 'disk I/O error' }), ownerId, [m]))
      .rejects.toThrow('disk I/O error');
    expect(await isPosted(txn)).toBe(0);
  });
});

describe('posting a line', () => {
  it('is 404 when the bill it pays has gone', async () => {
    const txn = await line(-1_000);
    await match(txn, await bill(1_000), 1_000);
    const db = faultyDb({ vanish: sql => sql.includes('AS outstanding FROM bills') });
    expect(await postTransaction(db, ownerId, txn)).toEqual({ ok: false, status: 404, error: 'Invoice or bill not found' });
  });

  it('maps a lost race to 409 whether or not the line pays a bill, and passes on other errors', async () => {
    const paying = await line(-1_000);
    await match(paying, await bill(1_000), 1_000);
    expect(await postTransaction(faultyDb({ batchError: 'NOT NULL constraint failed' }), ownerId, paying))
      .toMatchObject({ status: 409, error: 'The bill changed while posting; refresh and try again' });

    // A line with only a category creates no payment
    const categorised = await line(-500, categoryId);
    expect(await postTransaction(faultyDb({ batchError: 'NOT NULL constraint failed' }), ownerId, categorised))
      .toMatchObject({ status: 409, error: 'The invoice changed while posting; refresh and try again' });
    expect(await postTransaction(faultyDb({ batchError: 'UNIQUE constraint failed' }), ownerId, categorised))
      .toMatchObject({ status: 409, error: 'These matches have already been posted' });
    await expect(postTransaction(faultyDb({ batchError: 'disk I/O error' }), ownerId, categorised))
      .rejects.toThrow('disk I/O error');
  });
});

describe('posting several lines', () => {
  it('posts lines with matches one by one and reports the ones that fail', async () => {
    const good = await line(-1_000);
    await match(good, await bill(1_000), 1_000);

    // Matched in full, but the bill is voided before posting, so its payment is refused
    const bad = await line(-2_000);
    const badBill = await bill(2_000);
    await match(bad, badBill, 2_000);
    await env.DB.prepare(`UPDATE bills SET status = 'void' WHERE id = ?`).bind(badBill).run();

    const res = await postTransactions(env.DB, ownerId, [good, bad]);
    expect(res.posted).toEqual([good]);
    expect(res.failed).toEqual([{ id: bad, error: 'This bill is void and cannot take payments' }]);
  });
});

describe('undoing a line', () => {
  it('sends it back even when its payment record is already gone', async () => {
    const txn = await line(-1_000);
    const b = await bill(1_000);
    await match(txn, b, 1_000);
    expect((await postTransaction(env.DB, ownerId, txn)).ok).toBe(true);
    await env.DB.prepare('DELETE FROM payments_made WHERE bill_id = ?').bind(b).run();

    const res = await undoTransaction(env.DB, txn);
    expect(res).toEqual({ ok: true, reopened: [], alsoReturned: [] });
    expect(await isPosted(txn)).toBe(0);
    const m = await env.DB.prepare('SELECT status, payment_id FROM transaction_matches WHERE transaction_id = ?')
      .bind(txn).first();
    expect(m).toEqual({ status: 'pending', payment_id: null });
  });
});
