import { describe, expect, it } from 'vitest';
import { addDays, daysBetween, localToday } from '@/lib/dates';

describe('localToday', () => {
  it('is the local calendar date, not the UTC one', () => {
    // 00:30 on 2 Nov where the clock is an hour ahead of UTC (e.g. BST): UTC is still 1 Nov
    const now = new Date('2026-11-01T23:30:00Z');
    now.getTimezoneOffset = () => -60;
    expect(localToday(now)).toBe('2026-11-02');
  });

  it('is the same as UTC when there is no offset', () => {
    const now = new Date('2026-11-02T12:00:00Z');
    now.getTimezoneOffset = () => 0;
    expect(localToday(now)).toBe('2026-11-02');
  });
});

describe('addDays and daysBetween', () => {
  it('count whole days across month and year ends, leap days and clock changes', () => {
    expect(addDays('2026-12-25', 14)).toBe('2027-01-08');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2);   // UK clocks go forward on 29 Mar
    expect(daysBetween('2026-09-15', '2026-09-01')).toBe(-14);
  });
});
