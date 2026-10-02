import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import app from '../../src/index';
import { issueAccessToken } from '../../src/middleware/auth';
import { cleanFilename, sniffType } from '../../src/services/files';

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
const uid = () => crypto.randomUUID().replace(/-/g, '');
let token = '';
let txnId = '';
let ownerId = '';

const PDF  = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF');
const PNG  = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const HTML = new TextEncoder().encode('<html><script>alert(1)</script></html>');
const SVG  = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

function upload(path: string, bytes: Uint8Array, name: string, type: string) {
  const form = new FormData();
  form.append('file', new File([bytes], name, { type }));
  return app.fetch(new Request(`http://api.test${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' },
    body: form,
  }), env, ctx);
}
const get = (path: string) => app.fetch(new Request(`http://api.test${path}`, {
  headers: { Authorization: `Bearer ${token}` },
}), env, ctx);

beforeAll(async () => {
  ownerId = uid();
  await env.DB.prepare(`INSERT INTO users (id, email, name, role, password_hash) VALUES (?, ?, 'O', 'owner', 'x')`)
    .bind(ownerId, `${ownerId}@test.local`).run();
  token = await issueAccessToken(ownerId, `${ownerId}@test.local`, 'owner', env.JWT_SECRET);
  const account = uid();
  txnId = uid();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO bank_accounts (id, name, bank_name, csv_format, created_by) VALUES (?, 'A', 'B', 'monzo', ?)`).bind(account, ownerId),
    env.DB.prepare(`INSERT INTO transactions (id, bank_account_id, date, description, amount) VALUES (?, ?, '2026-05-01', 'x', -100)`).bind(txnId, account),
  ]);
});

describe('sniffType', () => {
  it('recognises files by content, not by name', () => {
    expect(sniffType(PDF)).toBe('application/pdf');
    expect(sniffType(PNG)).toBe('image/png');
    expect(sniffType(HTML)).toBeNull();
    expect(sniffType(SVG)).toBeNull();
  });
});

describe('cleanFilename', () => {
  it('removes quotes, slashes and control characters', () => {
    expect(cleanFilename('a"b/c\\d\r\ne.pdf')).toBe('abcde.pdf');
    expect(cleanFilename('   ')).toBe('file');
  });
});

describe('attachments', () => {
  it('rejects an HTML file that claims to be a PDF', async () => {
    const res = await upload(`/api/v1/transactions/${txnId}/attachments`, HTML, 'receipt.pdf', 'application/pdf');
    expect(res.status).toBe(400);
  });

  it('stores a real PDF and serves it as a sandboxed download', async () => {
    expect((await upload(`/api/v1/transactions/${txnId}/attachments`, PDF, 'Receipt May.pdf', 'application/octet-stream')).status).toBe(200);
    const res = await get(`/api/v1/transactions/${txnId}/attachments`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Security-Policy')).toBe("default-src 'none'; sandbox");
    expect(res.headers.get('Content-Disposition')).toMatch(/^attachment; filename="Receipt May.pdf"/);
  });

  it('serves anything stored with an unexpected type as a plain download', async () => {
    const key = `transactions/${txnId}/legacy.html`;
    await env.R2.put(key, HTML, { httpMetadata: { contentType: 'text/html' } });
    await env.DB.prepare('UPDATE transactions SET attachment_r2_key = ?, attachment_filename = ? WHERE id = ?')
      .bind(key, 'legacy.html', txnId).run();
    const res = await get(`/api/v1/transactions/${txnId}/attachments`);
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
  });

  it('checks bill attachments too', async () => {
    const vendor = uid();
    const bill = uid();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO vendors (id, name, created_by) VALUES (?, 'V', ?)`).bind(vendor, ownerId),
      env.DB.prepare(`INSERT INTO bills (id, vendor_id, status, issue_date, subtotal, total, created_by) VALUES (?, ?, 'pending', '2026-05-01', 1, 1, ?)`).bind(bill, vendor, ownerId),
    ]);
    expect((await upload(`/api/v1/bills/${bill}/attachments`, HTML, 'bill.pdf', 'application/pdf')).status).toBe(400);
    expect((await upload(`/api/v1/bills/${bill}/attachments`, PDF, 'bill.pdf', 'application/pdf')).status).toBe(201);
  });
});

describe('company logo', () => {
  it('rejects SVG', async () => {
    expect((await upload('/api/v1/settings/company/logo', SVG, 'logo.svg', 'image/svg+xml')).status).toBe(400);
  });

  it('accepts PNG', async () => {
    expect((await upload('/api/v1/settings/company/logo', PNG, 'logo.png', 'image/png')).status).toBe(200);
  });
});
