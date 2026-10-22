import { describe, expect, it } from 'vitest';
import { alsoLocks, awaitingReview, isLocked, staggerOf, unlockable, voidConfirmText, type PeriodQuarter } from '@/lib/periods';

const q = (end: string, status: PeriodQuarter['status']): PeriodQuarter =>
  ({ start: `${end.slice(0, 5)}01-01`, end, label: end, status, unposted: 0, lock: null, snapshot: null, changedSinceLocked: [] });
const quarters = [q('2026-12-31', 'current'), q('2026-09-30', 'ended'), q('2026-06-30', 'ended'), q('2026-03-31', 'locked')];

describe('periods', () => {
  it('locks dates on or before the lock date', () => {
    expect(isLocked('2026-03-31', '2026-03-31')).toBe(true);
    expect(isLocked('2026-04-01', '2026-03-31')).toBe(false);
    expect(isLocked('2020-01-01', null)).toBe(false);
  });

  it('finds the quarter waiting for review, and what locking a later one takes with it', () => {
    expect(awaitingReview({ quarters })?.end).toBe('2026-09-30');
    expect(alsoLocks({ quarters }, quarters[1]!).map(x => x.end)).toEqual(['2026-06-30']);
    expect(awaitingReview({ quarters: [q('2026-12-31', 'current')] })).toBeNull();
  });

  it('only unlocks the newest locked quarter', () => {
    expect(unlockable({ quarters, lockDate: '2026-03-31' })?.end).toBe('2026-03-31');
    expect(unlockable({ quarters, lockDate: null })).toBeNull();
  });

  it('warns before voiding something in a reviewed quarter', () => {
    expect(voidConfirmText('invoice', '2026-07-01', '2026-06-30')).toBe('Void this invoice? This cannot be undone.');
    expect(voidConfirmText('credit_note', '2026-06-01', '2026-06-30')).toMatch(/^This credit note is in a VAT quarter that has been reviewed/);
  });

  it('maps any quarter end month to its stagger', () => {
    expect([3, 6, 9, 12].map(staggerOf)).toEqual([3, 3, 3, 3]);
    expect([1, 4, 7, 10].map(staggerOf)).toEqual([1, 1, 1, 1]);
    expect(staggerOf(11)).toBe(2);
  });
});
