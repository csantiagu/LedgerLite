// Every path through the bills and vendors routes: lists and filters, edits, voiding, the
// accountant's flag, attachments and payments by hand.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import app from '../../src/index';
import { issueAccessToken } from '../../src/middleware/auth';
import type { Env } from '../../src/types';

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
const uid = () => crypto.randomUUID().replace(/-/g, '');
const PDF = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF');
let ownerToken = '';
let accountantToken = '';
let ownerId = '';
let categoryId = '';

type Res = { status: number; body: Record<string, unknown> & Record<string, unknown>[] };
const listed = (r: Res, id: string) => (r.body as unknown as { id: string }[]).some(v => v.id === id);

async function call(method: string, path: string, body?: unknown, opts: { token?: string; env?: Env } = {}): Promise<Res> {
  const res = await app.fetch(new Request(`http://api.test${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${opts.token ?? ownerToken}`,
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), opts.env ?? env, ctx);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

function upload(path: string, form: FormData | string) {
  return app.fetch(new Request(`http://api.test${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ownerToken}`, 'X-Requested-With': 'XMLHttpRequest' },
    body: form,
  }), env, ctx);
}

const pdfForm = () => {
  const form = new FormData();
  form.append('file', new File([PDF], 'supplier.pdf', { type: 'application/pdf' }));
  return form;
};

const vendor = async (name = 'Vendor') => (await call('POST', '/api/v1/vendors', { name })).body.id as string;

const item = (over: Record<string, unknown> = {}) =>
  ({ description: 'Goods', quantity: 1, unit_price: 1_000, tax_rate: 0, ...over });

const bill = async (vendorId: string, over: Record<string, unknown> = {}) =>
  (await call('POST', '/api/v1/bills', { vendor_id: vendorId, items: [item()], ...over })).body.id as string;

const row = (id: string) => env.DB.prepare('SELECT * FROM bills WHERE id = ?').bind(id).first<Record<string, unknown>>();

