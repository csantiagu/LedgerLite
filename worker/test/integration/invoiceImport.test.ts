import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import app from '../../src/index';
import { issueAccessToken } from '../../src/middleware/auth';
import { generateInvoiceNumber } from '../../src/services/invoiceNumber';

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
const uid = () => crypto.randomUUID().replace(/-/g, '');
let owner = '';
let accountant = '';

async function call(method: string, path: string, token: string, body?: unknown) {
  const res = await app.fetch(new Request(`http://api.test${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env, ctx);
  return { status: res.status, body: await res.json() as Record<string, any> };
}

beforeAll(async () => {
  for (const role of ['owner', 'accountant'] as const) {
    const id = uid();
    await env.DB.prepare(`INSERT INTO users (id, email, name, role, password_hash) VALUES (?, ?, 'U', ?, 'x')`)
      .bind(id, `${id}@test.local`, role).run();
    const token = await issueAccessToken(id, `${id}@test.local`, role, env.JWT_SECRET);
    if (role === 'owner') owner = token; else accountant = token;
  }
});

const rows = (prefix: string) => [
  { invoiceNumber: `${prefix}1`, customer: `Client ${prefix}`, issueDate: '2025-04-10', dueDate: '2025-05-10',
    total: 120_000, subtotal: 100_000, taxAmount: 20_000, openBalance: 0, paymentDate: '2025-04-20' },
  { invoiceNumber: `${prefix}2`, customer: `client ${prefix}`, issueDate: '2025-05-10',
    total: 60_000, subtotal: 50_000, taxAmount: 10_000, openBalance: 60_000 },
  { invoiceNumber: `${prefix}3`, customer: 'Credit customer', issueDate: '2025-05-11', total: -1_000, openBalance: 0 },
];

describe('importing QuickBooks invoices', () => {
  it('checks without writing anything', async () => {
    const res = await call('POST', '/api/v1/invoice-imports', owner, { rows: rows('dry-'), dryRun: true });
    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({ toImport: 2, skipped: 1, newCustomers: 1, total: 180_000, outstanding: 60_000 });
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM invoices WHERE invoice_number LIKE 'dry-%'`).first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it('creates customers, invoices, lines and payments, and skips them on a second run', async () => {
    const res = await call('POST', '/api/v1/invoice-imports', owner, { rows: rows('qb-'), dryRun: false });
    expect(res.status).toBe(200);
    expect(res.body.summary.toImport).toBe(2);

    const invoices = await env.DB.prepare(`
      SELECT i.invoice_number, i.status, i.source, i.amount_paid, c.name AS client,
             (SELECT COUNT(*) FROM invoice_items WHERE invoice_id = i.id) AS lines,
             (SELECT payment_date FROM payments_received WHERE invoice_id = i.id) AS paid_on
      FROM invoices i JOIN clients c ON c.id = i.client_id WHERE invoice_number LIKE 'qb-%' ORDER BY invoice_number
    `).all();
    expect(invoices.results).toEqual([
      { invoice_number: 'qb-1', status: 'paid', source: 'quickbooks', amount_paid: 120_000, client: 'Client qb-', lines: 1, paid_on: '2025-04-20' },
      { invoice_number: 'qb-2', status: 'sent', source: 'quickbooks', amount_paid: 0, client: 'Client qb-', lines: 1, paid_on: null },
    ]);

    const again = await call('POST', '/api/v1/invoice-imports', owner, { rows: rows('qb-'), dryRun: false });
    expect(again.body.summary).toMatchObject({ toImport: 0, skipped: 3 });
  });

  it('counts imported payments as income in the P&L', async () => {
    await call('POST', '/api/v1/invoice-imports', owner, { rows: rows('pl-'), dryRun: false });
    const pl = await call('GET', '/api/v1/reports/pl?from=2025-04-01&to=2025-04-30', owner);
    expect(JSON.stringify(pl.body)).toContain('Client pl-');
  });

  it('keeps imported invoices locked, but lets them take payments and an original PDF', async () => {
    await call('POST', '/api/v1/invoice-imports', owner, { rows: rows('lock-'), dryRun: false });
    const { id } = (await env.DB.prepare(`SELECT id FROM invoices WHERE invoice_number = 'lock-2'`).first<{ id: string }>())!;

    expect((await call('PATCH', `/api/v1/invoices/${id}`, owner, { notes: 'x' })).status).toBe(422);
    expect((await call('POST', `/api/v1/invoices/${id}/finalize`, owner)).status).toBe(422);
    expect((await call('POST', `/api/v1/invoices/${id}/payments`, owner,
      { amount: 60_000, payment_date: '2025-06-01', method: 'bank_transfer' })).status).toBeLessThan(300);

    const form = new FormData();
    form.append('file', new File([new TextEncoder().encode('%PDF-1.4 original')], 'Invoice_lock-2.pdf', { type: 'application/pdf' }));
    const upload = await app.fetch(new Request(`http://api.test/api/v1/invoices/${id}/original-pdf`, {
      method: 'POST', headers: { Authorization: `Bearer ${owner}`, 'X-Requested-With': 'XMLHttpRequest' }, body: form,
    }), env, ctx);
    expect(upload.status).toBe(200);
    const pdf = await app.fetch(new Request(`http://api.test/api/v1/invoices/${id}/pdf`, {
      headers: { Authorization: `Bearer ${owner}` },
    }), env, ctx);
    expect(await pdf.text()).toBe('%PDF-1.4 original');
  });

  it('is for the owner only', async () => {
    expect((await call('POST', '/api/v1/invoice-imports', accountant, { rows: rows('acc-'), dryRun: true })).status).toBe(403);
  });
});

describe('invoice numbering', () => {
  it('uses plain numbers when the prefix is empty', async () => {
    expect((await call('PATCH', '/api/v1/settings/company', owner, { invoice_prefix: '', invoice_next_sequence: 1044 })).status).toBe(200);
    expect(await generateInvoiceNumber(env.DB)).toBe('1044');
    await call('PATCH', '/api/v1/settings/company', owner, { invoice_prefix: 'INV', invoice_next_sequence: 7 });
    expect(await generateInvoiceNumber(env.DB)).toBe('INV-0007');
  });
});
