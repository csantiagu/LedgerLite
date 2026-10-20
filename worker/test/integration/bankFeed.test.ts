// End to end through the API: a bank CSV import lands in For Review, rules and suggestions
// pre-fill lines, posting puts them in the books (P&L), undo takes them out again.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import app from '../../src/index';
import { issueAccessToken } from '../../src/middleware/auth';

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
const uid = () => crypto.randomUUID().replace(/-/g, '');
let ownerToken = '';
let accountantToken = '';
let ownerId = '';
let account = '';
let invoiceId = '';
let officeSupplies = '';

const tag = uid().slice(0, 6).toUpperCase(); // keeps this file's descriptions and numbers unique
const invoiceNumber = `INV-2026-${String(Number.parseInt(tag, 16) % 9000 + 1000)}`;
const CSV = [
  'Date,Description,Amount,Balance',
  `03/04/2026,OFFICEWORLD ${tag} PAPER,-45.00,955.00`,
  `05/04/2026,ACME ${tag} ${invoiceNumber},120.00,1075.00`,
  `07/04/2026,MYSTERY ${tag},-10.00,1065.00`,
].join('\n');

type Json = Record<string, unknown> & { rows?: Array<Record<string, unknown>> };

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

async function importCsv(csv: string) {
  const form = new FormData();
  form.append('bankAccountId', account);
  form.append('file', new File([csv], 'statement.csv', { type: 'text/csv' }));
  const res = await app.fetch(new Request('http://api.test/api/v1/bank-imports', {
    method: 'POST',
    headers: { Authorization: `Bearer ${ownerToken}`, 'X-Requested-With': 'XMLHttpRequest' },
    body: form,
  }), env, ctx);
  return { status: res.status, body: await res.json() as Json };
}

const reviewRows = async () =>
  (await call('GET', `/api/v1/transactions?bankAccountId=${account}&reviewed=0&page=1`)).body.rows!;
const byText = (rows: Array<Record<string, unknown>>, text: string) =>
  rows.find(r => String(r.description).startsWith(text))!;
const pl = async () => (await call('GET', '/api/v1/reports/pl?from=2026-04-01&to=2026-04-30')).body as {
  expenses: Array<{ category: string; total: number }>; totalIncome: number;
};
const officeSpend = async () => (await pl()).expenses.find(e => e.category === 'Office Supplies')?.total ?? 0;

