// The audit trail: every change to the books is recorded with who made it, the values before and
// after, in the same batch as the change, and the log can't be edited or deleted afterwards.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import app from '../../src/index';
import { issueAccessToken } from '../../src/middleware/auth';
import { changedFields } from '../../src/middleware/audit';

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
const uid = () => crypto.randomUUID().replace(/-/g, '');
const PDF = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF');
let ownerToken = '';
let accountantToken = '';
let ownerId = '';
let accountantId = '';
let categoryA = { id: '', name: '' };
let categoryB = { id: '', name: '' };
let clientId = '';

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

function upload(path: string, name: string) {
  const form = new FormData();
  form.append('file', new File([PDF], name, { type: 'application/pdf' }));
  return app.fetch(new Request(`http://api.test${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ownerToken}`, 'X-Requested-With': 'XMLHttpRequest' },
    body: form,
  }), env, ctx);
}

type Entry = {
  action: string; resource_type: string; resource_id: string | null; summary: string | null;
  old_values: Record<string, unknown> | null; new_values: Record<string, unknown> | null;
  user_id: string | null; user_name: string | null;
};

const history = async (type: string, id: string) =>
  (await call('GET', `/api/v1/audit/${type}/${id}`)).body as Entry[];

const count = async (type: string, id: string) => (await env.DB.prepare(
  'SELECT COUNT(*) AS n FROM audit_log WHERE resource_type = ? AND resource_id = ?'
).bind(type, id).first<{ n: number }>())!.n;

async function line(amount: number, description = 'AUDIT LINE') {
  const id = uid();
  await env.DB.prepare(
    `INSERT INTO transactions (id, date, description, amount) VALUES (?, '2026-06-01', ?, ?)`
  ).bind(id, description, amount).run();
  return id;
}

const invoice = async (unit_price = 10_000) => (await call('POST', '/api/v1/invoices', {
  client_id: clientId, issue_date: '2026-06-01', due_date: '2099-07-01',
  items: [{ description: 'Work', quantity: 1, unit_price, tax_rate: 0 }],
})).body as { id: string; invoice_number: string };

