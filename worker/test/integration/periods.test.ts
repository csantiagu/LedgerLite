// Locking VAT quarters: once a quarter is reviewed and locked, nothing dated in it (or before it)
// can change until the owner unlocks it with a reason. Uses 2019 dates, which no other test touches.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import app from '../../src/index';
import { issueAccessToken } from '../../src/middleware/auth';

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
const uid = () => crypto.randomUUID().replace(/-/g, '');
let ownerToken = '';
let accountantToken = '';
let ownerId = '';
let accountId = '';
let clientId = '';
let vendorId = '';
let categoryId = '';

type Json = any;   // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(method: string, path: string, body?: unknown, token = ownerToken): Promise<{ status: number; body: Json }> {
  const res = await app.fetch(new Request(`http://api.test${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env, ctx);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

async function importCsv(csv: string) {
  const form = new FormData();
  form.append('bankAccountId', accountId);
  form.append('file', new File([csv], `s-${uid()}.csv`, { type: 'text/csv' }));
  const res = await app.fetch(new Request('http://api.test/api/v1/bank-imports', {
    method: 'POST',
    headers: { Authorization: `Bearer ${ownerToken}`, 'X-Requested-With': 'XMLHttpRequest' },
    body: form,
  }), env, ctx);
  return { status: res.status, body: await res.json() as Json };
}

/** A bank line, posted with a category unless `posted` is false. */
async function line(date: string, amount: number, posted = true) {
  const id = uid();
  await env.DB.prepare(`
    INSERT INTO transactions (id, bank_account_id, date, description, amount, expense_category_id, vat_rate, is_reconciled)
    VALUES (?, ?, ?, 'PERIOD LINE', ?, ?, 0, ?)
  `).bind(id, accountId, date, amount, categoryId, posted ? 1 : 0).run();
  return id;
}

async function invoice(issueDate: string, status = 'sent') {
  const id = uid();
  await env.DB.prepare(`
    INSERT INTO invoices (id, client_id, invoice_number, status, issue_date, due_date, subtotal, total, created_by)
    VALUES (?, ?, ?, ?, ?, ?, 5000, 5000, ?)
  `).bind(id, clientId, `PER-${id.slice(0, 10)}`, status, issueDate, issueDate, ownerId).run();
  return id;
}

const lockDate = async () => (await call('GET', '/api/v1/periods')).body.lockDate as string | null;

beforeAll(async () => {
  ownerId = uid();
  const accountantId = uid();
  accountId = uid();
  clientId = uid();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (id, email, name, role, password_hash) VALUES (?, ?, 'Olivia', 'owner', 'x')`)
      .bind(ownerId, `${ownerId}@test.local`),
    env.DB.prepare(`INSERT INTO users (id, email, name, role, password_hash) VALUES (?, ?, 'Alex', 'accountant', 'x')`)
      .bind(accountantId, `${accountantId}@test.local`),
    env.DB.prepare(`INSERT INTO bank_accounts (id, name, bank_name, csv_format, created_by) VALUES (?, 'Periods', 'Monzo', 'monzo', ?)`)
      .bind(accountId, ownerId),
    env.DB.prepare(`INSERT INTO clients (id, name, created_by) VALUES (?, 'Period Client', ?)`).bind(clientId, ownerId),
  ]);
  ownerToken = await issueAccessToken(ownerId, `${ownerId}@test.local`, 'owner', env.JWT_SECRET);
  accountantToken = await issueAccessToken(accountantId, `${accountantId}@test.local`, 'accountant', env.JWT_SECRET);
  vendorId = (await call('POST', '/api/v1/vendors', { name: 'Period Supplies' })).body.id;
  categoryId = (await env.DB.prepare('SELECT id FROM expense_categories LIMIT 1').first<{ id: string }>())!.id;
});

