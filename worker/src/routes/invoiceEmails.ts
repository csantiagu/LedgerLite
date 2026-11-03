// Emailing a finalised invoice to the client. Finalising doesn't send anything: some invoices are
// only kept, so emailing is its own step, and each email sent is recorded (invoice_emails, 037).
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { requireRole } from '../middleware/rbac';
import { actorOf, auditStatement } from '../middleware/audit';
import {
  DEFAULT_BODY, DEFAULT_SUBJECT, emailVars, fillTemplate, fromHeader, ResendError, sendWithResend,
  textToHtml, toBase64,
} from '../services/invoiceEmail';
import type { D1Database } from '@cloudflare/workers-types';
import type { Env } from '../types';

const router = new Hono<{ Bindings: Env }>();

type Row = {
  id: string; invoice_number: string; kind: string; status: string; issue_date: string; due_date: string;
  total: number; amount_paid: number; pdf_r2_key: string | null;
  client_name: string; client_company: string | null; client_email: string | null;
};
type Settings = {
  company_name: string | null; email: string | null; email_from_name: string | null; email_from_address: string | null;
  invoice_email_subject: string | null; invoice_email_body: string | null;
};

async function load(env: Env, id: string) {
  const [invoice, settings] = await Promise.all([
    env.DB.prepare(
      `SELECT i.id, i.invoice_number, i.kind, i.status, i.issue_date, i.due_date, i.total, i.amount_paid, i.pdf_r2_key,
              c.name AS client_name, c.company_name AS client_company, c.email AS client_email
       FROM invoices i JOIN clients c ON c.id = i.client_id WHERE i.id = ?`
    ).bind(id).first<Row>(),
    env.DB.prepare(
      `SELECT company_name, email, email_from_name, email_from_address, invoice_email_subject, invoice_email_body
       FROM company_settings WHERE id = 1`
    ).first<Settings>(),
  ]);
  return { invoice, settings };
}

// What stops an invoice being emailed. `settings` problems are fixed on Settings → Company.
export type EmailProblem = { code: 'no_api_key' | 'no_from_address' | 'draft' | 'void' | 'no_pdf'; settings: boolean; message: string };

/** Why this invoice can't be emailed right now (empty when it can) */
function problems(env: Env, invoice: Row, settings: Settings | null): EmailProblem[] {
  const list: EmailProblem[] = [];
  if (!env.RESEND_API_KEY) list.push({ code: 'no_api_key', settings: true, message: 'Email isn’t set up: the RESEND_API_KEY secret is missing.' });
  if (!settings?.email_from_address) list.push({ code: 'no_from_address', settings: true, message: 'Add the address emails are sent from in Settings → Company.' });
  if (invoice.status === 'draft') list.push({ code: 'draft', settings: false, message: 'Finalise the invoice before emailing it.' });
  if (invoice.status === 'void') list.push({ code: 'void', settings: false, message: 'This invoice is void.' });
  if (invoice.status !== 'draft' && !invoice.pdf_r2_key) list.push({ code: 'no_pdf', settings: false, message: 'This invoice has no PDF to attach.' });
  return list;
}

// Limits on sending, so a script or a leaked API key can't send a flood from the company's address
export const SEND_LIMITS = { perInvoicePerDay: 5, perHour: 30 };

async function overLimit(db: D1Database, invoiceId: string): Promise<string | null> {
  const [perInvoice, perHour] = await db.batch<{ n: number }>([
    db.prepare(`SELECT COUNT(*) AS n FROM invoice_emails WHERE invoice_id = ? AND sent_at > datetime('now', '-1 day')`).bind(invoiceId),
    db.prepare(`SELECT COUNT(*) AS n FROM invoice_emails WHERE sent_at > datetime('now', '-1 hour')`),
  ]);
  if (perInvoice.results[0].n >= SEND_LIMITS.perInvoicePerDay) {
    return `This invoice has been emailed ${SEND_LIMITS.perInvoicePerDay} times in the last day. Try again tomorrow.`;
  }
  if (perHour.results[0].n >= SEND_LIMITS.perHour) {
    return `${SEND_LIMITS.perHour} emails have been sent in the last hour. Try again later.`;
  }
  return null;
}

/** Hex SHA-256 of the email as it will be sent: a retry of the same email gets the same key, an edited one a new key */
async function contentHash(parts: unknown[]): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(parts)));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

