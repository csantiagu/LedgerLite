import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import app from '../../src/index';
import { issueAccessToken } from '../../src/middleware/auth';

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
let token = '';
let ownerId = '';

const uid = () => crypto.randomUUID().replace(/-/g, '');

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
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

beforeAll(async () => {
  ownerId = uid();
  await env.DB.prepare(
    `INSERT INTO users (id, email, name, role, password_hash) VALUES (?, ?, 'Owner', 'owner', 'x')`
  ).bind(ownerId, `${ownerId}@test.local`).run();
  token = await issueAccessToken(ownerId, `${ownerId}@test.local`, 'owner', env.JWT_SECRET);
});

/** One bank account, one client invoice (and optionally a vendor bill), plus bank lines. */
async function seed(opts: { invoiceTotal?: number; invoiceStatus?: string; billTotal?: number; txnAmounts: number[] }) {
  const ids = { client: uid(), invoice: uid(), vendor: uid(), bill: uid(), account: uid(), txns: [] as string[] };
  const db = env.DB;
  await db.batch([
    db.prepare(`INSERT INTO clients (id, name, created_by) VALUES (?, 'Client', ?)`).bind(ids.client, ownerId),
    db.prepare(`
      INSERT INTO invoices (id, client_id, invoice_number, status, issue_date, due_date, subtotal, total, created_by)
      VALUES (?, ?, ?, ?, '2026-05-01', '2099-05-31', ?, ?, ?)
    `).bind(ids.invoice, ids.client, `T-${ids.invoice}`, opts.invoiceStatus ?? 'sent',
            opts.invoiceTotal ?? 10_000, opts.invoiceTotal ?? 10_000, ownerId),
    db.prepare(`INSERT INTO vendors (id, name, created_by) VALUES (?, 'Vendor', ?)`).bind(ids.vendor, ownerId),
    db.prepare(`
      INSERT INTO bills (id, vendor_id, status, issue_date, subtotal, total, created_by)
      VALUES (?, ?, 'pending', '2026-05-01', ?, ?, ?)
    `).bind(ids.bill, ids.vendor, opts.billTotal ?? 5_000, opts.billTotal ?? 5_000, ownerId),
    db.prepare(`
      INSERT INTO bank_accounts (id, name, bank_name, csv_format, created_by) VALUES (?, 'Current', 'Test', 'monzo', ?)
    `).bind(ids.account, ownerId),
  ]);
  for (const [i, amount] of opts.txnAmounts.entries()) {
    const id = uid();
    ids.txns.push(id);
    await db.prepare(
      `INSERT INTO transactions (id, bank_account_id, date, description, amount) VALUES (?, ?, ?, ?, ?)`
    ).bind(id, ids.account, `2026-05-${String(10 + i).padStart(2, '0')}`, `Line ${i}`, amount).run();
  }
  return ids;
}

const match = (transactionId: string, targetId: string, allocatedAmount: number, type = 'invoice') =>
  call('POST', '/api/v1/transaction-matches', { transactionId, type, targetId, allocatedAmount });

async function invoiceState(id: string) {
  return env.DB.prepare(
    `SELECT status, amount_paid, (SELECT COUNT(*) FROM payments_received WHERE invoice_id = ?) AS payments
     FROM invoices WHERE id = ?`
  ).bind(id, id).first<{ status: string; amount_paid: number; payments: number }>();
}

describe('creating matches', () => {
  it('rejects money going out against a sales invoice', async () => {
    const s = await seed({ txnAmounts: [-10_000] });
    const res = await match(s.txns[0], s.invoice, 10_000);
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/money coming in/);
  });

  it('rejects allocating more than the bank line', async () => {
    const s = await seed({ invoiceTotal: 50_000, txnAmounts: [10_000] });
    expect((await match(s.txns[0], s.invoice, 10_001)).status).toBe(422);
  });

  it('rejects allocating more than the invoice balance, counting other pending lines', async () => {
    const s = await seed({ invoiceTotal: 10_000, txnAmounts: [6_000, 6_000] });
    expect((await match(s.txns[0], s.invoice, 6_000)).status).toBe(201);
    const second = await match(s.txns[1], s.invoice, 6_000);
    expect(second.status).toBe(422);
    expect(second.body.error).toMatch(/outstanding balance/);
    expect((await match(s.txns[1], s.invoice, 4_000)).status).toBe(201);
  });

  it('rejects void invoices', async () => {
    const s = await seed({ invoiceStatus: 'void', txnAmounts: [10_000] });
    expect((await match(s.txns[0], s.invoice, 10_000)).status).toBe(422);
  });

  it('returns 404 for an unknown invoice', async () => {
    const s = await seed({ txnAmounts: [10_000] });
    expect((await match(s.txns[0], 'nope', 10_000)).status).toBe(404);
  });
});