beforeAll(async () => {
  ownerId = uid();
  const accountantId = uid();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (id, email, name, role, password_hash) VALUES (?, ?, 'O', 'owner', 'x')`)
      .bind(ownerId, `${ownerId}@test.local`),
    env.DB.prepare(`INSERT INTO users (id, email, name, role, password_hash) VALUES (?, ?, 'A', 'accountant', 'x')`)
      .bind(accountantId, `${accountantId}@test.local`),
  ]);
  ownerToken = await issueAccessToken(ownerId, `${ownerId}@test.local`, 'owner', env.JWT_SECRET);
  accountantToken = await issueAccessToken(accountantId, `${accountantId}@test.local`, 'accountant', env.JWT_SECRET);
  categoryId = (await env.DB.prepare('SELECT id FROM expense_categories LIMIT 1').first<{ id: string }>())!.id;
});

describe('vendors', () => {
  it('lists active vendors and shows one by id', async () => {
    const id = await vendor('Listed Vendor');
    const list = await call('GET', '/api/v1/vendors');
    expect(listed(list, id)).toBe(true);

    await call('DELETE', `/api/v1/vendors/${id}`);
    expect(listed(await call('GET', '/api/v1/vendors'), id)).toBe(false);
    // Still readable by id after deactivating, for its old bills
    expect((await call('GET', `/api/v1/vendors/${id}`)).body).toMatchObject({ name: 'Listed Vendor', is_active: 0 });
  });

  it('creates a vendor with every detail', async () => {
    const res = await call('POST', '/api/v1/vendors', {
      name: 'Full Vendor', email: 'a@b.test', phone: '1', address: 'Road', tax_id: 'GB1', notes: 'n',
    });
    expect(res.status).toBe(201);
    expect((await call('GET', `/api/v1/vendors/${res.body.id}`)).body)
      .toMatchObject({ email: 'a@b.test', phone: '1', address: 'Road', tax_id: 'GB1', notes: 'n' });
  });

  it('is 404 for an unknown vendor on every route', async () => {
    const missing = uid();
    expect((await call('GET', `/api/v1/vendors/${missing}`)).status).toBe(404);
    expect((await call('PATCH', `/api/v1/vendors/${missing}`, { name: 'x' })).status).toBe(404);
    expect((await call('PUT', `/api/v1/vendors/${missing}`, { name: 'x' })).status).toBe(404);
    expect((await call('DELETE', `/api/v1/vendors/${missing}`)).status).toBe(404);
  });

  it('patches only the fields sent, and clears one sent as null', async () => {
    const id = await vendor('Patch Vendor');
    expect((await call('PATCH', `/api/v1/vendors/${id}`, {})).status).toBe(400);
    expect((await call('PATCH', `/api/v1/vendors/${id}`, { phone: '0123', email: 'p@v.test' })).status).toBe(200);
    expect((await call('PATCH', `/api/v1/vendors/${id}`, { phone: null })).status).toBe(200);
    expect((await call('GET', `/api/v1/vendors/${id}`)).body)
      .toMatchObject({ name: 'Patch Vendor', phone: null, email: 'p@v.test' });
  });

  it('replaces every field with PUT, blanking the ones left out', async () => {
    const id = await vendor('Put Vendor');
    await call('PUT', `/api/v1/vendors/${id}`, {
      name: 'Put Vendor Ltd', email: 'x@v.test', phone: '1', address: 'A', tax_id: 'GB2', notes: 'N',
    });
    expect((await call('GET', `/api/v1/vendors/${id}`)).body)
      .toMatchObject({ name: 'Put Vendor Ltd', email: 'x@v.test', phone: '1', address: 'A', tax_id: 'GB2', notes: 'N' });

    expect((await call('PUT', `/api/v1/vendors/${id}`, { name: 'Put Vendor Ltd' })).status).toBe(200);
    expect((await call('GET', `/api/v1/vendors/${id}`)).body)
      .toMatchObject({ email: null, phone: null, address: null, tax_id: null, notes: null });
  });
});

describe('listing and reading bills', () => {
  it('filters by flag and vendor, together or alone', async () => {
    const v = await vendor('Filter Vendor');
    const flagged = await bill(v);
    const plain = await bill(v);
    await call('PATCH', `/api/v1/bills/${flagged}/flag`, { flagged: true }, { token: accountantToken });

    const ids = (r: Res) => (r.body as unknown as { id: string }[]).map(b => b.id);
    expect(ids(await call('GET', `/api/v1/bills?vendor_id=${v}`)).sort()).toEqual([flagged, plain].sort());
    expect(ids(await call('GET', `/api/v1/bills?vendor_id=${v}&flagged=1`))).toEqual([flagged]);
    expect(ids(await call('GET', '/api/v1/bills?flagged=1'))).toContain(flagged);
    expect(ids(await call('GET', '/api/v1/bills'))).toEqual(expect.arrayContaining([flagged, plain]));
  });

  it('is 404 for an unknown bill', async () => {
    expect((await call('GET', `/api/v1/bills/${uid()}`)).status).toBe(404);
  });

  it('counts the bank matches that block voiding or paying by hand', async () => {
    const v = await vendor('Matched Vendor');
    const id = await bill(v);
    expect((await call('GET', `/api/v1/bills/${id}`)).body).toMatchObject({ pending_bank_matches: 0, bank_matches: 0 });

    const account = uid();
    const txn = uid();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO bank_accounts (id, name, bank_name, csv_format, created_by) VALUES (?, 'M', 'B', 'monzo', ?)`)
        .bind(account, ownerId),
      env.DB.prepare(`INSERT INTO transactions (id, bank_account_id, date, description, amount) VALUES (?, ?, '2026-05-01', 'x', ?)`)
        .bind(txn, account, -1_000),
    ]);
    await call('POST', '/api/v1/transaction-matches', { transactionId: txn, type: 'bill', targetId: id, allocatedAmount: 1_000 });
    expect((await call('GET', `/api/v1/bills/${id}`)).body).toMatchObject({ pending_bank_matches: 1, bank_matches: 1 });
  });
});

