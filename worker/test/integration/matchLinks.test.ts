import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import app from '../../src/index';
import { issueAccessToken } from '../../src/middleware/auth';

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
const uid = () => crypto.randomUUID().replace(/-/g, '');
let ownerToken = '';
let accountantToken = '';
let ownerId = '';
let account = '';
let client = '';
let debtorsId = '';

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
  return { status: res.status, body: await res.json() as Record<string, unknown> & Array<Record<string, unknown>> };
}

const link = (transactionId: string, invoiceId: string, token?: string) =>
  call('POST', '/api/v1/transaction-matches/link', { transactionId, invoiceId }, token);

/** A paid invoice, as the QuickBooks import writes it (or a LedgerLite one with a real payment). */
async function paidInvoice(total: number, source: 'quickbooks' | 'ledgerlite' = 'quickbooks') {
  const id = uid();
  const number = `QB-${id.slice(0, 10)}`;
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO invoices (id, client_id, invoice_number, status, issue_date, due_date, subtotal, total,
        amount_paid, source, created_by)
      VALUES (?, ?, ?, 'paid', '2026-03-20', '2026-04-19', ?, ?, ?, ?, ?)
    `).bind(id, client, number, total, total, total, source, ownerId),
    env.DB.prepare(`
      INSERT INTO payments_received (invoice_id, amount, payment_date, method, reference, created_by)
      VALUES (?, ?, '2026-04-10', ?, ?, ?)
    `).bind(id, total, source === 'quickbooks' ? 'other' : 'bank_transfer',
            source === 'quickbooks' ? 'Imported from QuickBooks' : null, ownerId),
  ]);
  return { id, number };
}

async function bankLine(amount: number, description = 'Receipt') {
  const id = uid();
  await env.DB.prepare(
    `INSERT INTO transactions (id, bank_account_id, date, description, amount) VALUES (?, ?, '2026-04-11', ?, ?)`
  ).bind(id, account, description, amount).run();
  return id;
}

type Found = { results: Array<Record<string, unknown>>; hidden: number; links: boolean };
const search = async (txn: string, q?: string) => (await call('GET',
  `/api/v1/match-search?transactionId=${txn}${q ? `&q=${encodeURIComponent(q)}` : ''}`)).body as unknown as Found;

const txnState = (id: string) => env.DB.prepare(
  'SELECT is_reconciled, expense_category_id FROM transactions WHERE id = ?'
).bind(id).first<{ is_reconciled: number; expense_category_id: string | null }>();

const invoiceMoney = (id: string) => env.DB.prepare(
  `SELECT amount_paid, (SELECT COALESCE(SUM(amount), 0) FROM payments_received WHERE invoice_id = ?) AS received,
          (SELECT COUNT(*) FROM payments_received WHERE invoice_id = ?) AS payments
   FROM invoices WHERE id = ?`
).bind(id, id, id).first<{ amount_paid: number; received: number; payments: number }>();

beforeAll(async () => {
  ownerId = uid();
  const accountantId = uid();
  account = uid();
  client = uid();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (id, email, name, role, password_hash) VALUES (?, ?, 'O', 'owner', 'x')`)
      .bind(ownerId, `${ownerId}@test.local`),
    env.DB.prepare(`INSERT INTO users (id, email, name, role, password_hash) VALUES (?, ?, 'A', 'accountant', 'x')`)
      .bind(accountantId, `${accountantId}@test.local`),
    env.DB.prepare(`INSERT INTO bank_accounts (id, name, bank_name, csv_format, created_by) VALUES (?, 'A', 'B', 'monzo', ?)`)
      .bind(account, ownerId),
    env.DB.prepare(`INSERT INTO clients (id, name, created_by) VALUES (?, 'Acme Linking Ltd', ?)`).bind(client, ownerId),
    env.DB.prepare(`INSERT OR IGNORE INTO expense_categories (name) VALUES ('Debtors Control Account')`),
  ]);
  debtorsId = (await env.DB.prepare(
    `SELECT id FROM expense_categories WHERE name = 'Debtors Control Account'`
  ).first<{ id: string }>())!.id;
  ownerToken = await issueAccessToken(ownerId, `${ownerId}@test.local`, 'owner', env.JWT_SECRET);
  accountantToken = await issueAccessToken(accountantId, `${accountantId}@test.local`, 'accountant', env.JWT_SECRET);
});

