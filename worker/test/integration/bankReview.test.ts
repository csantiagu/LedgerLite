import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import app from '../../src/index';
import { issueAccessToken } from '../../src/middleware/auth';

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
const uid = () => crypto.randomUUID().replace(/-/g, '');
let ownerToken = '';
let accountantToken = '';
let ownerId = '';
let client = '';
let vendor = '';
let category = '';
let debtorsId = '';

type Json = Record<string, unknown> & { rows?: Array<Record<string, unknown>>; failed?: unknown[] };

async function call(method: string, path: string, body?: unknown, token = ownerToken) {
  const res = await app.fetch(new Request(`http://api.test${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env, ctx);
  return { status: res.status, body: await res.json() as Json };
}

/** A fresh bank account per test, so lists and counts only see that test's lines. */
async function account() {
  const id = uid();
  await env.DB.prepare(
    `INSERT INTO bank_accounts (id, name, bank_name, csv_format, created_by) VALUES (?, 'A', 'B', 'monzo', ?)`
  ).bind(id, ownerId).run();
  return id;
}

async function line(accountId: string, amount: number, opts: { date?: string; description?: string; category?: string; vatRate?: number | null } = {}) {
  const id = uid();
  // A categorised line has its VAT chosen unless the test says otherwise
  const vatRate = opts.vatRate !== undefined ? opts.vatRate : opts.category ? 0.2 : null;
  await env.DB.prepare(`
    INSERT INTO transactions (id, bank_account_id, date, description, amount, expense_category_id, vat_rate)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(id, accountId, opts.date ?? '2026-05-01', opts.description ?? 'Line', amount, opts.category ?? null, vatRate).run();
  return id;
}

async function invoice(total: number) {
  const id = uid();
  await env.DB.prepare(`
    INSERT INTO invoices (id, client_id, invoice_number, status, issue_date, due_date, subtotal, total, created_by)
    VALUES (?, ?, ?, 'sent', '2026-04-01', '2099-04-30', ?, ?, ?)
  `).bind(id, client, `R-${id.slice(0, 12)}`, total, total, ownerId).run();
  return id;
}

const state = (id: string) => env.DB.prepare(
  'SELECT is_reconciled, reviewed_by, expense_category_id FROM transactions WHERE id = ?'
).bind(id).first<{ is_reconciled: number; reviewed_by: string | null; expense_category_id: string | null }>();

const invoiceState = (id: string) => env.DB.prepare(
  `SELECT status, amount_paid, (SELECT COUNT(*) FROM payments_received WHERE invoice_id = ?) AS payments
   FROM invoices WHERE id = ?`
).bind(id, id).first<{ status: string; amount_paid: number; payments: number }>();

const pendingMatch = (transactionId: string, targetId: string, allocatedAmount: number) =>
  call('POST', '/api/v1/transaction-matches', { transactionId, type: 'invoice', targetId, allocatedAmount });

beforeAll(async () => {
  ownerId = uid();
  const accountantId = uid();
  client = uid();
  vendor = uid();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (id, email, name, role, password_hash) VALUES (?, ?, 'O', 'owner', 'x')`)
      .bind(ownerId, `${ownerId}@test.local`),
    env.DB.prepare(`INSERT INTO users (id, email, name, role, password_hash) VALUES (?, ?, 'A', 'accountant', 'x')`)
      .bind(accountantId, `${accountantId}@test.local`),
    env.DB.prepare(`INSERT INTO clients (id, name, created_by) VALUES (?, 'Review Client', ?)`).bind(client, ownerId),
    env.DB.prepare(`INSERT INTO vendors (id, name, created_by) VALUES (?, 'Review Vendor', ?)`).bind(vendor, ownerId),
    env.DB.prepare(`INSERT OR IGNORE INTO expense_categories (name) VALUES ('Debtors Control Account')`),
  ]);
  debtorsId = (await env.DB.prepare(`SELECT id FROM expense_categories WHERE name = 'Debtors Control Account'`)
    .first<{ id: string }>())!.id;
  category = (await env.DB.prepare(`SELECT id FROM expense_categories WHERE name = 'Office Supplies'`)
    .first<{ id: string }>())!.id;
  ownerToken = await issueAccessToken(ownerId, `${ownerId}@test.local`, 'owner', env.JWT_SECRET);
  accountantToken = await issueAccessToken(accountantId, `${accountantId}@test.local`, 'accountant', env.JWT_SECRET);
});

describe('posting from For Review', () => {
  it('needs a category or a match, then moves the line to All Transactions', async () => {
    const acc = await account();
    const id = await line(acc, -1500);
    expect((await call('POST', `/api/v1/transactions/${id}/post`)).status).toBe(422);

    await call('PATCH', `/api/v1/transactions/${id}`, { expenseCategoryId: category });
    const noVat = await call('POST', `/api/v1/transactions/${id}/post`);
    expect(noVat.status).toBe(422);
    expect(noVat.body.error).toContain('VAT');
    await call('PATCH', `/api/v1/transactions/${id}`, { vatRate: 0.2 });
    expect((await call('POST', `/api/v1/transactions/${id}/post`)).status).toBe(200);
    expect(await state(id)).toMatchObject({ is_reconciled: 1, reviewed_by: ownerId });

    const review = await call('GET', `/api/v1/transactions?bankAccountId=${acc}&reviewed=0&page=1`);
    const posted = await call('GET', `/api/v1/transactions?bankAccountId=${acc}&reviewed=1&page=1`);
    expect(review.body.total).toBe(0);
    expect(posted.body.rows!.map(r => r.id)).toEqual([id]);
    expect((await call('GET', '/api/v1/transactions/review-counts')).body[acc]).toBeUndefined();
  });

  it('turns a pending invoice match into a payment', async () => {
    const acc = await account();
    const inv = await invoice(4000);
    const id = await line(acc, 4000);
    await pendingMatch(id, inv, 4000);
    expect((await call('POST', `/api/v1/transactions/${id}/post`)).status).toBe(200);
    expect(await invoiceState(inv)).toEqual({ status: 'paid', amount_paid: 4000, payments: 1 });
    expect((await state(id))?.is_reconciled).toBe(1);
  });

  it('refuses a part-matched line with no category', async () => {
    const acc = await account();
    const inv = await invoice(1000);
    const id = await line(acc, 3000);
    await pendingMatch(id, inv, 1000);
    expect((await call('POST', `/api/v1/transactions/${id}/post`)).status).toBe(422);
    expect(await invoiceState(inv)).toMatchObject({ amount_paid: 0, payments: 0 });
  });

  it('drops suggestions that were not taken up', async () => {
    const acc = await account();
    const inv = await invoice(900);
    const id = await line(acc, 900, { category });
    await env.DB.prepare(`
      INSERT INTO transaction_matches (transaction_id, match_type, invoice_id, allocated_amount, status)
      VALUES (?, 'invoice', ?, 900, 'suggested')
    `).bind(id, inv).run();
    await call('POST', `/api/v1/transactions/${id}/post`);
    const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM transaction_matches WHERE transaction_id = ?')
      .bind(id).first<{ n: number }>();
    expect(left?.n).toBe(0);
    expect(await invoiceState(inv)).toMatchObject({ amount_paid: 0 });
  });

  it('posts several lines at once and reports the ones it could not', async () => {
    const acc = await account();
    const a = await line(acc, -100, { category });
    const b = await line(acc, -200, { category });
    const c = await line(acc, -300);
    const res = await call('POST', '/api/v1/transactions/post', { ids: [a, b, c] });
    expect(res.body.posted).toBe(2);
    expect(res.body.failed).toEqual([expect.objectContaining({ id: c })]);
    expect((await call('GET', '/api/v1/transactions/review-counts')).body[acc]).toBe(1);
  });

  it('takes at most 25 lines per request', async () => {
    const acc = await account();
    const ids = await Promise.all(Array.from({ length: 26 }, () => line(acc, -10, { category })));
    expect((await call('POST', '/api/v1/transactions/post', { ids })).status).toBe(400);
  });

  it('checks every invoice before paying any, so a line is never half-posted', async () => {
    const acc = await account();
    const open = await invoice(1000);
    const voided = await invoice(1000);
    const id = await line(acc, 2000);
    await pendingMatch(id, open, 1000);
    await pendingMatch(id, voided, 1000);
    await env.DB.prepare(`UPDATE invoices SET status = 'void' WHERE id = ?`).bind(voided).run();
    expect((await call('POST', `/api/v1/transactions/${id}/post`)).status).toBe(409);
    expect(await invoiceState(open)).toMatchObject({ amount_paid: 0, payments: 0 });
    expect((await state(id))?.is_reconciled).toBe(0);
  });

  it('keeps a posted line’s category fixed until it is undone', async () => {
    const acc = await account();
    const id = await line(acc, -500, { category });
    await call('POST', `/api/v1/transactions/${id}/post`);
    expect((await call('PATCH', `/api/v1/transactions/${id}`, { expenseCategoryId: null })).status).toBe(409);
    expect((await call('PATCH', `/api/v1/transactions/${id}`, { notes: 'Printer paper' })).status).toBe(200);
  });

  it('is owner-only', async () => {
    const acc = await account();
    const id = await line(acc, -500, { category });
    expect((await call('POST', `/api/v1/transactions/${id}/post`, undefined, accountantToken)).status).toBe(403);
    await call('POST', `/api/v1/transactions/${id}/post`);
    expect((await call('POST', `/api/v1/transactions/${id}/undo`, undefined, accountantToken)).status).toBe(403);
  });
});

describe('undo', () => {
  it('sends a categorised line back, keeping its category', async () => {
    const acc = await account();
    const id = await line(acc, -700, { category });
    await call('POST', `/api/v1/transactions/${id}/post`);
    expect((await call('POST', `/api/v1/transactions/${id}/undo`)).status).toBe(200);
    expect(await state(id)).toEqual({ is_reconciled: 0, reviewed_by: null, expense_category_id: category });
    expect((await call('POST', `/api/v1/transactions/${id}/undo`)).status).toBe(409);
  });

  it('deletes the payment, reopens the invoice and leaves the match pending', async () => {
    const acc = await account();
    const inv = await invoice(2500);
    const id = await line(acc, 2500);
    await pendingMatch(id, inv, 2500);
    await call('POST', `/api/v1/transactions/${id}/post`);

    const res = await call('POST', `/api/v1/transactions/${id}/undo`);
    expect(res.status).toBe(200);
    expect(res.body.reopened).toEqual([{ type: 'invoice', targetId: inv, amount: 2500 }]);
    expect(await invoiceState(inv)).toEqual({ status: 'sent', amount_paid: 0, payments: 0 });
    expect((await state(id))?.is_reconciled).toBe(0);
    const m = await env.DB.prepare('SELECT status, payment_id FROM transaction_matches WHERE transaction_id = ?')
      .bind(id).first<{ status: string; payment_id: string | null }>();
    expect(m).toEqual({ status: 'pending', payment_id: null });

    // Posting again is one click
    expect((await call('POST', `/api/v1/transactions/${id}/post`)).status).toBe(200);
    expect(await invoiceState(inv)).toEqual({ status: 'paid', amount_paid: 2500, payments: 1 });
  });

  it('clears the category that posting filled in, but keeps one chosen by hand', async () => {
    const acc = await account();
    const auto = await line(acc, 500);
    await pendingMatch(auto, await invoice(500), 500);
    await call('POST', `/api/v1/transactions/${auto}/post`);
    expect((await state(auto))?.expense_category_id).toBe(debtorsId);
    await call('POST', `/api/v1/transactions/${auto}/undo`);
    expect((await state(auto))?.expense_category_id).toBeNull();

    const chosen = await line(acc, 500, { category });
    await pendingMatch(chosen, await invoice(500), 500);
    await call('POST', `/api/v1/transactions/${chosen}/post`);
    await call('POST', `/api/v1/transactions/${chosen}/undo`);
    expect((await state(chosen))?.expense_category_id).toBe(category);
  });

  it('leaves an invoice part-paid when other payments remain', async () => {
    const acc = await account();
    const inv = await invoice(3000);
    const first = await line(acc, 1000);
    const second = await line(acc, 2000);
    await pendingMatch(first, inv, 1000);
    await call('POST', `/api/v1/transactions/${first}/post`);
    await pendingMatch(second, inv, 2000);
    await call('POST', `/api/v1/transactions/${second}/post`);

    await call('POST', `/api/v1/transactions/${second}/undo`);
    expect(await invoiceState(inv)).toEqual({ status: 'partial', amount_paid: 1000, payments: 1 });
    expect((await state(first))?.is_reconciled).toBe(1);
  });

  it('returns every line that shared the payment', async () => {
    const acc = await account();
    const inv = await invoice(3000);
    const a = await line(acc, 1000);
    const b = await line(acc, 2000);
    const ma = (await pendingMatch(a, inv, 1000)).body.id as string;
    const mb = (await pendingMatch(b, inv, 2000)).body.id as string;
    await call('POST', '/api/v1/transaction-matches/post', { matchIds: [ma, mb] });

    const res = await call('POST', `/api/v1/transactions/${a}/undo`);
    expect(res.body.alsoReturned).toEqual([b]);
    expect((await state(a))?.is_reconciled).toBe(0);
    expect((await state(b))?.is_reconciled).toBe(0);
    expect(await invoiceState(inv)).toEqual({ status: 'sent', amount_paid: 0, payments: 0 });
  });

  it('also reverses the other payments of lines it sends back, so none are left stuck', async () => {
    const acc = await account();
    const shared = await invoice(3000);
    const own = await invoice(500);
    const a = await line(acc, 1000);
    const b = await line(acc, 2500);
    const ma = (await pendingMatch(a, shared, 1000)).body.id as string;
    const mb = (await pendingMatch(b, shared, 2000)).body.id as string;
    await call('POST', '/api/v1/transaction-matches/post', { matchIds: [ma, mb] });
    await env.DB.prepare(`UPDATE transactions SET is_reconciled = 0 WHERE id = ?`).bind(b).run();
    await pendingMatch(b, own, 500);
    await call('POST', `/api/v1/transactions/${b}/post`);
    expect(await invoiceState(own)).toMatchObject({ status: 'paid' });

    const res = await call('POST', `/api/v1/transactions/${a}/undo`);
    expect(res.body.alsoReturned).toEqual([b]);
    expect(await invoiceState(shared)).toEqual({ status: 'sent', amount_paid: 0, payments: 0 });
    expect(await invoiceState(own)).toEqual({ status: 'sent', amount_paid: 0, payments: 0 });
    expect((await state(b))?.is_reconciled).toBe(0);
  });

  it('refuses when the invoice it paid has since been voided', async () => {
    const acc = await account();
    const inv = await invoice(800);
    const id = await line(acc, 800);
    await pendingMatch(id, inv, 800);
    await call('POST', `/api/v1/transactions/${id}/post`);
    await env.DB.prepare(`UPDATE invoices SET status = 'void' WHERE id = ?`).bind(inv).run();
    expect((await call('POST', `/api/v1/transactions/${id}/undo`)).status).toBe(409);
    expect((await state(id))?.is_reconciled).toBe(1);
  });
});

describe('All Transactions filters', () => {
  it('filters by direction, category, receipt and amount, a page at a time', async () => {
    const acc = await account();
    const inv = await invoice(1200);
    const income = await line(acc, 1200, { description: 'Customer receipt', date: '2026-05-03' });
    await pendingMatch(income, inv, 1200);
    const paper = await line(acc, -1250, { description: 'Paper', category, date: '2026-05-02' });
    const loose = await line(acc, -999, { description: 'Mystery', date: '2026-05-01' });
    await env.DB.prepare(`UPDATE transactions SET attachment_r2_key = 'x' WHERE id = ?`).bind(paper).run();

    const ids = async (query: string) =>
      (await call('GET', `/api/v1/transactions?bankAccountId=${acc}&page=1&${query}`)).body.rows!.map(r => r.id);
    expect(await ids('direction=in')).toEqual([income]);
    expect(await ids('direction=out')).toEqual([paper, loose]);
    expect(await ids('category=matched')).toEqual([income]);
    expect(await ids('category=none')).toEqual([loose]);
    expect(await ids(`category=${category}`)).toEqual([paper]);
    expect(await ids('receipt=attached')).toEqual([paper]);
    expect(await ids('receipt=missing')).toEqual([loose]);
    expect(await ids('q=12.50')).toEqual([paper]);
    expect(await ids('q=mystery')).toEqual([loose]);
    expect(await ids('from=2026-05-02&to=2026-05-02')).toEqual([paper]);

    const page2 = await call('GET', `/api/v1/transactions?bankAccountId=${acc}&page=2&pageSize=2`);
    expect(page2.body).toMatchObject({ total: 3, page: 2, pageSize: 2 });
    expect(page2.body.rows!.map(r => r.id)).toEqual([loose]);
  });

  it('shows a line with its matches and who posted it', async () => {
    const acc = await account();
    const inv = await invoice(600);
    const id = await line(acc, 600);
    await pendingMatch(id, inv, 600);
    await call('POST', `/api/v1/transactions/${id}/post`);
    const res = await call('GET', `/api/v1/transactions/${id}`);
    expect(res.body).toMatchObject({ id, is_reconciled: 1, reviewed_by_name: 'O' });
    expect(res.body.matches).toEqual([expect.objectContaining({ kind: 'payment', status: 'posted', allocated_amount: 600 })]);
  });
});

describe('bills, lookups and the list API', () => {
  it('pays a bill on posting and reopens it on undo', async () => {
    const acc = await account();
    const bill = uid();
    await env.DB.prepare(`
      INSERT INTO bills (id, vendor_id, status, issue_date, subtotal, total, created_by)
      VALUES (?, ?, 'pending', '2026-04-01', 2200, 2200, ?)
    `).bind(bill, vendor, ownerId).run();
    await env.DB.prepare(`
      INSERT INTO bill_items (bill_id, description, quantity, unit_price, tax_rate, amount, expense_category_id)
      VALUES (?, 'Goods', 1, 2200, 0, 2200, ?)
    `).bind(bill, category).run();
    const id = await line(acc, -2200, { category });
    expect((await call('POST', '/api/v1/transaction-matches', { transactionId: id, type: 'bill', targetId: bill, allocatedAmount: 2200 })).status).toBe(201);
    expect((await call('POST', `/api/v1/transactions/${id}/post`)).status).toBe(200);
    const billState = () => env.DB.prepare(
      `SELECT status, amount_paid, (SELECT COUNT(*) FROM payments_made WHERE bill_id = ?) AS payments FROM bills WHERE id = ?`
    ).bind(bill, bill).first();
    expect(await billState()).toEqual({ status: 'paid', amount_paid: 2200, payments: 1 });
    expect((await call('POST', `/api/v1/transactions/${id}/undo`)).body.reopened).toEqual([{ type: 'bill', targetId: bill, amount: 2200 }]);
    expect(await billState()).toEqual({ status: 'pending', amount_paid: 0, payments: 0 });
    expect((await state(id))?.expense_category_id).toBe(category);
  });

  it('answers 404 for lines that do not exist', async () => {
    expect((await call('GET', '/api/v1/transactions/nope')).status).toBe(404);
    expect((await call('POST', '/api/v1/transactions/nope/post')).status).toBe(404);
    expect((await call('POST', '/api/v1/transactions/nope/undo')).status).toBe(404);
    expect((await call('POST', '/api/v1/transactions/post', { ids: ['nope'] })).body).toMatchObject({
      posted: 0, failed: [{ id: 'nope', error: 'Transaction not found' }],
    });
  });

  it('still posts through the older matches endpoint, recording who did it', async () => {
    const acc = await account();
    const inv = await invoice(300);
    const id = await line(acc, 300);
    const match = (await pendingMatch(id, inv, 300)).body.id as string;
    expect((await call('POST', '/api/v1/transaction-matches/post', { matchIds: [match] })).status).toBe(200);
    expect(await state(id)).toMatchObject({ is_reconciled: 1, reviewed_by: ownerId });
  });

  it('keeps the unpaged list and the old reconciled filter working', async () => {
    const acc = await account();
    const a = await line(acc, -100, { category });
    await line(acc, -200);
    await call('POST', `/api/v1/transactions/${a}/post`);
    const all = await call('GET', `/api/v1/transactions?bankAccountId=${acc}`);
    expect(Array.isArray(all.body)).toBe(true);
    const old = await call('GET', `/api/v1/transactions?bankAccountId=${acc}&reconciled=1`);
    expect((old.body as unknown as Array<{ id: string }>).map(r => r.id)).toEqual([a]);
    const big = await call('GET', `/api/v1/transactions?bankAccountId=${acc}&page=1&pageSize=5000`);
    expect(big.body.pageSize).toBe(200);
  });

  it('forgets that a category came from a match once it is chosen by hand', async () => {
    const acc = await account();
    const id = await line(acc, 500);
    await pendingMatch(id, await invoice(500), 500);
    await call('POST', `/api/v1/transactions/${id}/post`);
    await call('POST', `/api/v1/transactions/${id}/undo`);
    await call('PATCH', `/api/v1/transactions/${id}`, { expenseCategoryId: debtorsId });
    await call('POST', `/api/v1/transactions/${id}/post`);
    await call('POST', `/api/v1/transactions/${id}/undo`);
    expect((await state(id))?.expense_category_id).toBe(debtorsId);
  });
});