beforeAll(async () => {
  ownerId = uid();
  accountantId = uid();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (id, email, name, role, password_hash) VALUES (?, ?, 'Olivia Owner', 'owner', 'x')`)
      .bind(ownerId, `${ownerId}@test.local`),
    env.DB.prepare(`INSERT INTO users (id, email, name, role, password_hash) VALUES (?, ?, 'Alex Accountant', 'accountant', 'x')`)
      .bind(accountantId, `${accountantId}@test.local`),
  ]);
  ownerToken = await issueAccessToken(ownerId, `${ownerId}@test.local`, 'owner', env.JWT_SECRET);
  accountantToken = await issueAccessToken(accountantId, `${accountantId}@test.local`, 'accountant', env.JWT_SECRET);
  const { results } = await env.DB.prepare(
    'SELECT id, name FROM expense_categories WHERE default_vat_rate IS NULL ORDER BY name LIMIT 2'
  ).all<{ id: string; name: string }>();
  [categoryA, categoryB] = results as [typeof categoryA, typeof categoryB];
  clientId = (await call('POST', '/api/v1/clients', { name: 'Audit Client Ltd' })).body.id;
});

describe('changedFields', () => {
  it('keeps only the fields that changed, comparing nulls, missing keys and nested values', () => {
    expect(changedFields(
      { a: 1, b: 'x', c: null, d: [1, 2], e: 5 },
      { a: 1, b: 'y', c: undefined, d: [1, 2], f: null, g: 0 },
    )).toEqual({ oldValues: { b: 'x', g: null }, newValues: { b: 'y', g: 0 } });
    expect(changedFields({ a: 1 }, { a: 1 })).toBeNull();
  });
});

describe('the log is append-only', () => {
  it('refuses to edit or delete audit rows', async () => {
    await call('POST', '/api/v1/vendors', { name: 'Tamper Test' });
    const row = await env.DB.prepare('SELECT id FROM audit_log ORDER BY rowid DESC LIMIT 1').first<{ id: string }>();
    await expect(env.DB.prepare(`UPDATE audit_log SET action = 'x' WHERE id = ?`).bind(row!.id).run())
      .rejects.toThrow(/append-only/);
    await expect(env.DB.prepare('DELETE FROM audit_log WHERE id = ?').bind(row!.id).run())
      .rejects.toThrow(/append-only/);
  });
});

describe('bank lines', () => {
  it('records the category and VAT before and after, by name, and who changed them', async () => {
    const id = await line(-2_400);
    await call('PATCH', `/api/v1/transactions/${id}`, { expenseCategoryId: categoryA.id, vatRate: 0.2 });
    await call('PATCH', `/api/v1/transactions/${id}`, { expenseCategoryId: categoryB.id });

    const [first, second] = (await history('transaction', id)).filter(e => e.action === 'transaction.updated');
    expect(first.old_values).toMatchObject({ category: null, vatRate: null });
    expect(first.new_values).toMatchObject({ category: categoryA.name, vatRate: 0.2 });
    expect(second.old_values).toMatchObject({ category: categoryA.name, expenseCategoryId: categoryA.id });
    expect(second.new_values).toMatchObject({ category: categoryB.name, expenseCategoryId: categoryB.id });
    expect(second.new_values).not.toHaveProperty('vatRate');   // unchanged: B has no usual VAT
    expect(second.summary).toBe('Changed category');
    expect(second).toMatchObject({ user_id: ownerId, user_name: 'Olivia Owner' });
  });

  it('writes nothing when an edit changes nothing', async () => {
    const id = await line(-100);
    await call('PATCH', `/api/v1/transactions/${id}`, { notes: 'Lunch' });
    await call('PATCH', `/api/v1/transactions/${id}`, { notes: 'Lunch' });
    expect(await count('transaction', id)).toBe(1);
  });

  it("records the accountant's flag", async () => {
    const id = await line(-100);
    await call('PATCH', `/api/v1/transactions/${id}`, { flagged: true, accountantNotes: 'Receipt?' }, accountantToken);
    const [entry] = await history('transaction', id);
    expect(entry).toMatchObject({
      user_id: accountantId, summary: 'Changed flag, accountant notes',
      old_values: { flagged: false, accountantNotes: null }, new_values: { flagged: true, accountantNotes: 'Receipt?' },
    });
  });

  it('records posting and undoing, with the payments they made and reversed', async () => {
    const inv = await invoice(5_000);
    await call('POST', `/api/v1/invoices/${inv.id}/finalize`);
    const id = await line(5_000);
    const match = await call('POST', '/api/v1/transaction-matches',
      { transactionId: id, type: 'invoice', targetId: inv.id, allocatedAmount: 5_000 });
    expect(match.status).toBe(201);
    expect((await call('POST', `/api/v1/transactions/${id}/post`)).status).toBe(200);
    expect((await call('POST', `/api/v1/transactions/${id}/undo`)).status).toBe(200);

    const actions = (await history('transaction', id)).map(e => e.action);
    expect(actions).toEqual(['transaction.match_added', 'transaction.posted', 'transaction.unposted']);
    const [, posted, undone] = await history('transaction', id);
    expect(posted.new_values).toMatchObject({ posted: true, payments: [{ type: 'invoice', targetId: inv.id, total: 5_000 }] });
    expect(undone.new_values).toMatchObject({ posted: false, reopened: [{ targetId: inv.id, amount: 5_000 }] });
  });

  it('posts several lines with one audit row each', async () => {
    const a = await line(-300);
    const b = await line(-400);
    for (const id of [a, b]) {
      await call('PATCH', `/api/v1/transactions/${id}`, { expenseCategoryId: categoryA.id, vatRate: 0 });
    }
    expect((await call('POST', '/api/v1/transactions/post', { ids: [a, b] })).body.posted).toBe(2);
    for (const id of [a, b]) {
      expect((await history('transaction', id)).at(-1)).toMatchObject({ action: 'transaction.posted', summary: 'Posted' });
    }
  });

  it('records removing a match the owner made, but not turning down a suggestion', async () => {
    const inv = await invoice(700);
    await call('POST', `/api/v1/invoices/${inv.id}/finalize`);
    const id = await line(700);
    const made = (await call('POST', '/api/v1/transaction-matches',
      { transactionId: id, type: 'invoice', targetId: inv.id, allocatedAmount: 700 })).body.id;
    await call('DELETE', `/api/v1/transaction-matches/${made}`);

    const suggestion = uid();
    await env.DB.prepare(`
      INSERT INTO transaction_matches (id, transaction_id, match_type, invoice_id, allocated_amount, status)
      VALUES (?, ?, 'invoice', ?, 700, 'suggested')
    `).bind(suggestion, id, inv.id).run();
    await call('DELETE', `/api/v1/transaction-matches/${suggestion}`);

    const entries = await history('transaction', id);
    expect(entries.map(e => e.action)).toEqual(['transaction.match_added', 'transaction.match_removed']);
    expect(entries[1]).toMatchObject({
      summary: `Removed match to ${inv.invoice_number}`,
      old_values: { targetId: inv.id, allocatedAmount: 700 },
    });
  });

  it('keeps a replaced receipt in storage and records both files', async () => {
    const id = await line(-900);
    expect((await upload(`/api/v1/transactions/${id}/attachments`, 'first.pdf')).status).toBe(200);
    expect((await upload(`/api/v1/transactions/${id}/attachments`, 'second.pdf')).status).toBe(200);

    const [first, second] = await history('transaction', id);
    expect(second).toMatchObject({ summary: 'Replaced receipt with second.pdf', old_values: { file: 'first.pdf' } });
    const oldKey = second.old_values!.key as string;
    expect(oldKey).toBe(first.new_values!.key);
    expect(oldKey).not.toBe(second.new_values!.key);
    expect(await env.R2.get(oldKey)).not.toBeNull();
  });

  it("shows the import and the rule that categorised a line in the line's history", async () => {
    const id = await line(-1_234, 'AUDITRULE SUBSCRIPTION');
    const rule = await call('POST', '/api/v1/categorisation-rules',
      { matchText: 'auditrule', expenseCategoryId: categoryA.id, vatRate: 0.2 });
    expect(rule.body.applied).toBeGreaterThanOrEqual(1);

    const applied = (await history('transaction', id)).find(e => e.action === 'categorisation_rule.applied');
    expect(applied).toMatchObject({
      resource_type: 'categorisation_rule', resource_id: rule.body.id,
      summary: expect.stringMatching(/^Rule "auditrule" categorised \d+ line/),
      new_values: { expenseCategoryId: categoryA.id, vatRate: 0.2 },
    });
  });
});

describe('invoices', () => {
  it('records the life of an invoice, with only what changed in each edit', async () => {
    const inv = await invoice(10_000);
    await call('PATCH', `/api/v1/invoices/${inv.id}`, { notes: 'Thanks', client_id: clientId });
    await call('PUT', `/api/v1/invoices/${inv.id}`, {
      client_id: clientId, issue_date: '2026-06-01', due_date: '2099-07-01', notes: 'Thanks',
      items: [{ description: 'Work', quantity: 2, unit_price: 10_000, tax_rate: 0.2 }],
    });
    await call('POST', `/api/v1/invoices/${inv.id}/finalize`);
    const paid = await call('POST', `/api/v1/invoices/${inv.id}/payments`,
      { amount: 1_000, payment_date: '2026-06-05', method: 'bank_transfer' });
    await call('DELETE', `/api/v1/invoices/${inv.id}/payments/${paid.body.id}`);
    await call('POST', `/api/v1/invoices/${inv.id}/void`);

    const entries = await history('invoice', inv.id);
    expect(entries.map(e => e.action)).toEqual([
      'invoice.created', 'invoice.updated', 'invoice.updated', 'invoice.finalized',
      'payment.created', 'payment.deleted', 'invoice.voided',
    ]);
    const [created, patched, put, finalized, payment, deleted, voided] = entries;
    expect(created).toMatchObject({ summary: `Created draft ${inv.invoice_number}`, new_values: { total: 10_000 } });
    // The PATCH didn't change the client, so it isn't there
    expect(patched).toMatchObject({ old_values: { notes: null }, new_values: { notes: 'Thanks' } });
    expect(Object.keys(put.new_values!).sort()).toEqual(['items', 'subtotal', 'tax_amount', 'total']);
    expect(put).toMatchObject({ old_values: { total: 10_000 }, new_values: { total: 24_000, tax_amount: 4_000 } });
    expect(finalized).toMatchObject({ old_values: { status: 'draft' }, new_values: { status: 'sent', total: 24_000 } });
    expect(payment.new_values).toMatchObject({ paymentId: paid.body.id, amount: 1_000 });
    expect(deleted.old_values).toMatchObject({ paymentId: paid.body.id, amount: 1_000, status: 'partial' });
    expect(voided).toMatchObject({ summary: `Voided ${inv.invoice_number}`, old_values: { status: 'sent' } });
  });

  it('writes no audit row when the change itself is refused', async () => {
    const inv = await invoice(500);
    await call('POST', `/api/v1/invoices/${inv.id}/finalize`);
    const before = await count('invoice', inv.id);

    expect((await call('POST', `/api/v1/invoices/${inv.id}/payments`,
      { amount: 9_999, payment_date: '2026-06-05', method: 'cash' })).status).toBe(409);
    expect((await call('PATCH', `/api/v1/invoices/${inv.id}`, { notes: 'too late' })).status).toBe(422);
    expect((await call('POST', `/api/v1/invoices/${inv.id}/finalize`)).status).toBe(422);
    expect(await count('invoice', inv.id)).toBe(before);
  });

  it('records a payment deleted by two requests at once only once', async () => {
    const inv = await invoice(800);
    await call('POST', `/api/v1/invoices/${inv.id}/finalize`);
    const paid = await call('POST', `/api/v1/invoices/${inv.id}/payments`,
      { amount: 800, payment_date: '2026-06-05', method: 'cash' });
    const results = await Promise.all([1, 2].map(() =>
      call('DELETE', `/api/v1/invoices/${inv.id}/payments/${paid.body.id}`)));
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
    expect((await history('invoice', inv.id)).filter(e => e.action === 'payment.deleted')).toHaveLength(1);
  });
});

describe('bills, clients and vendors', () => {
  it('records bill edits, voiding and payments on the bill', async () => {
    const vendorId = (await call('POST', '/api/v1/vendors', { name: 'Audit Supplies' })).body.id;
    const items = [{ description: 'Paper', quantity: 1, unit_price: 2_000, tax_rate: 0, expense_category_id: categoryA.id }];
    const billId = (await call('POST', '/api/v1/bills', { vendor_id: vendorId, bill_number: 'B-1', items })).body.id;
    await call('PUT', `/api/v1/bills/${billId}`, { vendor_id: vendorId, bill_number: 'B-1A', items });
    await call('DELETE', `/api/v1/bills/${billId}`);

    const [created, edited, voided] = await history('bill', billId);
    expect(created).toMatchObject({ action: 'bill.created', new_values: { bill_number: 'B-1', total: 2_000 } });
    expect(edited).toMatchObject({ action: 'bill.updated', old_values: { bill_number: 'B-1' }, new_values: { bill_number: 'B-1A' } });
    expect(Object.keys(edited.new_values!)).toEqual(['bill_number']);
    expect(voided).toMatchObject({ action: 'bill.voided', summary: 'Voided bill B-1A' });

    const vendor = await history('vendor', vendorId);
    expect(vendor[0]).toMatchObject({ action: 'vendor.created', summary: 'Added Audit Supplies' });
  });

  it('records client edits as client actions, not user ones', async () => {
    const id = (await call('POST', '/api/v1/clients', { name: 'Renamed Ltd', email: 'a@b.co' })).body.id;
    await call('PATCH', `/api/v1/clients/${id}`, { name: 'Renamed Group Ltd' });
    await call('DELETE', `/api/v1/clients/${id}`);
    const entries = await history('client', id);
    expect(entries.map(e => e.action)).toEqual(['client.created', 'client.updated', 'client.deactivated']);
    expect(entries[1]).toMatchObject({ old_values: { name: 'Renamed Ltd' }, new_values: { name: 'Renamed Group Ltd' } });
  });
});

describe('reading the log', () => {
  it('lets the accountant read it, filtered and paged, without sign-in events', async () => {
    const page = await call('GET', `/api/v1/audit?userId=${ownerId}&action=invoice.&pageSize=2`, undefined, accountantToken);
    expect(page.status).toBe(200);
    expect(page.body.rows).toHaveLength(2);
    expect(page.body.total).toBeGreaterThan(2);
    expect(page.body.rows.every((r: Entry) => r.action.startsWith('invoice.') && r.user_id === ownerId)).toBe(true);

    const all = await call('GET', '/api/v1/audit?pageSize=200');
    expect(all.body.rows.some((r: Entry) => r.action.startsWith('auth.'))).toBe(false);

    expect((await call('GET', '/api/v1/audit?from=yesterday')).status).toBe(400);
    expect((await call('GET', '/api/v1/audit/user/x')).status).toBe(400);
  });

  it("doesn't let anyone write to it through the API", async () => {
    expect((await call('POST', '/api/v1/audit', {})).status).toBe(404);
    expect((await call('DELETE', '/api/v1/audit/invoice/x')).status).toBe(404);
  });
});
