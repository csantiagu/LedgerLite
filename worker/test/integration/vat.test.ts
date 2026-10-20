import { env } from 'cloudflare:workers';
import { unzipSync, strFromU8 } from 'fflate';
import { beforeAll, describe, expect, it } from 'vitest';
import app from '../../src/index';
import { issueAccessToken } from '../../src/middleware/auth';

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
const uid = () => crypto.randomUUID().replace(/-/g, '');
let ownerToken = '';
let ownerId = '';
let account = '';
let fees = '';      // a category whose usual VAT is 20%
let plain = '';     // a category with no usual VAT

async function call(method: string, path: string, body?: unknown) {
  return app.fetch(new Request(`http://api.test${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${ownerToken}`,
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env, ctx);
}
const json = async (method: string, path: string, body?: unknown) => {
  const res = await call(method, path, body);
  return { status: res.status, body: await res.json() as Record<string, unknown> };
};

async function line(amount: number, date: string, description: string) {
  const id = uid();
  await env.DB.prepare(`
    INSERT INTO transactions (id, bank_account_id, date, description, amount) VALUES (?, ?, ?, ?, ?)
  `).bind(id, account, date, description, amount).run();
  return id;
}
const vatOf = async (id: string) => (await env.DB.prepare('SELECT vat_rate FROM transactions WHERE id = ?')
  .bind(id).first<{ vat_rate: number | null }>())?.vat_rate;

beforeAll(async () => {
  ownerId = uid();
  account = uid();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (id, email, name, role, password_hash) VALUES (?, ?, 'O', 'owner', 'x')`)
      .bind(ownerId, `${ownerId}@test.local`),
    env.DB.prepare(`INSERT INTO bank_accounts (id, name, bank_name, csv_format, created_by) VALUES (?, 'VAT Bank', 'Test', 'monzo', ?)`)
      .bind(account, ownerId),
  ]);
  ownerToken = await issueAccessToken(ownerId, `${ownerId}@test.local`, 'owner', env.JWT_SECRET);
  fees  = ((await json('POST', '/api/v1/expense-categories', { name: `Accountancy ${ownerId}`, defaultVatRate: 0.2 })).body.id) as string;
  plain = ((await json('POST', '/api/v1/expense-categories', { name: `Sundries ${ownerId}` })).body.id) as string;
});

describe('VAT on bank lines', () => {
  it('lists each category with its usual VAT, and seeds HMRC payments as no VAT', async () => {
    const cats = (await json('GET', '/api/v1/expense-categories')).body as unknown as Array<{ id: string; name: string; default_vat_rate: number | null }>;
    expect(cats.find(c => c.id === fees)?.default_vat_rate).toBe(0.2);
    expect(cats.find(c => c.id === plain)?.default_vat_rate).toBeNull();
    expect(cats.find(c => c.name === 'VAT Payments / Refunds')?.default_vat_rate).toBe(0);
  });

  it('gives a line its category’s usual VAT, which can be changed until it is posted', async () => {
    const id = await line(-12000, '2023-02-03', 'ACCOUNTANT FEE');
    await json('PATCH', `/api/v1/transactions/${id}`, { expenseCategoryId: fees });
    expect(await vatOf(id)).toBe(0.2);

    // A category with no usual VAT keeps what the line already had
    await json('PATCH', `/api/v1/transactions/${id}`, { expenseCategoryId: plain });
    expect(await vatOf(id)).toBe(0.2);
    await json('PATCH', `/api/v1/transactions/${id}`, { vatRate: 0 });
    expect(await vatOf(id)).toBe(0);

    expect((await json('POST', `/api/v1/transactions/${id}/post`)).status).toBe(200);
    expect((await json('PATCH', `/api/v1/transactions/${id}`, { vatRate: 0.2 })).status).toBe(409);
  });

  it('refuses a VAT rate outside 0–100%', async () => {
    const id = await line(-500, '2023-02-04', 'Bad rate');
    expect((await json('PATCH', `/api/v1/transactions/${id}`, { vatRate: 20 })).status).toBe(400);
  });

  it('lets a rule set the VAT on the lines it categorises', async () => {
    const id = await line(-6000, '2023-02-05', `MONTHLY BOOKKEEPING ${ownerId}`);
    const rule = await json('POST', '/api/v1/categorisation-rules', {
      matchText: `BOOKKEEPING ${ownerId}`, direction: 'out', expenseCategoryId: plain, vatRate: 0.05,
    });
    expect(rule.status).toBe(201);
    expect(await vatOf(id)).toBe(0.05);
  });

  it('shows the VAT on every bank line in the accountant export', async () => {
    const fee = await line(-12000, '2023-03-01', 'FEE WITH VAT');
    await json('PATCH', `/api/v1/transactions/${fee}`, { expenseCategoryId: fees });
    const unset = await line(-3000, '2023-03-02', 'NO VAT CHOSEN');
    await json('PATCH', `/api/v1/transactions/${unset}`, { expenseCategoryId: plain });

    const res = await call('GET', '/api/v1/reports/accountant-export?from=2023-03-01&to=2023-03-31');
    expect(res.status).toBe(200);
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    const xml = Object.entries(files).filter(([n]) => n.startsWith('xl/worksheets/')).map(([, f]) => strFromU8(f)).join('');
    expect(xml).toContain('VAT amount');
    expect(xml).toContain('20% included');
    expect(xml).toContain('<v>100.00</v>');   // net of £120
    expect(xml).toContain('<v>20.00</v>');    // VAT in £120
    expect(xml).toContain('VAT NOT SET');
  });
});
