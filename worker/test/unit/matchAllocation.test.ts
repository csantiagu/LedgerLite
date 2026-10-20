import { describe, expect, it } from 'vitest';
import { checkAllocation, paymentIdFor, planPost, type AllocationInput, type PostCandidate } from '../../src/services/matchAllocation';

const base: AllocationInput = {
  type: 'invoice',
  txnAmount: 10_000,
  allocatedAmount: 10_000,
  otherTxnAllocations: 0,
  targetStatus: 'sent',
  targetOutstanding: 10_000,
  otherPendingOnTarget: 0,
};

describe('checkAllocation', () => {
  it('accepts an exact match', () => {
    expect(checkAllocation(base)).toBeNull();
  });

  it('accepts a partial allocation', () => {
    expect(checkAllocation({ ...base, allocatedAmount: 4_000 })).toBeNull();
  });

  it('rejects zero, negative and fractional pence', () => {
    expect(checkAllocation({ ...base, allocatedAmount: 0 })).toMatch(/positive/);
    expect(checkAllocation({ ...base, allocatedAmount: -1 })).toMatch(/positive/);
    expect(checkAllocation({ ...base, allocatedAmount: 10.5 })).toMatch(/positive/);
  });

  it('rejects money out matched to a sales invoice', () => {
    expect(checkAllocation({ ...base, txnAmount: -10_000 })).toMatch(/money coming in/);
  });

  it('rejects money in matched to a supplier bill', () => {
    expect(checkAllocation({ ...base, type: 'bill', targetStatus: 'pending' })).toMatch(/money going out/);
  });

  it('accepts money out matched to an open bill', () => {
    expect(checkAllocation({ ...base, type: 'bill', txnAmount: -10_000, targetStatus: 'partial' })).toBeNull();
  });

  it.each(['draft', 'paid', 'void'])('rejects a %s invoice', (status) => {
    expect(checkAllocation({ ...base, targetStatus: status })).toMatch(/cannot take payments/);
  });

  it('rejects allocating more than the bank line', () => {
    expect(checkAllocation({ ...base, allocatedAmount: 10_001, targetOutstanding: 20_000 })).toMatch(/bank transaction/);
  });

  it('counts the bank line\'s other allocations', () => {
    expect(checkAllocation({ ...base, allocatedAmount: 6_000, otherTxnAllocations: 5_000 })).toMatch(/bank transaction/);
    expect(checkAllocation({ ...base, allocatedAmount: 5_000, otherTxnAllocations: 5_000 })).toBeNull();
  });

  it('rejects allocating more than the outstanding balance', () => {
    expect(checkAllocation({ ...base, targetOutstanding: 9_999 })).toMatch(/outstanding balance/);
  });

  it('counts other pending allocations on the same invoice', () => {
    expect(checkAllocation({ ...base, allocatedAmount: 6_000, otherPendingOnTarget: 5_000 })).toMatch(/outstanding balance/);
  });
});

const cand = (over: Partial<PostCandidate> = {}): PostCandidate => ({
  status: 'pending',
  invoice_id: 'inv1',
  bill_id: null,
  allocated_amount: 5_000,
  txn_amount: 5_000,
  expense_category_id: null,
  ...over,
});

describe('planPost', () => {
  it('sums allocations for one invoice', () => {
    expect(planPost([cand(), cand({ allocated_amount: 2_500 })])).toEqual({
      ok: true, type: 'invoice', targetId: 'inv1', total: 7_500,
    });
  });

  it('rejects an empty set', () => {
    expect(planPost([])).toMatchObject({ ok: false, status: 400 });
  });

  it('rejects already-posted matches', () => {
    expect(planPost([cand({ status: 'posted' })])).toMatchObject({ ok: false, status: 409 });
  });

  it('rejects a suggestion that was never accepted', () => {
    expect(planPost([cand({ status: 'suggested' })])).toMatchObject({ ok: false, status: 409 });
  });

  it('rejects matches spanning two targets', () => {
    expect(planPost([cand(), cand({ invoice_id: 'inv2' })])).toMatchObject({ ok: false, status: 400 });
    expect(planPost([cand(), cand({ invoice_id: null, bill_id: 'b1', txn_amount: -5_000 })])).toMatchObject({ ok: false, status: 400 });
  });

  it('rejects the wrong direction', () => {
    expect(planPost([cand({ txn_amount: -5_000 })])).toMatchObject({ ok: false, status: 422 });
  });

  it('leaves the category of a bill payment to posting, which can take it from the bill', () => {
    const bill = cand({ invoice_id: null, bill_id: 'b1', txn_amount: -5_000 });
    expect(planPost([bill])).toMatchObject({ ok: true, type: 'bill', targetId: 'b1' });
  });
});

describe('paymentIdFor', () => {
  it('is stable regardless of order and differs per set', async () => {
    const a = await paymentIdFor(['m2', 'm1']);
    expect(a).toBe(await paymentIdFor(['m1', 'm2']));
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(await paymentIdFor(['m1']));
  });
});
