// Emailing invoices through Resend (037). Finalising never sends anything; Email invoice sends the
// invoice's PDF with the message the owner checked, and each send is recorded. Resend is mocked.
import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../../src/index';
import { issueAccessToken } from '../../src/middleware/auth';
import type { Env } from '../../src/types';

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
const uid = () => crypto.randomUUID().replace(/-/g, '');
let ownerToken = '';
let accountantToken = '';
let clientId = '';

type Res = { status: number; body: any };   // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(method: string, path: string, body?: unknown, token = ownerToken, bindings: Env = env): Promise<Res> {
  const res = await app.fetch(new Request(`http://api.test${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), bindings, ctx);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

type Sent = { url: string; headers: Headers; body: Record<string, any> };   // eslint-disable-line @typescript-eslint/no-explicit-any
let sent: Sent[] = [];
let resendReply: () => Response;

// Only calls to Resend are caught; anything else would be a mistake in the test
beforeEach(() => {
  sent = [];
  resendReply = () => Response.json({ id: `re_${uid()}` });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url !== 'https://api.resend.com/emails') throw new Error(`Unexpected fetch to ${url}`);
    sent.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return resendReply();
  });
});
afterEach(() => { vi.restoreAllMocks(); });

const finalised = async () => {
  const inv = (await call('POST', '/api/v1/invoices', {
    client_id: clientId, issue_date: '2026-11-03', due_date: '2026-12-03',
    items: [{ description: 'Joinery', quantity: 1, unit_price: 100_000, tax_rate: 0.2 }],
  })).body as { id: string };
  expect((await call('POST', `/api/v1/invoices/${inv.id}/finalize`)).status).toBe(200);
  return inv.id;
};
const email = (over: Record<string, unknown> = {}) => ({
  to: 'jane@example.com', subject: 'Your invoice', message: 'Hello Jane,\n\nPlease find it attached.',
  idempotency_key: uid(), ...over,
});

beforeAll(async () => {
  const ownerId = uid();
  const accountantId = uid();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (id, email, name, role, password_hash) VALUES (?, ?, 'Olivia Owner', 'owner', 'x')`)
      .bind(ownerId, `${ownerId}@test.local`),
    env.DB.prepare(`INSERT INTO users (id, email, name, role, password_hash) VALUES (?, ?, 'Alex Accountant', 'accountant', 'x')`)
      .bind(accountantId, `${accountantId}@test.local`),
  ]);
  ownerToken = await issueAccessToken(ownerId, `${ownerId}@test.local`, 'owner', env.JWT_SECRET);
  accountantToken = await issueAccessToken(accountantId, `${accountantId}@test.local`, 'accountant', env.JWT_SECRET);
  clientId = (await call('POST', '/api/v1/clients', {
    name: 'Jane Smith', company_name: 'Smith Joinery Ltd', email: 'jane@example.com',
  })).body.id;
  expect((await call('PATCH', '/api/v1/settings/company', {
    company_name: 'Acme Builders Ltd', email: 'accounts@acme.example',
    email_from_name: 'Acme Builders', email_from_address: 'invoices@acme.example',
  })).status).toBe(200);
});

describe('settings', () => {
  it('save with a blank company email (it clears it)', async () => {
    expect((await call('PATCH', '/api/v1/settings/company', { email: '', email_from_name: 'Acme Builders' })).status).toBe(200);
    expect((await call('GET', '/api/v1/settings/company')).body.email).toBeNull();
    expect((await call('PATCH', '/api/v1/settings/company', { email: 'not an email' })).status).toBe(400);
    expect((await call('PATCH', '/api/v1/settings/company', { email: 'accounts@acme.example' })).status).toBe(200);
  });

  it('say whether Resend is connected (never the key) and give the default template', async () => {
    const s = (await call('GET', '/api/v1/settings/company')).body;
    expect(s.email_configured).toBe(true);
    expect(JSON.stringify(s)).not.toContain('re_test_key');
    expect(s.email_defaults.subject).toBe('{document} {invoice_number} from {company_name}');
    expect(s.email_defaults.placeholders).toContain('due_date');
    expect((await call('GET', '/api/v1/settings/company', undefined, ownerToken, { ...env, RESEND_API_KEY: undefined })).body
      .email_configured).toBe(false);
  });

  it('refuse a From name or subject that could break the email headers', async () => {
    expect((await call('PATCH', '/api/v1/settings/company', { email_from_name: 'A "B" <c>' })).status).toBe(400);
    expect((await call('PATCH', '/api/v1/settings/company', { invoice_email_subject: 'One\nTwo' })).status).toBe(400);
    expect((await call('PATCH', '/api/v1/settings/company', { email_from_address: 'not an email' })).status).toBe(400);
  });
});