describe('creating and editing bills', () => {
  it('needs an active vendor', async () => {
    const v = await vendor('Gone Vendor');
    await call('DELETE', `/api/v1/vendors/${v}`);
    expect((await call('POST', '/api/v1/bills', { vendor_id: v, items: [item()] })).status).toBe(422);
    expect((await call('POST', '/api/v1/bills', { vendor_id: uid(), items: [item()] })).status).toBe(422);
  });

  it('saves every detail, or nulls for the ones left out', async () => {
    const v = await vendor('Detail Vendor');
    const full = await bill(v, {
      bill_number: 'S-1', issue_date: '2026-05-01', due_date: '2026-05-31', currency: 'EUR', notes: 'Note',
      items: [item({ expense_category_id: categoryId, tax_rate: 0.2 })],
    });
    expect(await row(full)).toMatchObject({
      bill_number: 'S-1', issue_date: '2026-05-01', due_date: '2026-05-31', currency: 'EUR', notes: 'Note',
      subtotal: 1_000, tax_amount: 200, total: 1_200,
    });
    const bare = await bill(v);
    expect(await row(bare)).toMatchObject({ bill_number: null, issue_date: null, due_date: null, currency: 'GBP', notes: null });
  });

  it('replaces a bill and its lines with PUT', async () => {
    const v = await vendor('Edit Vendor');
    const other = await vendor('Edit Vendor 2');
    const id = await bill(v, { bill_number: 'OLD', notes: 'old' });

    const res = await call('PUT', `/api/v1/bills/${id}`, {
      vendor_id: other, bill_number: 'NEW', issue_date: '2026-06-01', due_date: '2026-06-30', notes: 'new',
      items: [item({ unit_price: 2_000, expense_category_id: categoryId }), item({ unit_price: 500, tax_rate: 0.2 })],
    });
    expect(res.status).toBe(200);
    expect(await row(id)).toMatchObject({
      vendor_id: other, bill_number: 'NEW', issue_date: '2026-06-01', due_date: '2026-06-30', notes: 'new',
      subtotal: 2_500, tax_amount: 100, total: 2_600,
    });
    const { results: lines } = await env.DB.prepare(
      'SELECT unit_price, expense_category_id FROM bill_items WHERE bill_id = ? ORDER BY sort_order'
    ).bind(id).all();
    expect(lines).toEqual([
      { unit_price: 2_000, expense_category_id: categoryId },
      { unit_price: 500, expense_category_id: null },
    ]);

    await call('PUT', `/api/v1/bills/${id}`, { vendor_id: other, items: [item()] });
    expect(await row(id)).toMatchObject({ bill_number: null, issue_date: null, due_date: null, notes: null });
  });

  it('refuses edits to unknown or paid bills and to inactive vendors', async () => {
    const v = await vendor('Locked Vendor');
    expect((await call('PUT', `/api/v1/bills/${uid()}`, { vendor_id: v, items: [item()] })).status).toBe(404);

    const id = await bill(v);
    const gone = await vendor('Locked Gone');
    await call('DELETE', `/api/v1/vendors/${gone}`);
    expect((await call('PUT', `/api/v1/bills/${id}`, { vendor_id: gone, items: [item()] })).status).toBe(422);

    await call('POST', `/api/v1/bills/${id}/payments`, { amount: 100, payment_date: '2026-05-02' });
    expect((await call('PUT', `/api/v1/bills/${id}`, { vendor_id: v, items: [item()] })).status).toBe(409);
  });
});

describe('voiding bills', () => {
  it('voids an open bill once, and is 404 for an unknown one', async () => {
    const id = await bill(await vendor('Void Vendor'));
    expect((await call('DELETE', `/api/v1/bills/${id}`)).status).toBe(200);
    expect((await row(id))!.status).toBe('void');
    expect((await call('DELETE', `/api/v1/bills/${id}`)).status).toBe(422);
    expect((await call('DELETE', `/api/v1/bills/${uid()}`)).status).toBe(404);
  });
});

