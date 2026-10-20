import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import app from '../../src/index';
import { issueAccessToken } from '../../src/middleware/auth';

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
const uid = () => crypto.randomUUID().replace(/-/g, '');
let ownerToken = '';
let accountantToken = '';
let ownerId = '';
let account = '';

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
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

type Found = { results: Array<{ id: string; link: boolean; reasons: string[]; outstanding: number }>; hidden: number; links: boolean };
const search = async (txn: string, params = '') =>
  (await call('GET', `/api/v1/match-search?transactionId=${txn}${params}`)).body as unknown as Found;

async function party(table: 'clients' | 'vendors', name: string) {
  const id = uid();
  await env.DB.prepare(`INSERT INTO ${table} (id, name, created_by) VALUES (?, ?, ?)`).bind(id, name, ownerId).run();
  return id;
}

async function invoice(client: string, total: number, opts: { status?: string; paid?: number; source?: string } = {}) {
  const id = uid();
  await env.DB.prepare(`
    INSERT INTO invoices (id, client_id, invoice_number, status, issue_date, due_date, subtotal, total, amount_paid, source, created_by)
    VALUES (?, ?, ?, ?, '2026-08-01', '2026-08-31', ?, ?, ?, ?, ?)
  `).bind(id, client, `T-${id.slice(0, 8)}`, opts.status ?? 'sent', total, total, opts.paid ?? 0,
          opts.source ?? 'ledgerlite', ownerId).run();
  return id;
}

async function bill(vendor: string, total: number, status = 'pending') {
  const id = uid();
  await env.DB.prepare(`
    INSERT INTO bills (id, vendor_id, bill_number, status, due_date, subtotal, total, created_by)
    VALUES (?, ?, ?, ?, '2026-08-31', ?, ?, ?)
  `).bind(id, vendor, `B-${id.slice(0, 6)}`, status, total, total, ownerId).run();
  return id;
}

async function bankLine(amount: number, description: string, date = '2026-09-10') {
  const id = uid();
  await env.DB.prepare(
    `INSERT INTO transactions (id, bank_account_id, date, description, amount) VALUES (?, ?, ?, ?, ?)`
  ).bind(id, account, date, description, amount).run();
  return id;
}