describe('finalising', () => {
  it('doesn’t email anything', async () => {
    const id = await finalised();
    expect(sent).toHaveLength(0);
    expect((await call('GET', `/api/v1/invoices/${id}`)).body.emails).toEqual([]);
  });
});

describe('the email form', () => {
  it('starts from the default template, filled in for the invoice', async () => {
    const id = await finalised();
    const { invoice_number } = (await call('GET', `/api/v1/invoices/${id}`)).body;
    const preview = (await call('GET', `/api/v1/invoices/${id}/email`)).body;
    expect(preview).toMatchObject({
      to: 'jane@example.com',
      from: 'Acme Builders <invoices@acme.example>',
      reply_to: 'accounts@acme.example',
      subject: `Invoice ${invoice_number} from Acme Builders Ltd`,
      attachment: `${invoice_number}.pdf`,
      problems: [],
    });
    expect(preview.message).toContain('for £1,200.00, dated 3 November 2026.\nPayment is due by 3 December 2026.\n\nKind regards,');
  });

  it('doesn’t ask for payment on a credit note or a paid invoice', async () => {
    const id = await finalised();
    const cn = (await call('POST', `/api/v1/invoices/${id}/credit-note`, { issue_date: '2026-11-04', reason: 'Work cancelled' })).body as { id: string };
    const forCredit = (await call('GET', `/api/v1/invoices/${cn.id}/email`)).body;
    expect(forCredit.subject).toMatch(/^Credit note /);
    expect(forCredit.message).not.toContain('Payment is due');
    expect(forCredit.message).toMatch(/dated 4 November 2026\.\n\nKind regards,/);

    const paid = await finalised();
    expect((await call('POST', `/api/v1/invoices/${paid}/payments`, {
      amount: 120_000, payment_date: '2026-11-05', method: 'bank_transfer',
    })).status).toBe(201);
    expect((await call('GET', `/api/v1/invoices/${paid}/email`)).body.message).not.toContain('Payment is due');
  });

  it('uses the company’s own template once it has one', async () => {
    await call('PATCH', '/api/v1/settings/company', {
      invoice_email_subject: '{invoice_number} — {client_company}', invoice_email_body: 'Balance: {balance}',
    });
    const id = await finalised();
    const preview = (await call('GET', `/api/v1/invoices/${id}/email`)).body;
    expect(preview.subject).toMatch(/ — Smith Joinery Ltd$/);
    expect(preview.message).toBe('Balance: £1,200.00');
    await call('PATCH', '/api/v1/settings/company', { invoice_email_subject: null, invoice_email_body: null });
  });

  it('says what stops a draft being emailed, and is for the owner only', async () => {
    const draft = (await call('POST', '/api/v1/invoices', {
      client_id: clientId, issue_date: '2026-11-03', due_date: '2026-12-03',
      items: [{ description: 'Work', quantity: 1, unit_price: 100, tax_rate: 0 }],
    })).body as { id: string };
    expect((await call('GET', `/api/v1/invoices/${draft.id}/email`)).body.problems)
      .toEqual([{ code: 'draft', settings: false, message: 'Finalise the invoice before emailing it.' }]);
    const noKey = await call('GET', `/api/v1/invoices/${draft.id}/email`, undefined, ownerToken, { ...env, RESEND_API_KEY: undefined });
    expect(noKey.body.problems.map((p: { code: string; settings: boolean }) => [p.code, p.settings]))
      .toEqual([['no_api_key', true], ['draft', false]]);
    expect((await call('GET', `/api/v1/invoices/${draft.id}/email`, undefined, accountantToken)).status).toBe(403);
    expect((await call('GET', '/api/v1/invoices/nope/email')).status).toBe(404);
  });
});

