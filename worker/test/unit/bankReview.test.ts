import { describe, expect, it } from 'vitest';
import { cannotPost, type LineState } from '../../src/services/bankReview';

const line = (over: Partial<LineState>): LineState => ({
  id: 't', date: '2026-06-01', amount: -1000, is_reconciled: 0, expense_category_id: null, vat_rate: null, pending: 0, allocated: 0, ...over,
});

describe('cannotPost', () => {
  it('posts a line with a category, matched or not', () => {
    expect(cannotPost(line({ expense_category_id: 'c', vat_rate: 0.2 }))).toBeNull();
    expect(cannotPost(line({ expense_category_id: 'c', vat_rate: 0 }))).toBeNull();
    expect(cannotPost(line({ expense_category_id: 'c', vat_rate: 0, allocated: 300, pending: 1 }))).toBeNull();
  });

  it('needs the VAT chosen for the part a category explains', () => {
    expect(cannotPost(line({ expense_category_id: 'c' }))).toMatchObject({ status: 422, error: expect.stringContaining('VAT') });
    expect(cannotPost(line({ expense_category_id: 'c', allocated: 300, pending: 1 }))).toMatchObject({ status: 422 });
    // Fully matched: the invoice/bill carries the VAT
    expect(cannotPost(line({ expense_category_id: 'c', allocated: 1000, pending: 1 }))).toBeNull();
  });

  it('posts an uncategorised line only when matches cover all of it', () => {
    expect(cannotPost(line({ allocated: 1000, pending: 1 }))).toBeNull();
    expect(cannotPost(line({ amount: 1000, allocated: 1000 }))).toBeNull();
    expect(cannotPost(line({ allocated: 999, pending: 1 }))).toMatchObject({ status: 422, error: expect.stringContaining('Part of this line') });
  });

  it('refuses a line with nothing to explain it', () => {
    expect(cannotPost(line({}))).toMatchObject({ status: 422, error: expect.stringContaining('Choose a category') });
  });

  it('refuses a line that is already posted', () => {
    expect(cannotPost(line({ is_reconciled: 1, expense_category_id: 'c' }))).toMatchObject({ status: 409 });
  });
});
