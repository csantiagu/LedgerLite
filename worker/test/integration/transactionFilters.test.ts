import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import app from '../../src/index';
import { issueAccessToken } from '../../src/middleware/auth';

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
const uid = () => crypto.randomUUID().replace(/-/g, '');
let token = '';
let account = '';
const ids = {
  paymentNoReceipt: uid(), paymentWithReceipt: uid(), income: uid(),
  matchedBillWithPdf: uid(), matchedBillNoPdf: uid(),
};

const list = async (query: string) => {
  const res = await app.fetch(new Request(`http://api.test/api/v1/transactions?${query}`, {
    headers: { Authorization: `Bearer ${token}` },
  }), env, ctx);
  expect(res.status).toBe(200);
  return ((await res.json()) as Array<{ id: string }>).map(t => t.id).sort();
};

beforeAll(async () => {
  const ownerId = uid();
  await env.DB.prepare(`INSERT INTO users (id, email, name, role, password_hash) VALUES (?, ?, 'O', 'owner', 'x')`)
    .bind(ownerId, `${ownerId}@test.local`).run();
  token = await issueAccessToken(ownerId, `${ownerId}@test.local`, 'owner', env.JWT_SECRET);
  account = uid();
  const vendor = uid(), billWithPdf = uid(), billNoPdf = uid();
  const bill = `INSERT INTO bills (id, vendor_id, total, attachment_r2_key, created_by) VALUES (?, ?, 1000, ?, ?)`;
  const match = `INSERT INTO transaction_matches (transaction_id, match_type, bill_id, allocated_amount, status) VALUES (?, 'bill', ?, 1000, 'posted')`;
  const txn = `INSERT INTO transactions (id, bank_account_id, date, description, amount, attachment_r2_key) VALUES (?, ?, ?, ?, ?, ?)`;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO bank_accounts (id, name, bank_name, csv_format, created_by) VALUES (?, 'A', 'B', 'monzo', ?)`).bind(account, ownerId),
    env.DB.prepare(txn).bind(ids.paymentNoReceipt, account, '2026-05-01', 'Supplier A', -1200, null),
    env.DB.prepare(txn).bind(ids.paymentWithReceipt, account, '2026-05-02', 'Supplier B', -3400, 'transactions/x/attachment.pdf'),
    env.DB.prepare(txn).bind(ids.income, account, '2026-05-03', 'Customer', 5000, null),
    env.DB.prepare(`INSERT INTO vendors (id, name, created_by) VALUES (?, 'V', ?)`).bind(vendor, ownerId),
    env.DB.prepare(bill).bind(billWithPdf, vendor, 'bills/x/attachment.pdf', ownerId),
    env.DB.prepare(bill).bind(billNoPdf, vendor, null, ownerId),
    env.DB.prepare(txn).bind(ids.matchedBillWithPdf, account, '2026-05-04', 'Supplier C', -1000, null),
    env.DB.prepare(txn).bind(ids.matchedBillNoPdf, account, '2026-05-05', 'Supplier D', -1000, null),
    env.DB.prepare(match).bind(ids.matchedBillWithPdf, billWithPdf),
    env.DB.prepare(match).bind(ids.matchedBillNoPdf, billNoPdf),
  ]);
});

describe('GET /api/v1/transactions?noReceipt=1', () => {
  it('lists payments out with nothing attached, directly or through a matched bill', async () => {
    expect(await list(`bankAccountId=${account}&noReceipt=1`))
      .toEqual([ids.paymentNoReceipt, ids.matchedBillNoPdf].sort());
  });

  it('combines with the date filter', async () => {
    expect(await list(`bankAccountId=${account}&noReceipt=1&from=2026-05-02`)).toEqual([ids.matchedBillNoPdf]);
  });

  it('lists everything without the filter', async () => {
    expect(await list(`bankAccountId=${account}`)).toEqual(Object.values(ids).sort());
  });
});
