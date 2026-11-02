// Clients: the optional company name (036) next to the required name, and the details an
// invoice's Bill to takes from them.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import app from '../../src/index';
import { issueAccessToken } from '../../src/middleware/auth';

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
const uid = () => crypto.randomUUID().replace(/-/g, '');
let ownerToken = '';
let accountantToken = '';

type Res = { status: number; body: any };   // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(method: string, path: string, body?: unknown, token = ownerToken): Promise<Res> {
  const res = await app.fetch(new Request(`http://api.test${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env, ctx);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

const client = async (body: Record<string, unknown>) => {
  const res = await call('POST', '/api/v1/clients', body);
  expect(res.status).toBe(201);
  return res.body.id as string;
};
const get = async (id: string) => (await call('GET', `/api/v1/clients/${id}`)).body;

beforeAll(async () => {
  const ownerId = uid();
  const accountantId = uid();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (id, email, name, role, password_hash) VALUES (?, ?, 'Owner', 'owner', 'x')`)
      .bind(ownerId, `${ownerId}@test.local`),
    env.DB.prepare(`INSERT INTO users (id, email, name, role, password_hash) VALUES (?, ?, 'Accountant', 'accountant', 'x')`)
      .bind(accountantId, `${accountantId}@test.local`),
  ]);
  ownerToken = await issueAccessToken(ownerId, `${ownerId}@test.local`, 'owner', env.JWT_SECRET);
  accountantToken = await issueAccessToken(accountantId, `${accountantId}@test.local`, 'accountant', env.JWT_SECRET);
});

describe('company name', () => {
  it('is optional: a client with only a name has none', async () => {
    const id = await client({ name: 'Sole Trader' });
    expect(await get(id)).toMatchObject({ name: 'Sole Trader', company_name: null, address: null });
  });

  it('is saved with the address and returned in the client list', async () => {
    const id = await client({ name: 'Priya Shah', company_name: 'Shah Design Ltd', address: '4 Park Row\nLeeds\nLS1 5HD' });
    expect(await get(id)).toMatchObject({ company_name: 'Shah Design Ltd', address: '4 Park Row\nLeeds\nLS1 5HD' });
    const list = (await call('GET', '/api/v1/clients')).body as Array<{ id: string; company_name: string | null }>;
    expect(list.find(c => c.id === id)?.company_name).toBe('Shah Design Ltd');
  });

  it('can be set with PATCH and cleared with PUT', async () => {
    const id = await client({ name: 'Tom Reed' });
    expect((await call('PATCH', `/api/v1/clients/${id}`, { company_name: 'Reed & Co' })).status).toBe(200);
    expect((await get(id)).company_name).toBe('Reed & Co');
    expect((await call('PUT', `/api/v1/clients/${id}`, { name: 'Tom Reed', company_name: null })).status).toBe(200);
    expect((await get(id)).company_name).toBeNull();
  });

  it('refuses more than 200 characters', async () => {
    const res = await call('POST', '/api/v1/clients', { name: 'Long', company_name: 'x'.repeat(201) });
    expect(res.status).toBe(400);
    expect((await call('POST', '/api/v1/clients', { name: 'Long', company_name: 'x'.repeat(200) })).status).toBe(201);
  });

  it('can only be changed by the owner', async () => {
    const id = await client({ name: 'Owner Only' });
    expect((await call('POST', '/api/v1/clients', { name: 'Nope', company_name: 'X' }, accountantToken)).status).toBe(403);
    expect((await call('PATCH', `/api/v1/clients/${id}`, { company_name: 'X' }, accountantToken)).status).toBe(403);
    expect((await get(id)).company_name).toBeNull();
  });
});

describe('Bill to on invoices', () => {
  it('returns the client’s company and address with the invoice, and finalises with them on the PDF', async () => {
    const clientId = await client({ name: 'Jane Smith', company_name: 'Smith Joinery Ltd', address: '12 Mill Lane\nLeeds' });
    const inv = (await call('POST', '/api/v1/invoices', {
      client_id: clientId, issue_date: '2026-06-01', due_date: '2099-07-01',
      items: [{ description: 'Joinery', quantity: 1, unit_price: 10_000, tax_rate: 0.2 }],
    })).body as { id: string };
    expect((await call('GET', `/api/v1/invoices/${inv.id}`)).body).toMatchObject({
      client_name: 'Jane Smith', client_company: 'Smith Joinery Ltd', client_address: '12 Mill Lane\nLeeds',
    });

    expect((await call('POST', `/api/v1/invoices/${inv.id}/finalize`)).status).toBe(200);
    const after = (await call('GET', `/api/v1/invoices/${inv.id}`)).body as { status: string; pdf_r2_key: string | null };
    expect(after.status).toBe('sent');
    expect(after.pdf_r2_key).toBeTruthy();
  });

  it('shows no company for a client without one', async () => {
    const clientId = await client({ name: 'No Company' });
    const inv = (await call('POST', '/api/v1/invoices', {
      client_id: clientId, issue_date: '2026-06-01', due_date: '2099-07-01',
      items: [{ description: 'Work', quantity: 1, unit_price: 5_000, tax_rate: 0 }],
    })).body as { id: string };
    expect((await call('GET', `/api/v1/invoices/${inv.id}`)).body.client_company).toBeNull();
  });

  it('finds the client’s invoices by searching for the company', async () => {
    const clientId = await client({ name: 'Ola Bergstrom', company_name: 'Fjordline Searchable Ltd' });
    const inv = (await call('POST', '/api/v1/invoices', {
      client_id: clientId, issue_date: '2026-06-01', due_date: '2099-07-01',
      items: [{ description: 'Work', quantity: 1, unit_price: 7_000, tax_rate: 0 }],
    })).body as { id: string };
    const found = (await call('GET', '/api/v1/invoices?q=fjordline&page=1')).body as { rows: Array<{ id: string }> };
    expect(found.rows.map(r => r.id)).toEqual([inv.id]);
    const byName = (await call('GET', '/api/v1/invoices?q=Bergstrom&page=1')).body as { rows: Array<{ id: string }> };
    expect(byName.rows.map(r => r.id)).toEqual([inv.id]);
  });
});
