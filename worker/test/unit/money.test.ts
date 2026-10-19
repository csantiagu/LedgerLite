import { describe, expect, it } from 'vitest';
import { calculateTotals, parsePenceText, penceToDecimal } from '../../src/services/money';

describe('penceToDecimal', () => {
  it.each([
    [0, '0.00'], [5, '0.05'], [1250, '12.50'], [-5, '-0.05'], [-123456, '-1234.56'], [100000000, '1000000.00'],
  ])('%i → %s', (pence, text) => {
    expect(penceToDecimal(pence)).toBe(text);
  });
});

describe('calculateTotals', () => {
  it('rounds each line and its VAT to whole pence', () => {
    expect(calculateTotals([
      { quantity: 3, unit_price: 333, tax_rate: 0.2 },    // 999 + 200
      { quantity: 1.5, unit_price: 1001, tax_rate: 0.2 }, // 1502 + 300
      { quantity: 1, unit_price: 500, tax_rate: 0 },
    ])).toEqual({ subtotal: 3001, tax_amount: 500, total: 3501 });
  });
});

describe('parsePenceText', () => {
  it.each([
    ['12', 1200], ['12.5', 1250], ['12.50', 1250], ['0.05', 5], ['£1,250.99', 125099], ['1,000,000', 100000000],
    ['-12', -1200], [' 33.95 ', 3395], ['-£0.01', -1],
  ])('%s → %i', (text, pence) => {
    expect(parsePenceText(text)).toBe(pence);
  });

  it.each(['', 'abc', '12.345', '1,23', '12.', '.5', '£', '1 000', 'INV-2026'])('rejects %j', (text) => {
    expect(parsePenceText(text)).toBeNull();
  });
});