describe('locking a quarter', () => {
  it('lists the quarters with their status', async () => {
    const res = await call('GET', '/api/v1/periods', undefined, accountantToken);
    expect(res.status).toBe(200);
    expect(res.body.quarterEndMonth).toBe(3);
    const [latest] = res.body.quarters;
    expect(latest.status).toBe('current');
    expect(res.body.quarters.every((q: Json) => /^\d{4}-(03|06|09|12)-\d{2}$/.test(q.end))).toBe(true);
  });

  it('only locks the end of a quarter that has ended, with nothing left in For Review', async () => {
    expect((await call('POST', '/api/v1/periods/lock', { periodEnd: '2019-03-30' })).status).toBe(400);
    expect((await call('POST', '/api/v1/periods/lock', { periodEnd: '2099-03-31' })).status).toBe(422);

    const waiting = await line('2019-03-20', -1_000, false);
    const refused = await call('POST', '/api/v1/periods/lock', { periodEnd: '2019-03-31' }, accountantToken);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ unposted: 1, error: expect.stringMatching(/still in For Review/) });
    expect((await call('POST', `/api/v1/transactions/${waiting}/post`)).status).toBe(200);
  });

  it('lets the accountant lock it, and records who did', async () => {
    const res = await call('POST', '/api/v1/periods/lock', { periodEnd: '2019-03-31', note: 'Q1 reviewed' }, accountantToken);
    expect(res.status).toBe(201);
    expect(await lockDate()).toBe('2019-03-31');
    expect((await call('POST', '/api/v1/periods/lock', { periodEnd: '2019-03-31' })).status).toBe(409);

    const history = (await call('GET', `/api/v1/audit/period_lock/${res.body.id}`)).body as Json[];
    expect(history[0]).toMatchObject({
      action: 'period.locked', user_name: 'Alex', summary: 'Locked Jan–Mar 2019 and everything before it',
    });
  });
});

describe('while a quarter is locked', () => {
  it('refuses to post or undo bank lines dated in it', async () => {
    const posted = await line('2019-02-10', -2_000);
    const undo = await call('POST', `/api/v1/transactions/${posted}/undo`);
    expect(undo.status).toBe(423);
    expect(undo.body.error).toMatch(/^10\/02\/2019 is in a locked VAT period/);
    // Notes don't change the figures, so they can still be written
    expect((await call('PATCH', `/api/v1/transactions/${posted}`, { notes: 'Explained later' })).status).toBe(200);
  });

  it('refuses payments dated in it, and removing them', async () => {
    const inv = await invoice('2019-01-15');
    const paid = await env.DB.prepare(`
      INSERT INTO payments_received (id, invoice_id, amount, payment_date, method, created_by)
      VALUES (?, ?, 1000, '2019-02-01', 'cash', ?) RETURNING id
    `).bind(uid(), inv, ownerId).first<{ id: string }>();
    expect((await call('POST', `/api/v1/invoices/${inv}/payments`, { amount: 500, payment_date: '2019-03-01', method: 'cash' })).status).toBe(423);
    expect((await call('DELETE', `/api/v1/invoices/${inv}/payments/${paid!.id}`)).status).toBe(423);
    // A payment dated after the lock is fine, even on an invoice from the locked quarter
    expect((await call('POST', `/api/v1/invoices/${inv}/payments`, { amount: 500, payment_date: '2019-04-02', method: 'cash' })).status).toBe(201);
  });

  it('refuses to finalise, void or raise VAT on invoices dated in it', async () => {
    const draft = await invoice('2019-03-05', 'draft');
    expect((await call('POST', `/api/v1/invoices/${draft}/finalize`)).status).toBe(423);
    // Still only a draft, so it can be edited and moved out of the locked quarter
    expect((await call('PATCH', `/api/v1/invoices/${draft}`, { issue_date: '2019-04-05' })).status).toBe(200);
    expect((await call('POST', `/api/v1/invoices/${draft}/finalize`)).status).toBe(200);

    expect((await call('POST', `/api/v1/invoices/${await invoice('2019-01-20')}/void`)).status).toBe(423);
  });

  it('refuses bills dated in it, and moving a bill into it', async () => {
    const items = [{ description: 'Stock', quantity: 1, unit_price: 1_000, tax_rate: 0, expense_category_id: categoryId }];
    expect((await call('POST', '/api/v1/bills', { vendor_id: vendorId, issue_date: '2019-03-01', items })).status).toBe(423);
    const bill = (await call('POST', '/api/v1/bills', { vendor_id: vendorId, issue_date: '2019-04-01', items })).body.id;
    expect((await call('PUT', `/api/v1/bills/${bill}`, { vendor_id: vendorId, issue_date: '2019-03-31', items })).status).toBe(423);
    expect((await call('PUT', `/api/v1/bills/${bill}`, { vendor_id: vendorId, issue_date: '2019-04-02', items })).status).toBe(200);
  });

  it('leaves out statement lines dated in it, and QuickBooks invoices dated in it', async () => {
    const imported = await importCsv(['Date,Description,Amount,Balance',
      '30/03/2019,LOCKED LINE,-5.00,95.00', '02/04/2019,OPEN LINE,-6.00,89.00'].join('\n'));
    expect(imported.body).toMatchObject({ newRowCount: 1, inLockedPeriod: 1, lockDate: '2019-03-31' });

    const qb = await call('POST', '/api/v1/invoice-imports', { dryRun: true, rows: [
      { invoiceNumber: `QB-${uid().slice(0, 6)}`, customer: 'Old Co', issueDate: '2019-02-01', total: 1_000, openBalance: 0 },
    ] });
    expect(qb.body.outcomes[0]).toMatchObject({ action: 'skip', reason: 'In a locked VAT period' });
  });
});

