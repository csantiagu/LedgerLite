import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { generateInvoicePdf, makePdfText, wrapText } from '../../src/services/pdfGenerator';

const base = {
  invoice_number: 'T-1', issue_date: '2026-10-20', due_date: '2026-11-19', client_name: 'Client',
  items: [{ description: 'Work', quantity: 1, unit_price: 100, tax_rate: 0.2 }], subtotal: 100, tax_amount: 20, total: 120,
};

describe('makePdfText', () => {
  it('keeps what the built-in font can draw and replaces the rest', async () => {
    const doc = await PDFDocument.create();
    const t = makePdfText(await doc.embedFont(StandardFonts.Helvetica));
    expect(t('It’s “done” — £12.50 €3')).toBe('It’s “done” — £12.50 €3');
    expect(t('Paid ₹500')).toBe('Paid Rs 500');
    expect(t('Work\tdone')).toBe('Work done');
    expect(t('Hi 😀')).toBe('Hi ?');
    expect(t('செங்')).toBe('????');
    expect(t('a\r\nb')).toBe('a b');
    expect(t('a\r\nb\nc', true)).toBe('a\nb\nc');
    expect(t(null)).toBe('');
  });
});

describe('generateInvoicePdf', () => {
  it.each([
    ['a note typed over several lines', { notes: 'Thanks\nPlease pay by BACS\n\nRef 12' }],
    ['a tab in a line description', { items: [{ description: 'Work\tdone', quantity: 1, unit_price: 100, tax_rate: 0.2 }] }],
    ['a client name in Tamil', { client_name: 'செங்கோல்ராஜ்' }],
    ['an emoji and a rupee sign', { client_name: 'Client 😀', notes: 'Paid ₹500' }],
    ['a company and no address', { client_company: 'Acme Ltd' }],
    ['a company of only spaces', { client_company: '   ', client_address: '1 High St' }],
    ['a company in Tamil', { client_company: 'செங்கோல் நிறுவனம்' }],
    ['a very long name, company and address', {
      client_name: 'Jane Smith-Worthington-Fairbanks of the Very Long Name Department',
      client_company: 'The Very Long Name Holdings International Limited Trading As Smith Joinery '.repeat(3),
      client_address: `${'Unit 4b, Off The Old Industrial Estate Behind The Station, '.repeat(4)}\nLeeds\nLS1 4AB`,
    }],
    ['a company with no spaces at all', { client_company: 'X'.repeat(200) }],
    ['a company and a long address', { client_company: 'Acme Ltd', client_address: '1 High St\n\nFlat 2\nLeeds\nLS1 1AA\nUK' }],
  ])('draws an invoice with %s', async (_name, over) => {
    const bytes = await generateInvoicePdf({ ...base, ...over }, { company_name: 'Co', address: 'Line 1\nLine 2' });
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
  });
});

describe('wrapText', () => {
  it('keeps every line within the width, breaking a word too long for one line', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const text = `Ref ${'ABCDEFGHIJ'.repeat(12)} then some ordinary words to wrap`;
    const lines = wrapText(text, font, 9, 200);
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines) expect(font.widthOfTextAtSize(line, 9)).toBeLessThanOrEqual(200);
    expect(lines.join('').replace(/ /g, '')).toBe(text.replace(/ /g, ''));
  });

  it('leaves text that fits on one line', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    expect(wrapText('Smith Joinery Ltd', font, 10, 300)).toEqual(['Smith Joinery Ltd']);
  });
});
