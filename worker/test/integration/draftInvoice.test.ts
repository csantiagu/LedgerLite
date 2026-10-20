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

type Json = Record<string, unknown>;

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

const draftBody = (items: Json[]) => ({
  client_id: client,
  issue_date: '2026-06-01',
  due_date: '2099-06-30',
  items,
});

beforeAll(async () => {
  ownerId = uid();
  const accountantId = uid();
  client = uid();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (id, email, name, role, password_hash) VALUES (?, ?, 'O', 'owner', 'x')`)
      .bind(ownerId, `${ownerId}@test.local`),
    env.DB.prepare(`INSERT INTO users (id, email, name, role, password_hash) VALUES (?, ?, 'A', 'accountant', 'x')`)
      .bind(accountantId, `${accountantId}@test.local`),
    env.DB.prepare(`INSERT INTO clients (id, name, created_by) VALUES (?, 'Draft Client', ?)`).bind(client, ownerId),
  ]);
  ownerToken = await issueAccessToken(ownerId, `${ownerId}@test.local`, 'owner', env.JWT_SECRET);
  accountantToken = await issueAccessToken(accountantId, `${accountantId}@test.local`, 'accountant', env.JWT_SECRET);
});

const newDraft = async () => (await call('POST', '/api/v1/invoices', draftBody([
  { description: 'Line', quantity: 1, unit_price: 2000, tax_rate: 0.2 },
]))).body.id as string;

describe('editing a draft invoice', () => {
  it('replaces the lines and totals, and refuses once the invoice has been sent', async () => {
    const created = await call('POST', '/api/v1/invoices', draftBody([
      { description: 'First', quantity: 1, unit_price: 5000, tax_rate: 0 },
      { description: 'Second', quantity: 2, unit_price: 1000, tax_rate: 0.2 },
    ]));
    expect(created.status).toBe(201);
    const id = created.body.id as string;

    const saved = await call('PUT', `/api/v1/invoices/${id}`, draftBody([
      { description: 'Only', quantity: 1, unit_price: 3000, tax_rate: 0 },
    ]));
    expect(saved.status).toBe(200);

    const got = await call('GET', `/api/v1/invoices/${id}`);
    expect(got.body).toMatchObject({ status: 'draft', subtotal: 3000, tax_amount: 0, total: 3000 });
    expect(got.body.items).toEqual([
      expect.objectContaining({ description: 'Only', quantity: 1, unit_price: 3000, amount: 3000 }),
    ]);

    await env.DB.prepare(`UPDATE invoices SET status = 'sent' WHERE id = ?`).bind(id).run();
    const again = await call('PUT', `/api/v1/invoices/${id}`, draftBody([
      { description: 'Too late', quantity: 1, unit_price: 9999, tax_rate: 0 },
    ]));
    expect(again.status).toBe(409);

    const patched = await call('PATCH', `/api/v1/invoices/${id}`, {
      items: [{ description: 'Also too late', quantity: 1, unit_price: 1, tax_rate: 0 }],
    });
    expect(patched.status).toBe(422);

    const after = await call('GET', `/api/v1/invoices/${id}`);
    expect(after.body).toMatchObject({ status: 'sent', total: 3000 });
    expect(after.body.items).toEqual([
      expect.objectContaining({ description: 'Only', amount: 3000 }),
    ]);
  });

  it('changes only the dates or notes, keeping the lines, until it is sent', async () => {
    const id = await newDraft();
    const res = await call('PATCH', `/api/v1/invoices/${id}`, { due_date: '2099-12-31', notes: 'Pay by BACS' });
    expect(res.status).toBe(200);
    const got = await call('GET', `/api/v1/invoices/${id}`);
    expect(got.body).toMatchObject({ due_date: '2099-12-31', notes: 'Pay by BACS', subtotal: 2000, tax_amount: 400, total: 2400 });
    expect(got.body.items).toHaveLength(1);

    await env.DB.prepare(`UPDATE invoices SET status = 'sent' WHERE id = ?`).bind(id).run();
    expect((await call('PATCH', `/api/v1/invoices/${id}`, { notes: 'Changed after sending' })).status).toBe(422);
    expect((await call('GET', `/api/v1/invoices/${id}`)).body.notes).toBe('Pay by BACS');
  });

  it('works out the totals itself, whatever the browser sends', async () => {
    const id = await newDraft();
    await call('PUT', `/api/v1/invoices/${id}`, {
      ...draftBody([{ description: 'Two hours', quantity: 2, unit_price: 4500, tax_rate: 0.2 }]),
      subtotal: 1, tax_amount: 1, total: 1,
    });
    expect((await call('GET', `/api/v1/invoices/${id}`)).body).toMatchObject({ subtotal: 9000, tax_amount: 1800, total: 10_800 });
  });

  it('is for the owner only, and needs a real draft', async () => {
    const id = await newDraft();
    expect((await call('PUT', `/api/v1/invoices/${id}`, draftBody([
      { description: 'Accountant edit', quantity: 1, unit_price: 1, tax_rate: 0 },
    ]), accountantToken)).status).toBe(403);
    expect((await call('PUT', `/api/v1/invoices/${uid()}`, draftBody([
      { description: 'Nobody', quantity: 1, unit_price: 1, tax_rate: 0 },
    ]))).status).toBe(404);
    expect((await call('GET', `/api/v1/invoices/${id}`)).body.items).toEqual([
      expect.objectContaining({ description: 'Line' }),
    ]);
  });

  it('finalises a draft whose notes run over several lines and whose client has non-Latin letters', async () => {
    const other = uid();
    await env.DB.prepare(`INSERT INTO clients (id, name, address, created_by) VALUES (?, 'செங்கோல் Ltd', '1 High St\nLondon', ?)`)
      .bind(other, ownerId).run();
    const created = await call('POST', '/api/v1/invoices', {
      ...draftBody([{ description: 'Design\twork', quantity: 1, unit_price: 5000, tax_rate: 0.2 }]),
      client_id: other,
      notes: 'Thank you.\nPlease pay by BACS.\nRef ₹ and 😀',
    });
    const id = created.body.id as string;
    const res = await call('POST', `/api/v1/invoices/${id}/finalize`);
    expect(res.status).toBe(200);
    expect((await call('GET', `/api/v1/invoices/${id}`)).body).toMatchObject({ status: 'sent', pdf_r2_key: expect.any(String) });
  });
});