describe('unlocking', () => {
  it('is for the owner only, with a reason', async () => {
    expect((await call('POST', '/api/v1/periods/unlock', { reason: 'Mistake' }, accountantToken)).status).toBe(403);
    expect((await call('POST', '/api/v1/periods/unlock', { reason: '' })).status).toBe(400);
  });

  it('reopens the latest locked quarter only, and records why', async () => {
    // The line imported above is in Apr–Jun, still in For Review: post it so the quarter can lock
    const open = await env.DB.prepare(`SELECT id FROM transactions WHERE bank_account_id = ? AND description = 'OPEN LINE'`)
      .bind(accountId).first<{ id: string }>();
    await call('PATCH', `/api/v1/transactions/${open!.id}`, { expenseCategoryId: categoryId, vatRate: 0 });
    expect((await call('POST', `/api/v1/transactions/${open!.id}/post`)).status).toBe(200);

    const q2 = await call('POST', '/api/v1/periods/lock', { periodEnd: '2019-06-30' });
    expect(q2.status).toBe(201);
    expect(await lockDate()).toBe('2019-06-30');

    const res = await call('POST', '/api/v1/periods/unlock', { reason: 'Supplier credit arrived late' });
    expect(res.body).toEqual({ ok: true, lockDate: '2019-03-31' });
    const history = (await call('GET', `/api/v1/audit/period_lock/${q2.body.id}`)).body as Json[];
    expect(history.at(-1)).toMatchObject({
      action: 'period.unlocked', summary: 'Unlocked Apr–Jun 2019: Supplier credit arrived late',
    });

    const periods = (await call('GET', '/api/v1/periods')).body;
    expect(periods.history[0]).toMatchObject({ period_end: '2019-06-30', unlock_reason: 'Supplier credit arrived late' });

    // Q1 is still locked until it is unlocked too; then everything is open again
    expect((await call('POST', `/api/v1/transactions/${await line('2019-03-01', -100)}/undo`)).status).toBe(423);
    expect((await call('POST', '/api/v1/periods/unlock', { reason: 'Reopen Q1' })).status).toBe(200);
    expect(await lockDate()).toBeNull();
    expect((await call('POST', `/api/v1/transactions/${await line('2019-03-01', -100)}/undo`)).status).toBe(200);
    expect((await call('POST', '/api/v1/periods/unlock', { reason: 'Again' })).status).toBe(404);
  });
});
