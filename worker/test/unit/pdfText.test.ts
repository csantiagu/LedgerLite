import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { generateInvoicePdf, makePdfText } from '../../src/services/pdfGenerator';

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
  ])('draws an invoice with %s', async (_name, over) => {
    const bytes = await generateInvoicePdf({ ...base, ...over }, { company_name: 'Co', address: 'Line 1\nLine 2' });
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
  });
});