describe('the accountant flag', () => {
  it('flags with notes, unflags without, and is 404 for an unknown bill', async () => {
    const id = await bill(await vendor('Flag Vendor'));
    const flag = (body: unknown) => call('PATCH', `/api/v1/bills/${id}/flag`, body, { token: accountantToken });

    expect((await flag({ flagged: true, accountant_notes: 'Missing receipt' })).status).toBe(200);
    expect(await row(id)).toMatchObject({ flagged: 1, accountant_notes: 'Missing receipt' });
    expect((await flag({ flagged: false })).status).toBe(200);
    expect(await row(id)).toMatchObject({ flagged: 0, accountant_notes: null });

    expect((await call('PATCH', `/api/v1/bills/${uid()}/flag`, { flagged: true }, { token: accountantToken })).status).toBe(404);
  });
});

describe('bill attachments', () => {
  it('needs a known bill and a file', async () => {
    expect((await upload(`/api/v1/bills/${uid()}/attachments`, pdfForm())).status).toBe(404);
    const id = await bill(await vendor('Attach Vendor'));
    expect((await upload(`/api/v1/bills/${id}/attachments`, new FormData())).status).toBe(400);
    expect((await upload(`/api/v1/bills/${id}/attachments`, 'not a form')).status).toBe(400);
  });

  it('is 404 when there is no bill or no file stored', async () => {
    expect((await call('GET', `/api/v1/bills/${uid()}/attachments`)).status).toBe(404);
    const id = await bill(await vendor('No File Vendor'));
    expect((await call('GET', `/api/v1/bills/${id}/attachments`)).status).toBe(404);
  });

  it('streams the stored file under its name, or the last part of its key when it has none', async () => {
    const id = await bill(await vendor('Stream Vendor'));
    expect((await upload(`/api/v1/bills/${id}/attachments`, pdfForm())).status).toBe(201);
    const named = await app.fetch(new Request(`http://api.test/api/v1/bills/${id}/attachments`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    }), env, ctx);
    expect(named.headers.get('content-disposition')).toContain('supplier.pdf');

    await env.DB.prepare('UPDATE bills SET attachment_filename = NULL WHERE id = ?').bind(id).run();
    const key = (await row(id))!.attachment_r2_key as string;
    const unnamed = await app.fetch(new Request(`http://api.test/api/v1/bills/${id}/attachments`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    }), env, ctx);
    expect(unnamed.headers.get('content-disposition')).toContain(key.split('/').pop()!);
  });

  it('returns a signed link when the bucket can make one', async () => {
    const id = await bill(await vendor('Signed Vendor'));
    await upload(`/api/v1/bills/${id}/attachments`, pdfForm());
    const signing = { ...env, R2: { createPresignedUrl: async () => 'https://signed.test/file' } } as unknown as Env;
    const res = await call('GET', `/api/v1/bills/${id}/attachments`, undefined, { env: signing });
    expect(res.body).toEqual({ url: 'https://signed.test/file', filename: 'supplier.pdf', expires_in: 900 });
  });
});

describe('payments by hand', () => {
  it('records a payment without a method, and refuses one on a void bill', async () => {
    const id = await bill(await vendor('Pay Vendor'));
    const res = await call('POST', `/api/v1/bills/${id}/payments`, { amount: 400, payment_date: '2026-05-02' });
    expect(res).toMatchObject({ status: 201, body: { status: 'partial' } });
    const payment = await env.DB.prepare('SELECT method FROM payments_made WHERE id = ?').bind(res.body.id).first();
    expect(payment).toEqual({ method: null });

    const voided = await bill(await vendor('Pay Void Vendor'));
    await call('DELETE', `/api/v1/bills/${voided}`);
    expect((await call('POST', `/api/v1/bills/${voided}/payments`, { amount: 100, payment_date: '2026-05-02' })).status)
      .toBeGreaterThanOrEqual(400);
  });

  it('deletes a payment, and refuses an unknown one', async () => {
    const id = await bill(await vendor('Unpay Vendor'));
    const paid = await call('POST', `/api/v1/bills/${id}/payments`, { amount: 1_000, payment_date: '2026-05-02', method: 'card' });
    expect((await call('DELETE', `/api/v1/bills/${id}/payments/${paid.body.id}`)).status).toBe(200);
    expect(await row(id)).toMatchObject({ status: 'pending', amount_paid: 0 });
    expect((await call('DELETE', `/api/v1/bills/${id}/payments/${uid()}`)).status).toBe(404);
  });
});