describe('linking bank receipts to imported QuickBooks payments', () => {
  it('finds paid imported invoices, but not paid LedgerLite ones', async () => {
    const imported = await paidInvoice(1000);
    const own = await paidInvoice(1000, 'ledgerlite');
    const res = await search(await bankLine(1000), 'Acme Linking');
    const ids = res.results.map(r => r.id);
    expect(ids).toContain(imported.id);
    expect(ids).not.toContain(own.id);
    expect(res.results.find(r => r.id === imported.id)).toMatchObject({ link: true, outstanding: 1000 });
  });

  it('explains the receipt without recording the money again', async () => {
    const inv = await paidInvoice(2500);
    const txn = await bankLine(2500);
    const res = await link(txn, inv.id);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ allocatedAmount: 2500, reconciled: true });

    expect(await invoiceMoney(inv.id)).toEqual({ amount_paid: 2500, received: 2500, payments: 1 });
    expect(await txnState(txn)).toEqual({ is_reconciled: 1, expense_category_id: debtorsId });

    const unexplained = await call('GET', `/api/v1/transactions?bankAccountId=${account}&unexplained=1`);
    expect(unexplained.body.map(t => t.id)).not.toContain(txn);
    const listed = await call('GET', `/api/v1/transactions?bankAccountId=${account}`);
    expect(listed.body.find(t => t.id === txn)).toMatchObject({ match_kind: 'link', allocated_total: 2500 });
  });

  it('links an invoice only once, and drops it from search when fully linked', async () => {
    const inv = await paidInvoice(700);
    expect((await link(await bankLine(700), inv.id)).status).toBe(201);
    const second = await link(await bankLine(700), inv.id);
    expect(second.status).toBe(409);
    expect((await search(await bankLine(700), inv.number)).results).toEqual([]);
  });

  it('spreads one lump-sum receipt over several invoices', async () => {
    const a = await paidInvoice(600);
    const b = await paidInvoice(1000);
    const txn = await bankLine(1600);
    expect((await link(txn, a.id)).body).toMatchObject({ allocatedAmount: 600, reconciled: false });
    expect((await txnState(txn))?.is_reconciled).toBe(0);
    expect((await link(txn, b.id)).body).toMatchObject({ allocatedAmount: 1000, reconciled: true });
    expect((await txnState(txn))?.is_reconciled).toBe(1);
  });

  it('links part of a payment when the customer paid in instalments', async () => {
    const inv = await paidInvoice(900);
    expect((await link(await bankLine(400), inv.id)).body).toMatchObject({ allocatedAmount: 400 });
    expect((await link(await bankLine(500), inv.id)).body).toMatchObject({ allocatedAmount: 500 });
  });

  it('refuses LedgerLite invoices, money going out and accountants', async () => {
    const own = await paidInvoice(300, 'ledgerlite');
    expect((await link(await bankLine(300), own.id)).status).toBe(422);
    const imported = await paidInvoice(300);
    expect((await link(await bankLine(-300), imported.id)).status).toBe(422);
    expect((await link(await bankLine(300), imported.id, accountantToken)).status).toBe(403);
  });

  it('drops suggestions once a link posts the line', async () => {
    const inv = await paidInvoice(450);
    const txn = await bankLine(450);
    await env.DB.prepare(`
      INSERT INTO transaction_matches (transaction_id, match_type, invoice_id, allocated_amount, status)
      VALUES (?, 'invoice', ?, 450, 'suggested')
    `).bind(txn, inv.id).run();
    expect((await link(txn, inv.id)).status).toBe(409); // already matched (suggested) to it
    await env.DB.prepare(`DELETE FROM transaction_matches WHERE transaction_id = ?`).bind(txn).run();
    const other = await paidInvoice(450);
    await env.DB.prepare(`
      INSERT INTO transaction_matches (transaction_id, match_type, invoice_id, allocated_amount, status)
      VALUES (?, 'invoice', ?, 450, 'suggested')
    `).bind(txn, other.id).run();
    expect((await link(txn, inv.id)).status).toBe(201);
    const left = await env.DB.prepare(`SELECT COUNT(*) AS n FROM transaction_matches WHERE transaction_id = ? AND status = 'suggested'`)
      .bind(txn).first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it('unlinks, reopening the bank line and freeing the invoice', async () => {
    const inv = await paidInvoice(1200);
    const txn = await bankLine(1200);
    await link(txn, inv.id);
    const res = await call('POST', '/api/v1/transaction-matches/unlink', { transactionId: txn });
    expect(res.status).toBe(200);
    expect(await txnState(txn)).toEqual({ is_reconciled: 0, expense_category_id: null });
    expect(await invoiceMoney(inv.id)).toEqual({ amount_paid: 1200, received: 1200, payments: 1 });
    expect((await link(txn, inv.id)).status).toBe(201);
  });

  it('leaves a part-linked line in review until the rest is explained', async () => {
    const inv = await paidInvoice(400);
    const txn = await bankLine(1000);
    expect((await link(txn, inv.id)).body).toMatchObject({ allocatedAmount: 400, reconciled: false });
    expect(await env.DB.prepare('SELECT is_reconciled, reviewed_by FROM transactions WHERE id = ?').bind(txn).first())
      .toEqual({ is_reconciled: 0, reviewed_by: null });
    // Linking filled in Debtors Control Account, which explains the rest; posting is now allowed
    expect((await call('POST', `/api/v1/transactions/${txn}/post`)).status).toBe(200);
    expect(await env.DB.prepare('SELECT is_reconciled, reviewed_by FROM transactions WHERE id = ?').bind(txn).first())
      .toEqual({ is_reconciled: 1, reviewed_by: ownerId });
  });

  it('records who posted a fully linked line', async () => {
    const inv = await paidInvoice(350);
    const txn = await bankLine(350);
    await link(txn, inv.id);
    const row = await env.DB.prepare('SELECT reviewed_by, reviewed_at FROM transactions WHERE id = ?').bind(txn)
      .first<{ reviewed_by: string; reviewed_at: string | null }>();
    expect(row?.reviewed_by).toBe(ownerId);
    expect(row?.reviewed_at).toBeTruthy();
  });

  it('refuses void invoices and lines that are already posted', async () => {
    const voided = await paidInvoice(200);
    await env.DB.prepare(`UPDATE invoices SET status = 'void' WHERE id = ?`).bind(voided.id).run();
    expect((await link(await bankLine(200), voided.id)).status).toBe(422);

    const inv = await paidInvoice(200);
    const posted = await bankLine(200);
    await env.DB.prepare('UPDATE transactions SET is_reconciled = 1 WHERE id = ?').bind(posted).run();
    expect((await link(posted, inv.id)).status).toBe(409);
  });

  it('unlink keeps a category chosen by hand', async () => {
    const inv = await paidInvoice(650);
    const txn = await bankLine(650);
    const office = (await env.DB.prepare(`SELECT id FROM expense_categories WHERE name = 'Office Supplies'`).first<{ id: string }>())!.id;
    await call('PATCH', `/api/v1/transactions/${txn}`, { expenseCategoryId: office });
    await link(txn, inv.id);
    await call('POST', '/api/v1/transaction-matches/unlink', { transactionId: txn });
    expect(await txnState(txn)).toEqual({ is_reconciled: 0, expense_category_id: office });
  });

  it('offers a paid imported invoice by the customer name in the bank text, for linking', async () => {
    const inv = await paidInvoice(500);
    const res = await search(await bankLine(500, 'FASTER PMT ACME LINKING'));
    expect(res.links).toBe(true);
    expect(res.results.find(r => r.id === inv.id)).toMatchObject({ link: true, reasons: ['name', 'exact'] });
  });

  it('shows a line in review its pending match before a posted link', async () => {
    const linked = await paidInvoice(300);
    const txn = await bankLine(1000);
    await link(txn, linked.id);
    const open = uid();
    await env.DB.prepare(`
      INSERT INTO invoices (id, client_id, invoice_number, status, issue_date, due_date, subtotal, total, created_by)
      VALUES (?, ?, ?, 'sent', '2026-04-01', '2026-04-30', 700, 700, ?)
    `).bind(open, client, `OPEN-${open.slice(0, 10)}`, ownerId).run();
    await call('POST', '/api/v1/transaction-matches', { transactionId: txn, type: 'invoice', targetId: open, allocatedAmount: 700 });
    const listed = await call('GET', `/api/v1/transactions?bankAccountId=${account}&reviewed=0`);
    expect(listed.body.find(t => t.id === txn)).toMatchObject({ match_status: 'pending', match_target_id: open, allocated_total: 1000 });
  });
});
