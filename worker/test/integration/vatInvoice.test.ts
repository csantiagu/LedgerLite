import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import app from '../../src/index';
import { issueAccessToken } from '../../src/middleware/auth';

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
const uid = () => crypto.randomUUID().replace(/-/g, '');
let ownerToken = '';
let ownerId = '';
let client = '';

type Json = Record<string, unknown>;

async function call(method: string, path: string, body?: unknown) {
  const res = await app.fetch(new Request(`http://api.test${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${ownerToken}`,
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env, ctx);
  return { status: res.status, body: await res.json() as Json };
}

async function invoice(opts: { subtotal?: number; tax?: number; status?: string } = {}) {
  const id = uid();
  const subtotal = opts.subtotal ?? 100_000;
  const tax = opts.tax ?? 0;
  await env.DB.prepare(`
    INSERT INTO invoices (id, client_id, invoice_number, status, issue_date, due_date, subtotal, tax_amount, total, created_by)
    VALUES (?, ?, ?, ?, '2025-03-10', '2025-04-09', ?, ?, ?, ?)
  `).bind(id, client, `OLD-${id.slice(0, 8)}`, opts.status ?? 'paid', subtotal, tax, subtotal + tax, ownerId).run();
  return { id, number: `OLD-${id.slice(0, 8)}` };
}

const vatInvoice = (id: string, body: Json = {}) => call('POST', `/api/v1/invoices/${id}/vat-invoice`, {
  issue_date: '2026-05-01', due_date: '2099-05-31', ...body,
});

beforeAll(async () => {
  ownerId = uid();
  client = uid();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (id, email, name, role, password_hash) VALUES (?, ?, 'O', 'owner', 'x')`)
      .bind(ownerId, `${ownerId}@test.local`),
    env.DB.prepare(`INSERT INTO clients (id, name, created_by) VALUES (?, 'Vatworth Trading', ?)`).bind(client, ownerId),
  ]);
  ownerToken = await issueAccessToken(ownerId, `${ownerId}@test.local`, 'owner', env.JWT_SECRET);
});

describe('VAT-only invoices', () => {
  it('needs the company VAT number first', async () => {
    await env.DB.prepare(`UPDATE company_settings SET vat_number = NULL WHERE id = 1`).run();
    const res = await vatInvoice((await invoice()).id);
    expect(res.status).toBe(422);
    expect(String(res.body.error)).toContain('VAT registration number');
    await env.DB.prepare(`UPDATE company_settings SET vat_number = 'GB123456789' WHERE id = 1`).run();
  });

  it('charges only the VAT on an invoice already raised, linked both ways, with a PDF', async () => {
    const original = await invoice();
    const res = await vatInvoice(original.id, { rate: 0.2 });
    expect(res.status).toBe(201);
    expect(res.body.tax_amount).toBe(20_000);

    const made = (await call('GET', `/api/v1/invoices/${res.body.id}`)).body;
    expect(made).toMatchObject({
      status: 'sent', subtotal: 0, tax_amount: 20_000, total: 20_000, client_id: client,
      vat_for_invoice_id: original.id, vat_for: { id: original.id, invoice_number: original.number },
    });
    expect(made.pdf_r2_key).toBeTruthy();
    expect((made.items as Array<Json>)[0]).toMatchObject({ unit_price: 0, tax_rate: 0.2, amount: 0 });
    expect(String((made.items as Array<Json>)[0].description)).toContain(original.number);

    const back = (await call('GET', `/api/v1/invoices/${original.id}`)).body;
    expect((back.vat_invoices as Array<Json>).map(v => v.id)).toEqual([res.body.id]);

    // Only one at a time, and the original can't be voided under it
    expect((await vatInvoice(original.id)).status).toBe(409);
    expect((await call('POST', `/api/v1/invoices/${original.id}/void`)).status).toBe(409);
  });

  it('charges VAT on part of the net, at another rate', async () => {
    const res = await vatInvoice((await invoice()).id, { rate: 0.05, net: 40_000 });
    expect(res.body.tax_amount).toBe(2_000);
    expect((await vatInvoice((await invoice({ subtotal: 1000 })).id, { net: 2000 })).status).toBe(422);
  });

  it('refuses drafts, void invoices, invoices that already charge VAT, and VAT-only invoices', async () => {
    expect((await vatInvoice((await invoice({ status: 'draft' })).id)).status).toBe(409);
    expect((await vatInvoice((await invoice({ status: 'void' })).id)).status).toBe(409);
    expect((await vatInvoice((await invoice({ tax: 20_000 })).id)).status).toBe(409);
    const made = await vatInvoice((await invoice()).id);
    expect((await vatInvoice(made.body.id as string)).status).toBe(409);
  });

  it('is paid like any invoice but adds no sales to the P&L', async () => {
    const original = await invoice({ subtotal: 50_000 });
    const made = await vatInvoice(original.id);
    const paid = await call('POST', `/api/v1/invoices/${made.body.id}/payments`, {
      amount: 10_000, payment_date: '2026-05-10', method: 'bank_transfer',
    });
    expect(paid.body.status).toBe('paid');
    const pl = await call('GET', '/api/v1/reports/pl?from=2026-05-01&to=2026-05-31');
    const row = (pl.body.income as Array<{ client_name: string; total: number }>).find(r => r.client_name === 'Vatworth Trading');
    expect(row?.total ?? 0).toBe(0);
  });

  it('shows up in Find match when the bank text quotes the original invoice number', async () => {
    const original = await invoice({ subtotal: 30_000 });
    const made = await vatInvoice(original.id);
    const txn = uid();
    await env.DB.prepare(`
      INSERT INTO transactions (id, date, description, amount) VALUES (?, '2026-05-12', ?, 6000)
    `).bind(txn, `FASTER PAYMENT ${original.number}`).run();
    const search = await call('GET', `/api/v1/match-search?transactionId=${txn}`);
    const hit = (search.body.results as Array<Json>).find(r => r.id === made.body.id);
    expect(hit).toMatchObject({ reasons: expect.arrayContaining(['number', 'exact']) });
    expect(String(hit?.label)).toContain(`VAT for ${original.number}`);
  });
});
