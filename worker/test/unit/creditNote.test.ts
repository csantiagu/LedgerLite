import { describe, expect, it } from 'vitest';
import { checkCreditLines, roomByRate } from '../../src/services/creditNote';

const design = { quantity: 1, unit_price: 10_000, tax_rate: 0.2 };
const hosting = { quantity: 1, unit_price: 5_000, tax_rate: 0 };

describe('credit note lines', () => {
  it('keeps each VAT rate to the net and VAT the invoice still has', () => {
    expect(checkCreditLines([design, hosting], [], [design, hosting]).ok).toBe(true);
    const shifted = checkCreditLines(
      [design, hosting], [],
      [{ quantity: 1, unit_price: 15_000, tax_rate: 0.2 }],
    );
    expect(shifted).toEqual({ ok: false, error: expect.stringMatching(/Only £100\.00 net \(£20\.00 VAT\) at 20%/) });
  });

  it('accepts a rate that is not exactly 20%, such as an imported invoice', () => {
    const line = { quantity: 1, unit_price: 10_000, tax_rate: 0.2001 };
    expect(checkCreditLines([line], [], [{ ...line, unit_price: 4_000 }]).ok).toBe(true);
    expect(roomByRate([line], []).get(2001)).toEqual({ net: 10_000, vat: Math.round(10_000 * 0.2001) });
  });

  it('compares the total at each rate, so VAT rounded up on small lines does not refuse a fitting credit', () => {
    const tenPence = { quantity: 1, unit_price: 10, tax_rate: 0.2 };   // 10p + 2p VAT
    const pieces = [3, 3, 4].map(unit_price => ({ quantity: 1, unit_price, tax_rate: 0.2 }));   // VAT 1p + 1p + 1p
    expect(checkCreditLines([tenPence], [], pieces).ok).toBe(true);
    // The net is still capped exactly
    expect(checkCreditLines([tenPence], [], [...pieces, { quantity: 1, unit_price: 1, tax_rate: 0.2 }]).ok).toBe(false);
  });

  it('reduces what is left by credit notes already issued', () => {
    const again = checkCreditLines([design], [design], [{ quantity: 1, unit_price: 1, tax_rate: 0.2 }]);
    expect(again).toEqual({ ok: false, error: expect.stringMatching(/Only £0\.00 net/) });
  });
});
