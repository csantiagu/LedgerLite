import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BODY, DEFAULT_SUBJECT, emailVars, fillTemplate, fromHeader, longDate, textToHtml, toBase64,
} from '../../src/services/invoiceEmail';
import { formatGbp } from '../../src/services/money';

const invoice = {
  invoice_number: 'INV-2026-0042', kind: 'invoice', issue_date: '2026-11-03', due_date: '2026-12-03',
  total: 123456, amount_paid: 23456, client_name: 'Jane Smith', client_company: 'Smith Joinery Ltd',
};

describe('formatGbp and longDate', () => {
  it('formats pence as pounds with thousands commas', () => {
    expect(formatGbp(123456)).toBe('£1,234.56');
    expect(formatGbp(5)).toBe('£0.05');
    expect(formatGbp(100_000_000)).toBe('£1,000,000.00');
  });

  it('writes dates out in full, without slipping a day', () => {
    expect(longDate('2026-11-03')).toBe('3 November 2026');
    expect(longDate('2027-01-01')).toBe('1 January 2027');
  });
});

describe('the template', () => {
  it('fills the default subject and message', () => {
    const vars = emailVars(invoice, 'Acme Builders Ltd');
    expect(fillTemplate(DEFAULT_SUBJECT, vars)).toBe('Invoice INV-2026-0042 from Acme Builders Ltd');
    const body = fillTemplate(DEFAULT_BODY, vars);
    expect(body).toContain('Dear Jane Smith,');
    expect(body).toContain('invoice INV-2026-0042 for £1,234.56, dated 3 November 2026.');
    expect(body).toContain('dated 3 November 2026.\nPayment is due by 3 December 2026.\n\nKind regards,');
    expect(body).not.toMatch(/\{\w+\}/);
  });

  it('knows the balance, the client’s company and credit notes', () => {
    const vars = emailVars({ ...invoice, kind: 'credit_note' }, null);
    expect(fillTemplate('{document}/{document_lower} {balance} {client_company} {company_name}', vars))
      .toBe('Credit note/credit note £1,000.00 Smith Joinery Ltd us');
    expect(emailVars({ ...invoice, client_company: null }, 'X').client_company).toBe('');
  });

  it('asks for payment only when an invoice has something left to pay, leaving no gap otherwise', () => {
    const credit = fillTemplate(DEFAULT_BODY, emailVars({ ...invoice, kind: 'credit_note' }, 'X'));
    expect(credit).not.toContain('Payment');
    expect(credit).toContain('dated 3 November 2026.\n\nKind regards,');
    expect(fillTemplate(DEFAULT_BODY, emailVars({ ...invoice, amount_paid: invoice.total }, 'X'))).not.toContain('Payment');
    expect(fillTemplate(DEFAULT_BODY, emailVars({ ...invoice, amount_paid: invoice.total - 1 }, 'X'))).toContain('Payment is due');
  });

  it('leaves braces it doesn’t know as typed', () => {
    expect(fillTemplate('Ref {po_number} {invoice_number} {constructor}', emailVars(invoice, 'X')))
      .toBe('Ref {po_number} INV-2026-0042 {constructor}');
  });
});

describe('textToHtml', () => {
  it('escapes what was typed and keeps paragraphs and line breaks', () => {
    const html = textToHtml('Hi <b>Jane</b> & co,\r\n\r\nLine one\nLine "two"');
    expect(html).toContain('<p style="margin:0 0 1em">Hi &lt;b&gt;Jane&lt;/b&gt; &amp; co,</p>');
    expect(html).toContain('Line one<br>Line &quot;two&quot;');
    expect(html).not.toContain('<b>');
  });
});

describe('fromHeader', () => {
  it('puts the name before the address, without characters that would break the header', () => {
    expect(fromHeader('Acme Builders', 'invoices@acme.co.uk')).toBe('Acme Builders <invoices@acme.co.uk>');
    expect(fromHeader('Evil "<x@y.z>"\r\nBcc: a@b.c', 'invoices@acme.co.uk')).toBe('Evil x@y.zBcc: a@b.c <invoices@acme.co.uk>');
    expect(fromHeader(null, 'invoices@acme.co.uk')).toBe('invoices@acme.co.uk');
    expect(fromHeader('  ', 'invoices@acme.co.uk')).toBe('invoices@acme.co.uk');
  });
});

describe('toBase64', () => {
  it('matches the standard encoding, including files bigger than one chunk', () => {
    expect(toBase64(new TextEncoder().encode('%PDF-1.7'))).toBe('JVBERi0xLjc=');
    const big = new Uint8Array(100_000).map((_, i) => i % 256);
    expect(atob(toBase64(big)).length).toBe(100_000);
    expect(atob(toBase64(big)).charCodeAt(99_999)).toBe(99_999 % 256);
  });
});
