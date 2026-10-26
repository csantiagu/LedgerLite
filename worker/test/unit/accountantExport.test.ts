import { describe, expect, it } from 'vitest';
import { bankLineFigures, type LineMatch } from '../../src/services/accountantExport';

const pay = (allocated_amount: number, overpayment = 0): LineMatch => ({
  allocated_amount, subtotal: 770_000, total: 770_000, overpayment,
});

describe('bankLineFigures', () => {
  it('keeps a supplier refund due out of the net of the payment', () => {
    const figures = bankLineFigures(80_000, [pay(70_000), pay(10_000, 1)], {
      category: 'Insurance', vat_only: 0, vat_rate: 0,
    });
    expect(figures.held).toBe(10_000);
    expect(figures.vat).toBe(0);
    expect(80_000 - figures.vat! - figures.held).toBe(70_000);
  });

  it('keeps the refund coming back out of income', () => {
    const figures = bankLineFigures(10_000, [pay(10_000, 1)], {
      category: null, vat_only: null, vat_rate: null,
    });
    expect(figures).toMatchObject({ label: 'Supplier refund', vat: 0, held: 10_000 });
    expect(10_000 - figures.vat! - figures.held).toBe(0);
  });

  it('still takes VAT from a bill payment', () => {
    const figures = bankLineFigures(120_000, [{
      allocated_amount: 120_000, subtotal: 100_000, total: 120_000, overpayment: 0,
    }], { category: 'Insurance', vat_only: 0, vat_rate: 0 });
    expect(figures.vat).toBe(20_000);
    expect(figures.held).toBe(0);
  });
});
