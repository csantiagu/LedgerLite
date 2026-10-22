import { describe, expect, it } from 'vitest';
import { bankLineVat, boxes } from '../../src/services/vatReturn';

describe('VAT return boxes', () => {
  it('adds sales and purchases into the nine boxes, box 5 being what is owed', () => {
    expect(boxes(
      [{ source: 'Invoices', vat: 20_000, net: 100_000, count: 2 }, { source: 'Credit notes', vat: -2_000, net: -10_000, count: 1 }],
      [{ source: 'Bills', vat: 4_000, net: 20_000, count: 3 }],
    )).toEqual({ box1: 18_000, box2: 0, box3: 18_000, box4: 4_000, box5: 14_000, box6: 90_000, box7: 20_000, box8: 0, box9: 0 });
  });

  it('gives a negative box 5 when more VAT is reclaimed than owed', () => {
    expect(boxes([], [{ source: 'Bills', vat: 500, net: 2_500, count: 1 }]).box5).toBe(-500);
  });
});

describe('bankLineVat', () => {
  it('splits the unmatched part of a line into VAT and net, signed by direction', () => {
    expect(bankLineVat(-12_000, 0, 0.2)).toEqual({ vat: -2_000, net: -10_000 });
    expect(bankLineVat(6_000, 0, 0.2)).toEqual({ vat: 1_000, net: 5_000 });
    // Matched parts are counted from their invoice or bill
    expect(bankLineVat(-12_000, 6_000, 0.2)).toEqual({ vat: -1_000, net: -5_000 });
    expect(bankLineVat(-12_000, 0, null)).toEqual({ vat: 0, net: -12_000 });
  });
});
