// Reconciliation integrity: imports never drop or double bank lines, an import made by mistake can
// be undone, and matching can't allocate the same money twice, even with requests racing.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import app from '../../src/index';
import { issueAccessToken } from '../../src/middleware/auth';
import type { Env } from '../../src/types';

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
const uid = () => crypto.randomUUID().replace(/-/g, '');
let ownerToken = '';
let ownerId = '';
let clientId = '';
let vendorId = '';
let categoryId = '';

type Json = any;   // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const res = await app.fetch(new Request(`http://api.test${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env, ctx);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

async function importCsv(account: string, csv: string, name = 'statement.csv', useEnv: Env = env) {
  const form = new FormData();
  form.append('bankAccountId', account);
  form.append('file', new File([csv], name, { type: 'text/csv' }));
  const res = await app.fetch(new Request('http://api.test/api/v1/bank-imports', {
    method: 'POST',
    headers: { Authorization: `Bearer ${ownerToken}`, 'X-Requested-With': 'XMLHttpRequest' },
    body: form,
  }), useEnv, ctx);
  return { status: res.status, body: await res.json() as Json };
}

const csv = (...lines: string[]) => ['Date,Description,Amount,Balance', ...lines].join('\n');

async function newAccount() {
  const id = uid();
  await env.DB.prepare(
    `INSERT INTO bank_accounts (id, name, bank_name, csv_format, created_by) VALUES (?, ?, 'Monzo', 'monzo', ?)`
  ).bind(id, `Recon ${id.slice(0, 6)}`, ownerId).run();
  return id;
}

const lines = async (account: string) => (await env.DB.prepare(
  'SELECT id, description, amount FROM transactions WHERE bank_account_id = ? ORDER BY date, rowid'
).bind(account).all<{ id: string; description: string; amount: number }>()).results;

async function openInvoice(total: number) {
  const id = uid();
  await env.DB.prepare(`
    INSERT INTO invoices (id, client_id, invoice_number, status, issue_date, due_date, subtotal, total, created_by)
    VALUES (?, ?, ?, 'sent', '2026-06-01', '2099-06-30', ?, ?, ?)
  `).bind(id, clientId, `REC-${id.slice(0, 10)}`, total, total, ownerId).run();
  return id;
}

async function bankLine(amount: number) {
  const id = uid();
  await env.DB.prepare(`INSERT INTO transactions (id, date, description, amount) VALUES (?, '2026-06-02', 'RECON', ?)`)
    .bind(id, amount).run();
  return id;
}

const match = (transactionId: string, type: 'invoice' | 'bill', targetId: string, allocatedAmount: number) =>
  call('POST', '/api/v1/transaction-matches', { transactionId, type, targetId, allocatedAmount });