describe('sending', () => {
  it('sends the PDF with the checked message through Resend, and records it', async () => {
    const id = await finalised();
    const { invoice_number, pdf_r2_key } = (await call('GET', `/api/v1/invoices/${id}`)).body;
    const key = uid();
    const res = await call('POST', `/api/v1/invoices/${id}/email`, email({
      cc: ['boss@example.com'], message: 'Hello <Jane>,\n\nAttached.', idempotency_key: key,
    }));
    expect(res.status).toBe(200);

    expect(sent).toHaveLength(1);
    const [{ headers, body }] = sent;
    expect(headers.get('Authorization')).toBe('Bearer re_test_key');
    expect(headers.get('Idempotency-Key')).toMatch(new RegExp(`^invoice-${id}-${key}-[0-9a-f]{32}$`));
    expect(body).toMatchObject({
      from: 'Acme Builders <invoices@acme.example>', to: ['jane@example.com'], cc: ['boss@example.com'],
      reply_to: 'accounts@acme.example', subject: 'Your invoice', text: 'Hello <Jane>,\n\nAttached.',
    });
    expect(body.html).toContain('Hello &lt;Jane&gt;,');
    const pdf = new Uint8Array(await (await env.R2.get(pdf_r2_key))!.arrayBuffer());
    expect(body.attachments).toHaveLength(1);
    expect(body.attachments[0].filename).toBe(`${invoice_number}.pdf`);
    expect(Uint8Array.from(atob(body.attachments[0].content), ch => ch.charCodeAt(0))).toEqual(pdf);

    const after = (await call('GET', `/api/v1/invoices/${id}`)).body;
    expect(after.status).toBe('sent');
    expect(after.emails).toEqual([expect.objectContaining({
      to_email: 'jane@example.com', cc: 'boss@example.com', subject: 'Your invoice', sent_by_name: 'Olivia Owner',
    })]);
    const audit = (await call('GET', `/api/v1/audit/invoice/${id}`)).body as Array<{ action: string; new_values: unknown }>;
    expect(audit.find(e => e.action === 'invoice.emailed')?.new_values)
      .toEqual({ to: 'jane@example.com', cc: 'boss@example.com', subject: 'Your invoice' });
  });

  it('leaves out CC and Reply-To when there are none', async () => {
    await env.DB.prepare('UPDATE company_settings SET email = NULL WHERE id = 1').run();
    const id = await finalised();
    expect((await call('POST', `/api/v1/invoices/${id}/email`, email())).status).toBe(200);
    expect(sent[0].body).not.toHaveProperty('cc');
    expect(sent[0].body).not.toHaveProperty('reply_to');
    await env.DB.prepare(`UPDATE company_settings SET email = 'accounts@acme.example' WHERE id = 1`).run();
  });

  it('records a repeated send (same Resend id) once, and can be sent again later', async () => {
    const id = await finalised();
    resendReply = () => Response.json({ id: 're_same_message' });
    const form = email();
    expect((await call('POST', `/api/v1/invoices/${id}/email`, form)).status).toBe(200);
    expect((await call('POST', `/api/v1/invoices/${id}/email`, form)).status).toBe(200);
    expect((await call('GET', `/api/v1/invoices/${id}`)).body.emails).toHaveLength(1);
    const audit = (await call('GET', `/api/v1/audit/invoice/${id}`)).body as Array<{ action: string }>;
    expect(audit.filter(e => e.action === 'invoice.emailed')).toHaveLength(1);

    resendReply = () => Response.json({ id: 're_a_reminder' });
    expect((await call('POST', `/api/v1/invoices/${id}/email`, email({ subject: 'Reminder' }))).status).toBe(200);
    expect((await call('GET', `/api/v1/invoices/${id}`)).body.emails.map((e: { subject: string }) => e.subject))
      .toEqual(['Reminder', 'Your invoice']);
  });

  it('sends a retry of the same email with the same key, and an edited one with a new key', async () => {
    const id = await finalised();
    const form = email();
    await call('POST', `/api/v1/invoices/${id}/email`, form);
    await call('POST', `/api/v1/invoices/${id}/email`, form);
    await call('POST', `/api/v1/invoices/${id}/email`, { ...form, to: 'jane.smith@example.com' });
    await call('POST', `/api/v1/invoices/${id}/email`, { ...form, message: 'Edited' });
    const keys = sent.map(m => m.headers.get('Idempotency-Key'));
    expect(keys[0]).toBe(keys[1]);
    expect(new Set(keys).size).toBe(3);
  });

  it('stops after 5 emails of one invoice in a day, and 30 emails in an hour', async () => {
    const id = await finalised();
    for (let i = 0; i < 5; i++) {
      expect((await call('POST', `/api/v1/invoices/${id}/email`, email({ subject: `Send ${i}` }))).status).toBe(200);
    }
    const sixth = await call('POST', `/api/v1/invoices/${id}/email`, email({ subject: 'Send 6' }));
    expect(sixth.status).toBe(429);
    expect(sixth.body.error).toContain('5 times in the last day');
    expect(sent).toHaveLength(5);

    // Older sends don't count; recent ones from any invoice count towards the hour
    await env.DB.prepare(`UPDATE invoice_emails SET sent_at = datetime('now', '-2 days') WHERE invoice_id = ?`).bind(id).run();
    expect((await call('POST', `/api/v1/invoices/${id}/email`, email({ subject: 'Next day' }))).status).toBe(200);
    const other = await finalised();
    const filler = Array.from({ length: 30 }, () => env.DB.prepare(
      `INSERT INTO invoice_emails (id, invoice_id, to_email, subject, resend_id, sent_by)
       SELECT ?, ?, 'x@example.com', 'filler', ?, id FROM users WHERE role = 'owner' LIMIT 1`
    ).bind(uid(), other, `re_${uid()}`));
    await env.DB.batch(filler);
    const busy = await call('POST', `/api/v1/invoices/${id}/email`, email({ subject: 'Busy' }));
    expect(busy.status).toBe(429);
    expect(busy.body.error).toContain('in the last hour');
    await env.DB.prepare(`DELETE FROM invoice_emails WHERE subject = 'filler'`).run();
  });

  it('passes on what Resend says when it refuses, and records nothing', async () => {
    const id = await finalised();
    resendReply = () => Response.json({ statusCode: 403, message: 'The acme.example domain is not verified.' }, { status: 403 });
    const res = await call('POST', `/api/v1/invoices/${id}/email`, email());
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('The email wasn’t sent: The acme.example domain is not verified.');
    expect((await call('GET', `/api/v1/invoices/${id}`)).body.emails).toEqual([]);
  });

  it('refuses drafts, void invoices, no PDF, no From address and no API key, without calling Resend', async () => {
    const draft = (await call('POST', '/api/v1/invoices', {
      client_id: clientId, issue_date: '2026-11-03', due_date: '2026-12-03',
      items: [{ description: 'Work', quantity: 1, unit_price: 100, tax_rate: 0 }],
    })).body as { id: string };
    expect((await call('POST', `/api/v1/invoices/${draft.id}/email`, email())).status).toBe(409);

    const voided = await finalised();
    expect((await call('POST', `/api/v1/invoices/${voided}/void`)).status).toBe(200);
    expect((await call('POST', `/api/v1/invoices/${voided}/email`, email())).body.error).toBe('This invoice is void.');

    const noPdf = await finalised();
    await env.DB.prepare('UPDATE invoices SET pdf_r2_key = NULL WHERE id = ?').bind(noPdf).run();
    expect((await call('POST', `/api/v1/invoices/${noPdf}/email`, email())).body.error).toBe('This invoice has no PDF to attach.');

    const id = await finalised();
    const noKey = await call('POST', `/api/v1/invoices/${id}/email`, email(), ownerToken, { ...env, RESEND_API_KEY: undefined });
    expect(noKey.status).toBe(409);
    expect(noKey.body.error).toContain('RESEND_API_KEY');

    await call('PATCH', '/api/v1/settings/company', { email_from_address: null });
    expect((await call('POST', `/api/v1/invoices/${id}/email`, email())).body.error).toContain('address emails are sent from');
    await call('PATCH', '/api/v1/settings/company', { email_from_address: 'invoices@acme.example' });

    expect(sent).toHaveLength(0);
  });

  it('checks the addresses and subject, and is for the owner only', async () => {
    const id = await finalised();
    expect((await call('POST', `/api/v1/invoices/${id}/email`, email({ to: 'nope' }))).status).toBe(400);
    expect((await call('POST', `/api/v1/invoices/${id}/email`, email({ cc: ['a@b.co', 'bad'] }))).status).toBe(400);
    expect((await call('POST', `/api/v1/invoices/${id}/email`, email({ cc: Array(6).fill('a@b.co') }))).status).toBe(400);
    expect((await call('POST', `/api/v1/invoices/${id}/email`, email({ subject: 'Hi\r\nBcc: x@y.z' }))).status).toBe(400);
    expect((await call('POST', `/api/v1/invoices/${id}/email`, email({ message: '   ' }))).status).toBe(400);
    expect((await call('POST', `/api/v1/invoices/${id}/email`, email(), accountantToken)).status).toBe(403);
    expect(sent).toHaveLength(0);
  });
});