describe('posting matches', () => {
  it('records one payment, marks the invoice paid and reconciles the line', async () => {
    const s = await seed({ txnAmounts: [10_000] });
    const m = await match(s.txns[0], s.invoice, 10_000);
    const res = await call('POST', '/api/v1/transaction-matches/post', { matchIds: [m.body.id] });
    expect(res.status).toBe(200);
    expect(res.body.totalAllocated).toBe(10_000);

    expect(await invoiceState(s.invoice)).toEqual({ status: 'paid', amount_paid: 10_000, payments: 1 });
    const txn = await env.DB.prepare('SELECT is_reconciled FROM transactions WHERE id = ?').bind(s.txns[0]).first();
    expect(txn).toEqual({ is_reconciled: 1 });
  });

  it('combines several bank lines into one payment', async () => {
    const s = await seed({ invoiceTotal: 10_000, txnAmounts: [4_000, 6_000] });
    const a = await match(s.txns[0], s.invoice, 4_000);
    const b = await match(s.txns[1], s.invoice, 6_000);
    const res = await call('POST', '/api/v1/transaction-matches/post', { matchIds: [a.body.id, b.body.id] });
    expect(res.status).toBe(200);
    expect(await invoiceState(s.invoice)).toEqual({ status: 'paid', amount_paid: 10_000, payments: 1 });
  });

  it('refuses to reconcile a line that is only partly allocated', async () => {
    const s = await seed({ invoiceTotal: 10_000, txnAmounts: [10_000] });
    const m = await match(s.txns[0], s.invoice, 3_000);
    const res = await call('POST', '/api/v1/transaction-matches/post', { matchIds: [m.body.id] });
    expect(res.status).toBe(422);
    expect(await invoiceState(s.invoice)).toEqual({ status: 'sent', amount_paid: 0, payments: 0 });
    const txn = await env.DB.prepare('SELECT is_reconciled FROM transactions WHERE id = ?').bind(s.txns[0]).first();
    expect(txn).toEqual({ is_reconciled: 0 });
  });

  it('marks a partial payment as partial', async () => {
    const s = await seed({ invoiceTotal: 10_000, txnAmounts: [3_000] });
    const m = await match(s.txns[0], s.invoice, 3_000);
    await call('POST', '/api/v1/transaction-matches/post', { matchIds: [m.body.id] });
    expect(await invoiceState(s.invoice)).toEqual({ status: 'partial', amount_paid: 3_000, payments: 1 });
  });

  it('refuses to post the same matches twice', async () => {
    const s = await seed({ txnAmounts: [10_000] });
    const m = await match(s.txns[0], s.invoice, 10_000);
    expect((await call('POST', '/api/v1/transaction-matches/post', { matchIds: [m.body.id] })).status).toBe(200);
    expect((await call('POST', '/api/v1/transaction-matches/post', { matchIds: [m.body.id] })).status).toBe(409);
    expect(await invoiceState(s.invoice)).toEqual({ status: 'paid', amount_paid: 10_000, payments: 1 });
  });

  it('records only one payment when the same post is sent twice at once', async () => {
    const s = await seed({ txnAmounts: [10_000] });
    const m = await match(s.txns[0], s.invoice, 10_000);
    const results = await Promise.all([
      call('POST', '/api/v1/transaction-matches/post', { matchIds: [m.body.id] }),
      call('POST', '/api/v1/transaction-matches/post', { matchIds: [m.body.id] }),
    ]);
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
    expect(await invoiceState(s.invoice)).toEqual({ status: 'paid', amount_paid: 10_000, payments: 1 });
  });

  it('writes nothing if the invoice was voided after matching', async () => {
    const s = await seed({ txnAmounts: [10_000] });
    const m = await match(s.txns[0], s.invoice, 10_000);
    await env.DB.prepare(`UPDATE invoices SET status = 'void' WHERE id = ?`).bind(s.invoice).run();

    const res = await call('POST', '/api/v1/transaction-matches/post', { matchIds: [m.body.id] });
    expect(res.status).toBe(409);
    expect(await invoiceState(s.invoice)).toEqual({ status: 'void', amount_paid: 0, payments: 0 });
    const row = await env.DB.prepare('SELECT status FROM transaction_matches WHERE id = ?').bind(m.body.id).first();
    expect(row).toEqual({ status: 'pending' });
  });

  it('refuses a total above the outstanding balance', async () => {
    const s = await seed({ invoiceTotal: 10_000, txnAmounts: [10_000] });
    const m = await match(s.txns[0], s.invoice, 10_000);
    // Something else paid part of the invoice in the meantime
    await env.DB.prepare('UPDATE invoices SET amount_paid = 2000 WHERE id = ?').bind(s.invoice).run();
    expect((await call('POST', '/api/v1/transaction-matches/post', { matchIds: [m.body.id] })).status).toBe(422);
    expect((await invoiceState(s.invoice))?.payments).toBe(0);
  });

  it('pays a supplier bill from money going out', async () => {
    const s = await seed({ billTotal: 5_000, txnAmounts: [-5_000] });
    const cat = await env.DB.prepare('SELECT id FROM expense_categories LIMIT 1').first<{ id: string }>();
    await env.DB.prepare('UPDATE transactions SET expense_category_id = ? WHERE id = ?').bind(cat!.id, s.txns[0]).run();
    await env.DB.prepare(`
      INSERT INTO bill_items (bill_id, description, quantity, unit_price, tax_rate, amount, expense_category_id)
      VALUES (?, 'Goods', 1, 5000, 0, 5000, ?)
    `).bind(s.bill, cat!.id).run();

    const m = await match(s.txns[0], s.bill, 5_000, 'bill');
    expect(m.status).toBe(201);
    expect((await call('POST', '/api/v1/transaction-matches/post', { matchIds: [m.body.id] })).status).toBe(200);
    const bill = await env.DB.prepare(
      `SELECT status, amount_paid, (SELECT COUNT(*) FROM payments_made WHERE bill_id = ?) AS payments FROM bills WHERE id = ?`
    ).bind(s.bill, s.bill).first();
    expect(bill).toEqual({ status: 'paid', amount_paid: 5_000, payments: 1 });
  });
});