beforeAll(async () => {
  ownerId = uid();
  account = uid();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (id, email, name, role, password_hash) VALUES (?, ?, 'O', 'owner', 'x')`)
      .bind(ownerId, `${ownerId}@test.local`),
    env.DB.prepare(`INSERT INTO bank_accounts (id, name, bank_name, csv_format, created_by) VALUES (?, 'A', 'B', 'monzo', ?)`)
      .bind(account, ownerId),
  ]);
  ownerToken = await issueAccessToken(ownerId, `${ownerId}@test.local`, 'owner', env.JWT_SECRET);
  const accountantId = uid();
  await env.DB.prepare(`INSERT INTO users (id, email, name, role, password_hash) VALUES (?, ?, 'A', 'accountant', 'x')`)
    .bind(accountantId, `${accountantId}@test.local`).run();
  accountantToken = await issueAccessToken(accountantId, `${accountantId}@test.local`, 'accountant', env.JWT_SECRET);
});

describe('Find match candidates', () => {
  it("lists the customer's open invoices, closest amount first, and nothing paid or void", async () => {
    const harbour = await party('clients', 'Harbour Lights Ltd');
    const other = await party('clients', 'Quayside Bakery');
    const far = await invoice(harbour, 90000);
    const exact = await invoice(harbour, 42000);
    const close = await invoice(harbour, 41800);
    const part = await invoice(harbour, 60000, { status: 'partial', paid: 10000 });
    const paid = await invoice(harbour, 42000, { status: 'paid', paid: 42000 });
    const voided = await invoice(harbour, 42000, { status: 'void' });
    const draft = await invoice(harbour, 42000, { status: 'draft' });
    const unrelated = await invoice(other, 123);

    const res = await search(await bankLine(42000, 'FPS HARBOUR LIGHTS'));
    const ids = res.results.map(r => r.id);
    expect(ids).toEqual([exact, close, part, far]);
    expect(res.results[0].reasons).toEqual(['name', 'exact']);
    expect(res.results[2].outstanding).toBe(50000);
    for (const hidden of [paid, voided, draft, unrelated]) expect(ids).not.toContain(hidden);
    expect(res.hidden).toBeGreaterThan(0); // the unrelated invoice is one Show all away

    const all = await search(await bankLine(42000, 'FPS HARBOUR LIGHTS'), '&all=1');
    expect(all.results.map(r => r.id)).toContain(unrelated);
    expect(all.results.map(r => r.id)).not.toContain(paid);
  });

  it('finds an invoice by amount alone when the name is missing', async () => {
    const c = await party('clients', 'Nameless Widgets');
    const inv = await invoice(c, 31337);
    const res = await search(await bankLine(31337, 'BANK GIRO CREDIT'));
    expect(res.results.find(r => r.id === inv)).toMatchObject({ reasons: ['exact'] });
  });

  it('takes off what other bank lines already claim', async () => {
    const c = await party('clients', 'Claimed Carpets');
    const inv = await invoice(c, 10000);
    const first = await bankLine(6000, 'CLAIMED CARPETS');
    expect((await call('POST', '/api/v1/transaction-matches', {
      transactionId: first, type: 'invoice', targetId: inv, allocatedAmount: 6000,
    })).status).toBe(201);
    // The first line doesn't see it again; another line sees only what's left
    expect((await search(first)).results.map(r => r.id)).not.toContain(inv);
    const second = await search(await bankLine(4000, 'CLAIMED CARPETS'));
    expect(second.results.find(r => r.id === inv)).toMatchObject({ outstanding: 4000, reasons: ['name', 'exact'] });
  });

  it('offers open bills for money going out, by vendor', async () => {
    const v = await party('vendors', 'Northern Timber Supplies');
    const open = await bill(v, 25000);
    const paid = await bill(v, 25000, 'paid');
    const res = await search(await bankLine(-25000, 'DD NORTHERN TIMBER'));
    expect(res.results[0]).toMatchObject({ id: open, reasons: ['name', 'exact'] });
    expect(res.results.map(r => r.id)).not.toContain(paid);
    expect(res.links).toBe(false);
  });

  it('searches by number or amount across everything open', async () => {
    const c = await party('clients', 'Searchable Signs');
    const inv = await invoice(c, 7777);
    const line = await bankLine(100, 'CASH');
    const number = (await env.DB.prepare('SELECT invoice_number FROM invoices WHERE id = ?').bind(inv)
      .first<{ invoice_number: string }>())!.invoice_number;
    expect((await search(line, `&q=${number}`)).results.map(r => r.id)).toEqual([inv]);
    expect((await search(line, '&q=77.77')).results.map(r => r.id)).toContain(inv);
  });

  it('needs a known bank line', async () => {
    expect((await call('GET', '/api/v1/match-search')).status).toBe(400);
    expect((await call('GET', '/api/v1/match-search?transactionId=nope')).status).toBe(404);
  });
});

/** A paid invoice as the QuickBooks import writes it, with its 'Imported from QuickBooks' payment. */
async function importedPaid(client: string, total: number) {
  const id = await invoice(client, total, { status: 'paid', paid: total, source: 'quickbooks' });
  await env.DB.prepare(`
    INSERT INTO payments_received (invoice_id, amount, payment_date, method, reference, created_by)
    VALUES (?, ?, '2026-03-01', 'other', 'Imported from QuickBooks', ?)
  `).bind(id, total, ownerId).run();
  return id;
}

const setMigration = (complete: boolean, token?: string) =>
  call('PUT', '/api/v1/settings/company/migration', { complete }, token);

describe('QuickBooks migration switch', () => {
  afterEach(async () => { await setMigration(false); });

  it('offers paid imported invoices for linking only until the migration is marked complete', async () => {
    const c = await party('clients', 'Migrating Mills');
    const imported = await importedPaid(c, 15000);
    const open = await invoice(c, 15000);
    const line = await bankLine(15000, 'MIGRATING MILLS');

    const during = await search(line);
    expect(during.links).toBe(true);
    expect(during.results.map(r => r.id)).toEqual(expect.arrayContaining([imported, open]));
    expect(during.results.find(r => r.id === imported)).toMatchObject({ link: true });

    const marked = await setMigration(true);
    expect(marked.status).toBe(200);
    expect(marked.body.migration_completed_at).toBeTruthy();
    expect((await call('GET', '/api/v1/settings/company')).body.migration_completed_at).toBeTruthy();

    for (const params of ['', '&all=1', '&q=Migrating']) {
      const after = await search(line, params);
      expect(after.links).toBe(false);
      expect(after.results.map(r => r.id)).not.toContain(imported);
      expect(after.results.map(r => r.id)).toContain(open);
    }
    const link = await call('POST', '/api/v1/transaction-matches/link', { transactionId: line, invoiceId: imported });
    expect(link.status).toBe(422);
    expect(String(link.body.error)).toContain('migration');

    // Reopening brings them back
    expect((await setMigration(false)).body.migration_completed_at).toBeNull();
    expect((await search(line)).results.map(r => r.id)).toContain(imported);
    expect((await call('POST', '/api/v1/transaction-matches/link', { transactionId: line, invoiceId: imported })).status).toBe(201);
  });

  it('keeps the first completion date and is owner-only', async () => {
    const first = (await setMigration(true)).body.migration_completed_at;
    expect((await setMigration(true)).body.migration_completed_at).toBe(first);
    expect((await setMigration(false, accountantToken)).status).toBe(403);
    expect((await setMigration('yes' as unknown as boolean)).status).toBe(400);
  });
});