beforeAll(async () => {
  ownerId = uid();
  clientId = uid();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (id, email, name, role, password_hash) VALUES (?, ?, 'O', 'owner', 'x')`)
      .bind(ownerId, `${ownerId}@test.local`),
    env.DB.prepare(`INSERT INTO clients (id, name, created_by) VALUES (?, 'Recon Client', ?)`).bind(clientId, ownerId),
  ]);
  ownerToken = await issueAccessToken(ownerId, `${ownerId}@test.local`, 'owner', env.JWT_SECRET);
  vendorId = (await call('POST', '/api/v1/vendors', { name: 'Recon Supplies' })).body.id;
  categoryId = (await env.DB.prepare('SELECT id FROM expense_categories LIMIT 1').first<{ id: string }>())!.id;
});

describe('importing statements', () => {
  it('keeps two genuine identical payments, and adds only the new copies from an overlapping file', async () => {
    const account = await newAccount();
    const first = await importCsv(account, csv(
      '01/06/2026,COSTA COFFEE,-4.50,95.50',
      '01/06/2026,COSTA COFFEE,-4.50,91.00',
    ), 'june-a.csv');
    expect(first.body).toMatchObject({ newRowCount: 2, skipped: 0, overlaps: [] });

    // A later download covering the same day, now with a third coffee and a new line
    const second = await importCsv(account, csv(
      '01/06/2026,COSTA COFFEE,-4.50,95.50',
      '01/06/2026,COSTA COFFEE,-4.50,91.00',
      '01/06/2026,COSTA COFFEE,-4.50,86.50',
      '02/06/2026,RENT,-500.00,-413.50',
    ), 'june-b.csv');
    expect(second.status).toBe(201);
    expect(second.body).toMatchObject({ rowCount: 4, newRowCount: 2, skipped: 2 });
    expect(second.body.overlaps).toEqual([expect.objectContaining({ id: first.body.id, filename: 'june-a.csv' })]);
    expect((await lines(account)).map(l => l.description))
      .toEqual(['COSTA COFFEE', 'COSTA COFFEE', 'COSTA COFFEE', 'RENT']);
  });

  it('refuses the same file twice, saying when it was imported', async () => {
    const account = await newAccount();
    const file = csv('03/06/2026,TRAIN,-12.00,88.00');
    const first = await importCsv(account, file);
    const again = await importCsv(account, file, 'renamed.csv');
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ importId: first.body.id, error: expect.stringMatching(/already imported on \d{4}-\d{2}-\d{2} by O/) });
    // The same file into another account is a different import
    expect((await importCsv(await newAccount(), file)).status).toBe(201);
  });

  it('writes nothing when the batch fails', async () => {
    const account = await newAccount();
    const failing = { ...env, DB: new Proxy(env.DB, {
      get(target, prop) {
        if (prop === 'batch') return async () => { throw new Error('disk I/O error'); };
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) } as Env;
    expect((await importCsv(account, csv('04/06/2026,LOST,-1.00,99.00'), 'x.csv', failing)).status).toBe(500);
    expect(await lines(account)).toEqual([]);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM bank_imports WHERE bank_account_id = ?')
      .bind(account).first<{ n: number }>())!.n).toBe(0);
  });

  it('turns an unreadable file away with a reason', async () => {
    const res = await importCsv(await newAccount(), 'not,a,statement\n1,2,3');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/couldn't be read as a monzo statement/);
  });
});

describe('undoing an import', () => {
  it('removes its untouched lines, records it, and lets the file be imported again', async () => {
    const account = await newAccount();
    const file = csv('05/06/2026,UNDO ME,-7.00,93.00', '05/06/2026,UNDO ME TOO,-8.00,85.00');
    const imported = await importCsv(account, file);
    const [first] = await lines(account);
    // A suggestion on a line doesn't count as work on it
    await env.DB.prepare(`
      INSERT INTO transaction_matches (transaction_id, match_type, invoice_id, allocated_amount, status)
      VALUES (?, 'invoice', ?, 700, 'suggested')
    `).bind(first!.id, await openInvoice(700)).run();

    const undone = await call('POST', `/api/v1/bank-imports/${imported.body.id}/undo`);
    expect(undone).toEqual({ status: 200, body: { ok: true, removed: 2 } });
    expect(await lines(account)).toEqual([]);

    const history = (await call('GET', `/api/v1/audit/bank_import/${imported.body.id}`)).body as Json[];
    expect(history.at(-1)).toMatchObject({
      action: 'bank_import.undone', old_values: { lines: [expect.objectContaining({ description: 'UNDO ME' }), expect.anything()] },
    });
    expect((await call('POST', `/api/v1/bank-imports/${imported.body.id}/undo`)).status).toBe(409);

    const list = (await call('GET', `/api/v1/bank-imports?bankAccountId=${account}`)).body as Json[];
    expect(list[0]).toMatchObject({ id: imported.body.id, undone_by_name: 'O' });
    expect((await importCsv(account, file)).status).toBe(201);
  });

  it('is refused while any line has been worked on, listing which and why', async () => {
    const account = await newAccount();
    const imported = await importCsv(account, csv(
      '06/06/2026,WORKED ON,-9.00,91.00',
      '06/06/2026,LEFT ALONE,-1.00,90.00',
    ));
    const worked = (await lines(account)).find(l => l.description === 'WORKED ON')!;
    await call('PATCH', `/api/v1/transactions/${worked.id}`, { expenseCategoryId: categoryId, notes: 'Mine' });

    const res = await call('POST', `/api/v1/bank-imports/${imported.body.id}/undo`);
    expect(res.status).toBe(409);
    expect(res.body.blocked).toEqual([expect.objectContaining({
      id: worked.id, reasons: ['category chosen by hand', 'has notes'],
    })]);
    expect(await lines(account)).toHaveLength(2);
  });

  it("doesn't count a rule's category and note as work", async () => {
    const account = await newAccount();
    await call('POST', '/api/v1/categorisation-rules',
      { matchText: `RULED ${account.slice(0, 6)}`, expenseCategoryId: categoryId, explanation: 'By rule' });
    const imported = await importCsv(account, csv(`07/06/2026,RULED ${account.slice(0, 6)},-3.00,97.00`));
    expect(imported.body.categorised).toBe(1);
    expect((await call('POST', `/api/v1/bank-imports/${imported.body.id}/undo`)).status).toBe(200);
  });
});

describe('matching', () => {
  it("lets only one of two racing matches take an invoice's last pounds", async () => {
    const invoice = await openInvoice(10_000);
    const [a, b] = [await bankLine(10_000), await bankLine(10_000)];
    const results = await Promise.all([match(a, 'invoice', invoice, 10_000), match(b, 'invoice', invoice, 10_000)]);
    expect(results.map(r => r.status).sort()).toEqual([201, 409]);
    expect((await env.DB.prepare(
      `SELECT COALESCE(SUM(allocated_amount), 0) AS n FROM transaction_matches WHERE invoice_id = ? AND status = 'pending'`
    ).bind(invoice).first<{ n: number }>())!.n).toBe(10_000);
  });

  it("lets only one of two racing matches use a bank line's money", async () => {
    const line = await bankLine(5_000);
    const results = await Promise.all([
      match(line, 'invoice', await openInvoice(5_000), 5_000),
      match(line, 'invoice', await openInvoice(5_000), 5_000),
    ]);
    expect(results.map(r => r.status).sort()).toEqual([201, 409]);
    // Only the match that landed is in the line's history
    const history = (await call('GET', `/api/v1/audit/transaction/${line}`)).body as Json[];
    expect(history.filter(e => e.action === 'transaction.match_added')).toHaveLength(1);
  });

  it('keeps one match per bank line and invoice', async () => {
    const invoice = await openInvoice(3_000);
    const line = await bankLine(3_000);
    const results = await Promise.all([match(line, 'invoice', invoice, 3_000), match(line, 'invoice', invoice, 3_000)]);
    expect(results.some(r => r.status === 201)).toBe(true);
    await expect(env.DB.prepare(`
      INSERT INTO transaction_matches (transaction_id, match_type, invoice_id, allocated_amount, status)
      VALUES (?, 'invoice', ?, 1, 'suggested')
    `).bind(line, invoice).run()).rejects.toThrow(/UNIQUE/);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM transaction_matches WHERE transaction_id = ?')
      .bind(line).first<{ n: number }>())!.n).toBe(1);
  });

  it('changes an existing match only while it still fits', async () => {
    const invoice = await openInvoice(4_000);
    const line = await bankLine(4_000);
    const first = await match(line, 'invoice', invoice, 1_000);
    expect(first.status).toBe(201);
    expect((await match(line, 'invoice', invoice, 4_000)).body).toEqual({ id: first.body.id, promoted: true });
    expect((await match(line, 'invoice', invoice, 4_001)).status).toBe(422);
  });
});

describe('bills and invoices with bank matches', () => {
  const items = (unit_price: number) => [{ description: 'Stock', quantity: 1, unit_price, tax_rate: 0, expense_category_id: categoryId }];

  it("won't cut a bill below what bank lines waiting to post already pay", async () => {
    const bill = (await call('POST', '/api/v1/bills', { vendor_id: vendorId, items: items(6_000) })).body.id;
    expect((await match(await bankLine(-6_000), 'bill', bill, 6_000)).status).toBe(201);

    const cut = await call('PUT', `/api/v1/bills/${bill}`, { vendor_id: vendorId, items: items(5_000) });
    expect(cut.status).toBe(409);
    expect(cut.body.error).toMatch(/already pay more than the new total/);
    // Same total, different description: fine
    expect((await call('PUT', `/api/v1/bills/${bill}`, {
      vendor_id: vendorId, items: [{ ...items(6_000)[0], description: 'Stock (June)' }],
    })).status).toBe(200);
  });

  it("won't edit a void bill", async () => {
    const bill = (await call('POST', '/api/v1/bills', { vendor_id: vendorId, items: items(100) })).body.id;
    await call('DELETE', `/api/v1/bills/${bill}`);
    expect((await call('PUT', `/api/v1/bills/${bill}`, { vendor_id: vendorId, items: items(200) })).status).toBe(409);
  });

  it('refuses to void an invoice a bank line is matched to', async () => {
    const invoice = await openInvoice(900);
    expect((await match(await bankLine(900), 'invoice', invoice, 900)).status).toBe(201);
    expect((await call('POST', `/api/v1/invoices/${invoice}/void`)).status).toBe(409);
    expect((await env.DB.prepare('SELECT status FROM invoices WHERE id = ?').bind(invoice).first<{ status: string }>())!.status)
      .toBe('sent');
  });
});
