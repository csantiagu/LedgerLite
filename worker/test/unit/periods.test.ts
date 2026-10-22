import { describe, expect, it } from 'vitest';
import { checkOpen, isLocked, isQuarterEnd, nextQuarter, quarterFor, quartersBetween } from '../../src/services/periods';

describe('quarterFor', () => {
  it('finds Mar/Jun/Sep/Dec quarters', () => {
    expect(quarterFor('2026-01-01', 3)).toEqual({ start: '2026-01-01', end: '2026-03-31', label: 'Jan–Mar 2026' });
    expect(quarterFor('2026-06-30', 3)).toEqual({ start: '2026-04-01', end: '2026-06-30', label: 'Apr–Jun 2026' });
    expect(quarterFor('2026-12-15', 12)).toEqual({ start: '2026-10-01', end: '2026-12-31', label: 'Oct–Dec 2026' });
  });

  it('handles quarters that cross a year end, and leap years', () => {
    expect(quarterFor('2026-12-01', 1)).toEqual({ start: '2026-11-01', end: '2027-01-31', label: 'Nov 2026–Jan 2027' });
    expect(quarterFor('2027-01-31', 1).end).toBe('2027-01-31');
    expect(quarterFor('2028-01-10', 2)).toEqual({ start: '2027-12-01', end: '2028-02-29', label: 'Dec 2027–Feb 2028' });
  });

  it('gives the same quarter for any month that ends one', () => {
    expect(quarterFor('2026-05-05', 6)).toEqual(quarterFor('2026-05-05', 9));
  });
});

describe('quarter lists', () => {
  it('steps from one quarter to the next', () => {
    expect(nextQuarter(quarterFor('2026-11-01', 3), 3).label).toBe('Jan–Mar 2027');
    expect(quartersBetween('2026-02-14', '2026-07-01', 3).map(q => q.end))
      .toEqual(['2026-03-31', '2026-06-30', '2026-09-30']);
  });

  it('knows quarter ends', () => {
    expect(isQuarterEnd('2026-06-30', 3)).toBe(true);
    expect(isQuarterEnd('2026-06-29', 3)).toBe(false);
    expect(isQuarterEnd('2026-05-31', 3)).toBe(false);
  });
});

describe('the lock date', () => {
  it('locks dates on or before it, and nothing when unset', () => {
    expect(isLocked('2026-06-30', '2026-06-30')).toBe(true);
    expect(isLocked('2026-06-30 14:00:00', '2026-06-30')).toBe(true);
    expect(isLocked('2026-07-01', '2026-06-30')).toBe(false);
    expect(isLocked('2020-01-01', null)).toBe(false);
    expect(isLocked(null, '2026-06-30')).toBe(false);
  });

  it('names the earliest locked date', async () => {
    expect(await checkOpen({ lock: '2026-06-30' }, '2026-07-02', null)).toBeNull();
    expect(await checkOpen({ lock: '2026-06-30' }, '2026-07-02', '2026-06-01', '2026-05-01')).toEqual({
      ok: false, status: 423, error: expect.stringMatching(/^01\/05\/2026 is in a locked VAT period .* up to 30\/06\/2026/),
    });
  });
});