// GET /api/v1/invoices/:id/email — the email as the template fills it in, and anything stopping it
router.get('/:id/email', requireRole('owner'), async (c) => {
  const { invoice, settings } = await load(c.env, c.req.param('id') ?? '');
  if (!invoice) return c.json({ error: 'Not found' }, 404);
  const vars = emailVars(invoice, settings?.company_name ?? null);
  return c.json({
    to: invoice.client_email ?? '',
    from: settings?.email_from_address ? fromHeader(settings.email_from_name, settings.email_from_address) : null,
    reply_to: settings?.email ?? null,
    subject: fillTemplate(settings?.invoice_email_subject || DEFAULT_SUBJECT, vars),
    message: fillTemplate(settings?.invoice_email_body || DEFAULT_BODY, vars),
    attachment: `${invoice.invoice_number}.pdf`,
    problems: problems(c.env, invoice, settings),
  });
});

const oneLine = (s: string) => !/[\r\n]/.test(s);
const EmailSchema = z.object({
  to:      z.string().trim().email('Enter a valid email address').max(200),
  cc:      z.array(z.string().trim().email('Enter valid CC addresses').max(200)).max(5).optional(),
  subject: z.string().trim().min(1, 'Subject required').max(200).refine(oneLine, 'Keep the subject to one line'),
  message: z.string().trim().min(1, 'Message required').max(10_000),
  // Made by the form each time it opens. With the email's content it makes Resend's idempotency key:
  // sending the same form twice sends one email, and an edited retry is a new email
  idempotency_key: z.string().min(8).max(100),
});

// POST /api/v1/invoices/:id/email — sends the email with the invoice's PDF attached
router.post('/:id/email', requireRole('owner'), zValidator('json', EmailSchema), async (c) => {
  const id = c.req.param('id');
  const data = c.req.valid('json');
  const { invoice, settings } = await load(c.env, id);
  if (!invoice) return c.json({ error: 'Not found' }, 404);
  const blocked = problems(c.env, invoice, settings);
  if (blocked.length) return c.json({ error: blocked.map(p => p.message).join(' ') }, 409);
  const limited = await overLimit(c.env.DB, id);
  if (limited) return c.json({ error: limited }, 429);

  const pdf = await c.env.R2.get(invoice.pdf_r2_key!);
  if (!pdf) return c.json({ error: 'The invoice’s PDF is missing from storage' }, 409);

  let resendId: string;
  try {
    resendId = await sendWithResend(c.env.RESEND_API_KEY!, {
      from: fromHeader(settings!.email_from_name, settings!.email_from_address!),
      to: [data.to],
      ...(data.cc?.length ? { cc: data.cc } : {}),
      ...(settings!.email ? { reply_to: settings!.email } : {}),
      subject: data.subject,
      text: data.message,
      html: textToHtml(data.message),
      attachments: [{ filename: `${invoice.invoice_number}.pdf`, content: toBase64(new Uint8Array(await pdf.arrayBuffer())) }],
    }, `invoice-${id}-${data.idempotency_key}-${await contentHash([data.to, data.cc ?? [], data.subject, data.message])}`);
  } catch (err) {
    if (err instanceof ResendError) {
      // Resend's own message says what to fix (an unverified domain, a bad address); its status isn't ours
      return c.json({ error: `The email wasn’t sent: ${err.message}` }, 502);
    }
    throw err;
  }

  const actor = actorOf(c);
  const cc = data.cc?.length ? data.cc.join(', ') : null;
  // The audit row goes first so its check sees the table before this send is added
  const firstTime = { sql: 'NOT EXISTS (SELECT 1 FROM invoice_emails WHERE resend_id = ?)', binds: [resendId] };
  await c.env.DB.batch([
    auditStatement(c.env.DB, actor, {
      action: 'invoice.emailed', resourceType: 'invoice', resourceId: id,
      newValues: { to: data.to, cc, subject: data.subject },
      summary: `Emailed ${invoice.invoice_number} to ${data.to}`,
    }, firstTime),
    c.env.DB.prepare(
      `INSERT OR IGNORE INTO invoice_emails (id, invoice_id, to_email, cc, subject, resend_id, sent_by) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(crypto.randomUUID().replace(/-/g, ''), id, data.to, cc, data.subject, resendId, c.get('user').id),
  ]);

  return c.json({ ok: true, resend_id: resendId });
});

export default router;
