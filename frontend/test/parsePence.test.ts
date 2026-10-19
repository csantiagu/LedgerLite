import { describe, expect, it } from 'vitest';
import { parsePence } from '@/lib/quickbooksImport';

// Used by the bank balance check as well as the QuickBooks import: money typed or exported as text
describe('parsePence', () => {
  it.each([
    ['830.53', 83053], ['£1,234.50', 123450], ['1234.5', 123450], ['12', 1200], ['0.05', 5],
    ['(12.00)', -1200], ['-45', -4500], ['1234.4999999999', 123450], ['GBP 10', 1000],
  ])('%s → %i', (text, pence) => {
    expect(parsePence(text)).toBe(pence);
  });

  it('is null when empty and NaN when not money', () => {
    expect(parsePence('')).toBeNull();
    expect(parsePence('-')).toBeNull();
    expect(parsePence('abc')).toBeNaN();
  });
});
