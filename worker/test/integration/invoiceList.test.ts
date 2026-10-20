import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import app from '../../src/index';
import { issueAccessToken } from '../../src/middleware/auth';

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
const uid = () => crypto.randomUUID().replace(/-/g, '');
let ownerToken = '';
let ownerId = '';
let acme = '';
let zeta = '';

type Row = { id: string; invoice_number: string; status: string; client_name: string; total: number };
type Paged = { rows: Row[]; total: number; page: number; pageSize: number; counts: Record<string, number> };

async function list(query: string) {
  const res = await app.fetch(new Request(`http://api.test/api/v1/invoices?${query}`, {
    headers: { Authorization: `Bearer ${ownerToken}`, 'X-Requested-With': 'XMLHttpRequest' },
  }), env, ctx);
  return res.json() as Promise<Paged>;
}

async function invoice(client: string, number: string, status: string, issue: string, total: number) {
  await env.DB.prepare(`
    INSERT INTO invoices (id, client_id, invoice_number, status, issue_date, due_date, subtotal, total, created_by)
    VALUES (?, ?, ?, ?, ?, '2099-01-01', ?, ?, ?)
  `).bind(uid(), client, number, status, issue, total, total, ownerId).run();
}

beforeAll(async () => {
  ownerId = uid();
  acme = uid();
  zeta = uid();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (id, email, name, role, password_hash) VALUES (?, ?, 'O', 'owner', 'x')`)
      .bind(ownerId, `${ownerId}@test.local`),
    env.DB.prepare(`INSERT INTO clients (id, name, created_by) VALUES (?, 'Acme Listing Ltd', ?)`).bind(acme, ownerId),
    env.DB.prepare(`INSERT INTO clients (id, name, created_by) VALUES (?, 'Zeta Listing Ltd', ?)`).bind(zeta, ownerId),
  ]);
  ownerToken = await issueAccessToken(ownerId, `${ownerId}@test.local`, 'owner', env.JWT_SECRET);
  await invoice(acme, 'LST-0001', 'paid',  '2024-01-10', 10_000);
  await invoice(acme, 'LST-0002', 'sent',  '2024-02-10', 25_000);
  await invoice(zeta, 'LST-0003', 'draft', '2023-12-01', 5_000);    // oldest date, but a draft
  await invoice(zeta, 'LST-0004', 'void',  '2024-03-10', 7_500);
  await invoice(zeta, 'LST-0005', 'partial', '2024-04-10', 12_000);
});

// Only this file's invoices: every test narrows to the LST numbers
const ours = 'q=LST-&page=1';

describe('invoice list', () => {
  it('puts drafts first, then the newest, a page at a time', async () => {
    const first = await list(`${ours}&pageSize=2`);
    expect(first.total).toBe(5);
    expect(first.rows.map(r => r.invoice_number)).toEqual(['LST-0003', 'LST-0005']);
    const second = await list(`q=LST-&page=2&pageSize=2`);
    expect(second.rows.map(r => r.invoice_number)).toEqual(['LST-0004', 'LST-0002']);
  });

  it('filters by status or the unpaid group, counting every status', async () => {
    const unpaid = await list(`${ours}&status=unpaid`);
    expect(unpaid.rows.map(r => r.invoice_number).sort()).toEqual(['LST-0002', 'LST-0005']);
    expect(unpaid.counts).toMatchObject({ all: 5, unpaid: 2, draft: 1, paid: 1, void: 1 });
    expect((await list(`${ours}&status=draft`)).rows.map(r => r.invoice_number)).toEqual(['LST-0003']);
    expect((await list(`${ours}&status=nonsense`)).total).toBe(0);
  });

  it('filters by client, dates and amount', async () => {
    expect((await list(`${ours}&client_id=${acme}`)).total).toBe(2);
    expect((await list(`${ours}&from=2024-02-01&to=2024-03-31`)).rows.map(r => r.invoice_number).sort())
      .toEqual(['LST-0002', 'LST-0004']);
    expect((await list('q=250&page=1')).rows.map(r => r.invoice_number)).toContain('LST-0002');
    expect((await list('q=Zeta Listing&page=1')).total).toBe(3);
  });

  it('sorts by a chosen column, ignoring unknown ones', async () => {
    const byTotal = await list(`${ours}&sort=total&dir=asc`);
    expect(byTotal.rows.map(r => r.total)).toEqual([5_000, 7_500, 10_000, 12_000, 25_000]);
    const byClient = await list(`${ours}&sort=client&dir=desc`);
    expect(byClient.rows[0].client_name).toBe('Zeta Listing Ltd');
    const unknown = await list(`${ours}&sort=1;DROP TABLE invoices`);
    expect(unknown.rows[0].invoice_number).toBe('LST-0003');
  });

  it('still answers a plain array without page', async () => {
    const res = await app.fetch(new Request('http://api.test/api/v1/invoices?q=LST-', {
      headers: { Authorization: `Bearer ${ownerToken}`, 'X-Requested-With': 'XMLHttpRequest' },
    }), env, ctx);
    const rows = await res.json() as Row[];
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(5);
  });
});
