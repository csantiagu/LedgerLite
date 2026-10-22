import { describe, expect, it } from 'vitest';
import { attachmentRequired, canEditBill, canVoidBill, vendorTotals } from '@/lib/bills';

describe('attachmentRequired', () => {
  const categories = [
    { id: 'ps', name: ' Professional Services ' },
    { id: 'sub', name: 'Sub-contract' },
    { id: 'office', name: 'Office Supplies' },
  ];

  it('is needed when any chosen category asks for the supplier invoice', () => {
    expect(attachmentRequired(categories, ['office', 'ps'])).toBe(true);
    expect(attachmentRequired(categories, [undefined, 'sub'])).toBe(true);
  });

  it('is not needed for other or no categories', () => {
    expect(attachmentRequired(categories, ['office', ''])).toBe(false);
    expect(attachmentRequired(categories, [])).toBe(false);
  });
});

describe('vendorTotals', () => {
  it('owes the rest of open bills and counts payments on bills that are not void', () => {
    expect(vendorTotals([
      { status: 'pending', total: 1_000, amount_paid: 0 },
      { status: 'partial', total: 2_000, amount_paid: 500 },
      { status: 'paid', total: 700, amount_paid: 700 },
      { status: 'void', total: 900, amount_paid: 900 },
    ])).toEqual({ owed: 2_500, openCount: 2, paid: 1_200 });
    expect(vendorTotals([])).toEqual({ owed: 0, openCount: 0, paid: 0 });
  });
});

describe('canVoidBill', () => {
  const open = { status: 'pending', payments: [], bank_matches: 0 };

  it('lets the owner void an open bill with no payments or bank matches', () => {
    expect(canVoidBill(open, true)).toBe(true);
  });

  it.each([
    ['for the accountant', open, false],
    ['once void', { ...open, status: 'void' }, true],
    ['with a payment', { ...open, payments: [{}] }, true],
    ['while matched to a bank line', { ...open, bank_matches: 1 }, true],
  ])('hides it %s', (_, bill, isOwner) => {
    expect(canVoidBill(bill, isOwner)).toBe(false);
  });
});

describe('canEditBill', () => {
  it('lets the owner edit a bill with no payments that is not void, even while matched', () => {
    expect(canEditBill({ status: 'pending', payments: [] }, true)).toBe(true);
    expect(canEditBill({ status: 'pending', payments: [{}] }, true)).toBe(false);
    expect(canEditBill({ status: 'void', payments: [] }, true)).toBe(false);
    expect(canEditBill({ status: 'pending', payments: [] }, false)).toBe(false);
  });
});
