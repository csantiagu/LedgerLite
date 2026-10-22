import { describe, expect, it } from 'vitest';
import {
  bankLineProblem, closestAmountAction, formTotals, grossFromNet, guessVendor, heldBillMessage, initialVendorId,
  linesMissingCategory, mismatchNote, netForGross, unmatchedAmount, type BankLine,
} from '@/lib/billFromBank';

describe('netForGross', () => {
  it.each([
    [12000, 0.2, 10000], [1000, 0, 1000], [105, 0.05, 100], [999, 0.2, 833], [1, 0.2, 1],
  ])('%i at %d → net %i', (gross, rate, net) => {
    expect(netForGross(gross, rate)).toBe(net);
  });

  it('adds no VAT at a zero rate', () => {
    expect(grossFromNet(500, 0)).toBe(500);
  });

  it('adds back up to the gross, or one penny over, at the rates the form offers', () => {
    expect(grossFromNet(netForGross(999, 0.2), 0.2)).toBe(1000);
    for (const rate of [0.05, 0.2]) {
      for (let gross = 1; gross < 5000; gross++) {
        const over = grossFromNet(netForGross(gross, rate), rate) - gross;
        expect(over).toBeGreaterThanOrEqual(0);
        expect(over).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('guessVendor', () => {
  const vendors = [{ id: 'a', name: 'BT' }, { id: 'b', name: 'Screwfix' }, { id: 'c', name: 'Screwfix Direct' }];

  it('picks the longest name found in the bank text', () => {
    expect(guessVendor(vendors, 'CARD PAYMENT TO SCREWFIX DIRECT LTD')?.id).toBe('c');
    expect(guessVendor(vendors, 'screwfix 1234')?.id).toBe('b');
  });

  it('keeps a longer name found earlier', () => {
    expect(guessVendor([...vendors].reverse(), 'SCREWFIX DIRECT')?.id).toBe('c');
  });

  it('ignores names shorter than 3 letters and no match', () => {
    expect(guessVendor(vendors, 'BT GROUP PLC')).toBeNull();
    expect(guessVendor(vendors, 'TESCO')).toBeNull();
  });
});

const bankLine = (over: Partial<BankLine> = {}): BankLine => ({
  id: 't', date: '2026-05-01', description: 'CARD PAYMENT SCREWFIX', reference: null, amount: -1_000,
  is_reconciled: 0, account_name: 'Main', matches: [], ...over,
});

describe('unmatchedAmount', () => {
  it('takes off pending and posted matches, not suggestions', () => {
    expect(unmatchedAmount(bankLine())).toBe(1_000);
    expect(unmatchedAmount(bankLine({
      matches: [
        { status: 'pending', allocated_amount: 300 },
        { status: 'posted', allocated_amount: 200 },
        { status: 'suggested', allocated_amount: 400 },
      ],
    }))).toBe(500);
  });
});

describe('bankLineProblem', () => {
  it('allows an open money-out line with something left to match', () => {
    expect(bankLineProblem(bankLine({ matches: [{ status: 'pending', allocated_amount: 999 }] }))).toBeNull();
  });

  it.each([
    ['missing', undefined, /not found/],
    ['money in', bankLine({ amount: 1_000 }), /money going out/],
    ['zero', bankLine({ amount: 0 }), /money going out/],
    ['posted', bankLine({ is_reconciled: 1 }), /already posted/],
    ['fully matched', bankLine({ matches: [{ status: 'pending', allocated_amount: 1_000 }] }), /fully matched/],
  ])('refuses a line that is %s', (_, line, message) => {
    expect(bankLineProblem(line)).toMatch(message);
  });
});

describe('initialVendorId', () => {
  const vendors = [{ id: 'a', name: 'Screwfix' }, { id: 'b', name: 'Wickes' }];

  it('prefers an active vendor from the link', () => {
    expect(initialVendorId(vendors, 'b', bankLine())).toBe('b');
  });

  it('otherwise guesses from the bank description and reference', () => {
    expect(initialVendorId(vendors, 'gone', bankLine())).toBe('a');
    expect(initialVendorId(vendors, null, bankLine({ description: 'CARD 1234', reference: 'WICKES' }))).toBe('b');
  });

  it('is empty when nothing matches or there is no bank line', () => {
    expect(initialVendorId(vendors, null, bankLine({ description: 'TESCO' }))).toBe('');
    expect(initialVendorId(vendors, null, null)).toBe('');
  });
});

describe('formTotals', () => {
  it('rounds each line to pence and its VAT as the server does', () => {
    expect(formTotals([
      { quantity: 3, unit_price: 0.333, tax_rate: 0.2 },
      { quantity: 1, unit_price: 10, tax_rate: 0 },
    ])).toEqual({ subtotal: 1_099, vat: 20 });
  });

  it('adds a VAT-only line as just its VAT', () => {
    expect(formTotals([
      { quantity: 1, unit_price: 0, tax_rate: 0.2, vat_amount: '1300.00' },
      { quantity: 1, unit_price: 0, tax_rate: 0.2, vat_amount: 148.5 },
    ])).toEqual({ subtotal: 0, vat: 144_850 });
    // An empty VAT box is not a VAT-only line
    expect(formTotals([{ quantity: 1, unit_price: 10, tax_rate: 0.2, vat_amount: '' }])).toEqual({ subtotal: 1_000, vat: 200 });
  });

  it('treats blank or unparsed inputs as zero', () => {
    expect(formTotals([{ quantity: NaN, unit_price: 5, tax_rate: NaN }])).toEqual({ subtotal: 0, vat: 0 });
    expect(formTotals([{ quantity: 2, unit_price: NaN, tax_rate: 0.2 }])).toEqual({ subtotal: 0, vat: 0 });
    // Inputs arrive as strings before the schema coerces them
    expect(formTotals([{ quantity: '2', unit_price: '1.50', tax_rate: '0.20' } as never])).toEqual({ subtotal: 300, vat: 60 });
  });
});

describe('linesMissingCategory', () => {
  it('lists the lines with no category', () => {
    expect(linesMissingCategory([{ expense_category_id: 'c' }, {}, { expense_category_id: '' }])).toEqual([1, 2]);
    expect(linesMissingCategory([{ expense_category_id: 'c' }])).toEqual([]);
  });
});

describe('mismatchNote', () => {
  it('says nothing when the bill matches the bank payment', () => {
    expect(mismatchNote(1_000, 1_000)).toBeNull();
  });

  it('explains a bill over or under the bank payment', () => {
    expect(mismatchNote(1_500, 1_000)).toBe('The bill is more than the bank payment: £10.00 will be matched and the rest stays owed.');
    expect(mismatchNote(400, 1_000)).toBe('The bill is less than the bank payment: £6.00 of the payment is left to match or categorise.');
  });
});

describe('closestAmountAction', () => {
  it('offers the bank amount when the rate can reach it', () => {
    expect(closestAmountAction(1_000, 1_000)).toEqual({ label: 'Match the bank amount', note: null });
  });

  it('offers the closest amount, and says it is a penny over, when it cannot', () => {
    expect(closestAmountAction(1_000, 999)).toEqual({
      label: 'Use the closest amount',
      note: "This rate can't land on the bank payment exactly. The closest bill is £0.01 more, and that penny stays owed.",
    });
  });
});

describe('heldBillMessage', () => {
  it('moves on when everything worked', () => {
    expect(heldBillMessage({ fromBank: true, attachmentFailed: false, matchError: null })).toBeNull();
    expect(heldBillMessage({ fromBank: false, attachmentFailed: false, matchError: null })).toBeNull();
  });

  it('stays when the supplier invoice did not upload', () => {
    expect(heldBillMessage({ fromBank: false, attachmentFailed: true, matchError: null }))
      .toBe('Bill saved, but the supplier invoice did not upload. Add it from the bill.');
    expect(heldBillMessage({ fromBank: true, attachmentFailed: true, matchError: null }))
      .toBe('Bill saved and matched to the bank payment, but the supplier invoice did not upload. Add it from the bill.');
  });

  it('stays with the server reason when the match failed', () => {
    expect(heldBillMessage({ fromBank: true, attachmentFailed: false, matchError: 'Allocation too big.' }))
      .toBe("Bill saved, but it couldn't be matched to the bank payment: Allocation too big. Match it from the Bank page with Find match.");
    expect(heldBillMessage({ fromBank: true, attachmentFailed: true, matchError: 'Allocation too big.' }))
      .toBe("Bill saved, but the supplier invoice did not upload and it couldn't be matched to the bank payment: Allocation too big. Match it from the Bank page with Find match.");
  });
});
