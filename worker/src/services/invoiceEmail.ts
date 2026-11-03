// Emailing an invoice through Resend (https://resend.com/docs/api-reference/emails/send-email).
// The owner edits the subject and message before each send; the template in company settings is
// only where the form starts.
import { balanceDue, formatGbp } from './money';

export const DEFAULT_SUBJECT = '{document} {invoice_number} from {company_name}';
export const DEFAULT_BODY = [
  'Dear {client_name},',
  '',
  'Please find attached {document_lower} {invoice_number} for {total}, dated {issue_date}.',
  '{payment_due}',
  '',
  'Kind regards,',
  '{company_name}',
].join('\n');

/** The placeholders a template may use, with what each becomes */
export const PLACEHOLDERS = [
  'client_name', 'client_company', 'company_name', 'document', 'document_lower', 'invoice_number',
  'total', 'balance', 'issue_date', 'due_date', 'payment_due',
] as const;
type Vars = Record<(typeof PLACEHOLDERS)[number], string>;

/** "2026-11-03" → "3 November 2026" */
export function longDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

export type EmailInvoice = {
  invoice_number: string; kind: string; issue_date: string; due_date: string;
  total: number; amount_paid: number; client_name: string; client_company: string | null;
};

export function emailVars(invoice: EmailInvoice, companyName: string | null): Vars {
  const document = invoice.kind === 'credit_note' ? 'Credit note' : 'Invoice';
  return {
    client_name: invoice.client_name,
    client_company: invoice.client_company ?? '',
    company_name: companyName?.trim() || 'us',
    document,
    document_lower: document.toLowerCase(),
    invoice_number: invoice.invoice_number,
    total: formatGbp(invoice.total),
    balance: formatGbp(balanceDue(invoice.total, invoice.amount_paid)),
    issue_date: longDate(invoice.issue_date),
    due_date: longDate(invoice.due_date),
    // Only an invoice with something left to pay asks for payment (not a credit note or a paid invoice)
    payment_due: invoice.kind !== 'credit_note' && balanceDue(invoice.total, invoice.amount_paid) > 0
      ? `Payment is due by ${longDate(invoice.due_date)}.` : '',
  };
}

/**
 * Swaps each {placeholder} for its value; anything else in braces is left as typed. A placeholder
 * that comes out empty on a line of its own ({payment_due} on a credit note) leaves no gap.
 */
export function fillTemplate(template: string, vars: Vars): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.hasOwn(vars, key) ? vars[key as keyof Vars] : match)
    .replace(/\n{3,}/g, '\n\n');
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, ch =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

/** The plain-text message as simple HTML: escaped, paragraphs on blank lines, line breaks kept */
export function textToHtml(text: string): string {
  const paragraphs = text.replace(/\r\n/g, '\n').split(/\n{2,}/)
    .map(p => `<p style="margin:0 0 1em">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`);
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1e293b">${paragraphs.join('')}</div>`;
}

/** `Name <address>`, or the bare address. Quotes and angle brackets are dropped from the name. */
export function fromHeader(name: string | null, address: string): string {
  const clean = name?.replace(/["<>\r\n]/g, '').trim();
  return clean ? `${clean} <${address}>` : address;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export type ResendEmail = {
  from: string; to: string[]; cc?: string[]; reply_to?: string;
  subject: string; text: string; html: string;
  attachments: Array<{ filename: string; content: string }>;
};

export class ResendError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/**
 * Sends one email and returns Resend's id. The idempotency key makes a repeated request (a double
 * click, a retry after a timeout) send the email once.
 */
export async function sendWithResend(apiKey: string, email: ResendEmail, idempotencyKey: string): Promise<string> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(email),
  });
  const body = await res.json().catch(() => null) as { id?: string; message?: string } | null;
  if (!res.ok || !body?.id) {
    throw new ResendError(res.status, body?.message ?? `Resend answered ${res.status}`);
  }
  return body.id;
}