beforeAll(async () => {
  ownerId = uid();
  const accountantId = uid();
  const client = uid();
  account = uid();
  invoiceId = uid();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (id, email, name, role, password_hash) VALUES (?, ?, 'O', 'owner', 'x')`)
      .bind(ownerId, `${ownerId}@test.local`),
    env.DB.prepare(`INSERT INTO users (id, email, name, role, password_hash) VALUES (?, ?, 'A', 'accountant', 'x')`)
      .bind(accountantId, `${accountantId}@test.local`),
    env.DB.prepare(`INSERT INTO bank_accounts (id, name, bank_name, csv_format, created_by) VALUES (?, 'Feed', 'Monzo', 'monzo', ?)`)
      .bind(account, ownerId),
    env.DB.prepare(`INSERT INTO clients (id, name, created_by) VALUES (?, 'Acme Feed Ltd', ?)`).bind(client, ownerId),
    env.DB.prepare(`
      INSERT INTO invoices (id, client_id, invoice_number, status, issue_date, due_date, subtotal, total, created_by)
      VALUES (?, ?, ?, 'sent', '2026-04-01', '2099-04-30', 12000, 12000, ?)
    `).bind(invoiceId, client, invoiceNumber, ownerId),
  ]);
  officeSupplies = (await env.DB.prepare(`SELECT id FROM expense_categories WHERE name = 'Office Supplies'`)
    .first<{ id: string }>())!.id;
  ownerToken = await issueAccessToken(ownerId, `${ownerId}@test.local`, 'owner', env.JWT_SECRET);
  accountantToken = await issueAccessToken(accountantId, `${accountantId}@test.local`, 'accountant', env.JWT_SECRET);

  const rule = await call('POST', '/api/v1/categorisation-rules', {
    matchText: `OFFICEWORLD ${tag}`, direction: 'out', expenseCategoryId: officeSupplies, vatRate: 0.2,
  });
  expect(rule.status).toBe(201);
});

describe('bank feed: import → review → post → books', () => {
  it('imports every line into For Review, with rules and suggestions pre-filled', async () => {
    const res = await importCsv(CSV);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ newRowCount: 3, suggested: 1, categorised: 1 });

    expect((await call('GET', '/api/v1/transactions/review-counts')).body[account]).toBe(3);
    const rows = await reviewRows();
    expect(byText(rows, 'OFFICEWORLD')).toMatchObject({ expense_category_id: officeSupplies, is_reconciled: 0 });
    expect(byText(rows, 'OFFICEWORLD').categorised_by_rule_id).toBeTruthy();
    expect(byText(rows, 'ACME')).toMatchObject({ match_status: 'suggested', match_target_id: invoiceId, match_allocated: 12000 });
    expect(byText(rows, 'MYSTERY')).toMatchObject({ expense_category_id: null, match_status: null });
  });

  it('keeps lines out of the P&L until they are posted', async () => {
    expect(await officeSpend()).toBe(0);
  });

  it('posts a rule-categorised line, and the expense reaches the P&L', async () => {
    const office = byText(await reviewRows(), 'OFFICEWORLD');
    const res = await call('POST', '/api/v1/transactions/post', { ids: [office.id] });
    expect(res.body).toMatchObject({ posted: 1, failed: [] });
    expect(await officeSpend()).toBe(3750);   // £45 less 20% VAT included
  });

  it('accepts the suggested invoice and posts it as a payment', async () => {
    const acme = byText(await reviewRows(), 'ACME');
    // Accepting promotes the suggestion to a pending match
    expect((await call('POST', '/api/v1/transaction-matches', {
      transactionId: acme.id, type: 'invoice', targetId: invoiceId, allocatedAmount: 12000,
    })).body).toMatchObject({ promoted: true });
    expect((await call('POST', `/api/v1/transactions/${acme.id}/post`)).status).toBe(200);

    const inv = await env.DB.prepare('SELECT status, amount_paid FROM invoices WHERE id = ?').bind(invoiceId)
      .first<{ status: string; amount_paid: number }>();
    expect(inv).toEqual({ status: 'paid', amount_paid: 12000 });
    expect((await pl()).totalIncome).toBe(12000);
  });

  it('will not post a line nobody has explained', async () => {
    const mystery = byText(await reviewRows(), 'MYSTERY');
    expect((await call('POST', `/api/v1/transactions/${mystery.id}/post`)).status).toBe(422);
    expect((await call('GET', '/api/v1/transactions/review-counts')).body[account]).toBe(1);
  });

  it('lists posted lines under All Transactions, filterable, with details', async () => {
    const posted = await call('GET', `/api/v1/transactions?bankAccountId=${account}&reviewed=1&page=1`);
    expect(posted.body.total).toBe(2);
    const incoming = await call('GET', `/api/v1/transactions?bankAccountId=${account}&reviewed=1&direction=in&page=1`);
    expect(incoming.body.rows!.map(r => r.description)).toEqual([expect.stringContaining('ACME')]);
    const matched = await call('GET', `/api/v1/transactions?bankAccountId=${account}&category=matched&page=1`);
    expect(matched.body.total).toBe(1);

    const acme = incoming.body.rows![0];
    const detail = await call('GET', `/api/v1/transactions/${acme.id}`);
    expect(detail.body).toMatchObject({ is_reconciled: 1, reviewed_by_name: 'O', account_name: 'Feed' });
  });

  it('undo takes the payment and the expense back out of the books', async () => {
    const posted = (await call('GET', `/api/v1/transactions?bankAccountId=${account}&reviewed=1&page=1`)).body.rows!;
    for (const row of posted) {
      expect((await call('POST', `/api/v1/transactions/${row.id}/undo`)).status).toBe(200);
    }
    expect(await officeSpend()).toBe(0);
    expect((await pl()).totalIncome).toBe(0);
    const inv = await env.DB.prepare('SELECT status, amount_paid FROM invoices WHERE id = ?').bind(invoiceId)
      .first<{ status: string; amount_paid: number }>();
    expect(inv).toEqual({ status: 'sent', amount_paid: 0 });

    // Back in review with what they had: the rule's category, and the invoice match ready to post
    const rows = await reviewRows();
    expect(rows).toHaveLength(3);
    expect(byText(rows, 'OFFICEWORLD').expense_category_id).toBe(officeSupplies);
    expect(byText(rows, 'ACME')).toMatchObject({ match_status: 'pending', expense_category_id: null });
  });

  it('does not import the same statement twice', async () => {
    const res = await importCsv(CSV);
    expect(res.body).toMatchObject({ newRowCount: 0 });
    expect((await call('GET', '/api/v1/transactions/review-counts')).body[account]).toBe(3);
  });

  it('lets the accountant read and flag, but not post or undo', async () => {
    const rows = (await call('GET', `/api/v1/transactions?bankAccountId=${account}&reviewed=0&page=1`, undefined, accountantToken)).body.rows!;
    expect(rows).toHaveLength(3);
    const office = byText(rows, 'OFFICEWORLD');
    expect((await call('GET', `/api/v1/transactions/${office.id}`, undefined, accountantToken)).status).toBe(200);
    expect((await call('PATCH', `/api/v1/transactions/${office.id}`, { flagged: true, accountantNotes: 'Receipt?' }, accountantToken)).status).toBe(200);
    expect((await call('POST', `/api/v1/transactions/${office.id}/post`, undefined, accountantToken)).status).toBe(403);
    expect((await call('POST', '/api/v1/transactions/post', { ids: [office.id] }, accountantToken)).status).toBe(403);
    // An accountant's category change is ignored: only flag and notes are theirs
    await call('PATCH', `/api/v1/transactions/${office.id}`, { expenseCategoryId: null }, accountantToken);
    const after = await env.DB.prepare('SELECT expense_category_id, flagged, accountant_notes FROM transactions WHERE id = ?')
      .bind(office.id).first();
    expect(after).toEqual({ expense_category_id: officeSupplies, flagged: 1, accountant_notes: 'Receipt?' });
  });
});
