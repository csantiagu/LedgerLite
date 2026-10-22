import { describe, expect, it } from 'vitest';
import { creditLinesFrom, creditPayload, vatCreditDefault } from '@/lib/creditNote';

const invoiceLines = [
  { description: 'Design', quantity: 2, unit_price: 25_000, tax_rate: 0.2 },
  { description: 'Hosting', quantity: 1, unit_price: 1_050, tax_rate: 0 },
];

describe('credit notes from invoice lines', () => {
  it('starts from every line of the invoice, prices in pounds', () => {
    expect(creditLinesFrom(invoiceLines)).toEqual([
      { description: 'Design', quantity: '2', unit_price: '250.00', tax_rate: 0.2, include: true },
      { description: 'Hosting', quantity: '1', unit_price: '10.50', tax_rate: 0, include: true },
    ]);
  });

  it('totals the ticked lines as the server does, in pence', () => {
    const lines = creditLinesFrom(invoiceLines);
    lines[0]!.quantity = '1';
    lines[1]!.include = false;
    expect(creditPayload(lines)).toEqual({
      items: [{ description: 'Design', quantity: 1, unit_price: 25_000, tax_rate: 0.2 }],
      subtotal: 25_000, vat: 5_000, total: 30_000, error: null,
    });
  });

  it('offers the unpaid VAT on a VAT-only invoice, which is the part the customer will not pay', () => {
    expect(vatCreditDefault(20_000, 8_000, 0)).toBe(12_000);
    expect(vatCreditDefault(20_000, 20_000, 0)).toBe(20_000);
    expect(vatCreditDefault(20_000, 8_000, 15_000)).toBe(5_000);
  });

  it('says what is wrong', () => {
    const lines = creditLinesFrom(invoiceLines);
    expect(creditPayload(lines.map(l => ({ ...l, include: false }))).error).toBe('Tick at least one line to credit');
    expect(creditPayload([{ ...lines[0]!, unit_price: 'abc' }]).error).toMatch(/enter a price in pounds/);
    expect(creditPayload([{ ...lines[0]!, quantity: '0' }]).error).toMatch(/quantity must be more than 0/);
  });
});
