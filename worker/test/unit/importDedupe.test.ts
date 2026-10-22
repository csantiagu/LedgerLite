import { describe, expect, it } from 'vitest';
import { dateRange, newLines } from '../../src/services/importDedupe';

const coffee = { date: '2026-06-01', description: 'COSTA', amount: -450, reference: null };
const rent = { date: '2026-06-01', description: 'RENT', amount: -100_000, reference: 'JUNE' };

describe('newLines', () => {
  it('keeps two identical payments in one file', () => {
    expect(newLines([coffee, { ...coffee }], []).fresh).toHaveLength(2);
  });

  it('adds nothing when the same file is imported again', () => {
    const { fresh, duplicates } = newLines([coffee, coffee, rent], [coffee, coffee, rent]);
    expect(fresh).toEqual([]);
    expect(duplicates).toHaveLength(3);
  });

  it('brings in only the extra copies of a line the books already hold', () => {
    const { fresh, duplicates } = newLines([coffee, coffee, coffee], [coffee]);
    expect(fresh).toHaveLength(2);
    expect(duplicates).toHaveLength(1);
  });

  it('tells lines apart by date, description, amount and reference, ignoring the balance', () => {
    const stored = [coffee];
    expect(newLines([{ ...coffee, date: '2026-06-02' }], stored).fresh).toHaveLength(1);
    expect(newLines([{ ...coffee, description: 'COSTA 2' }], stored).fresh).toHaveLength(1);
    expect(newLines([{ ...coffee, amount: -451 }], stored).fresh).toHaveLength(1);
    expect(newLines([{ ...coffee, reference: 'X' }], stored).fresh).toHaveLength(1);
    expect(newLines([{ ...coffee, reference: '' }], stored).fresh).toHaveLength(0);
    expect(newLines([{ ...coffee, balance: 1_000 }], stored).fresh).toHaveLength(0);
  });
});

describe('dateRange', () => {
  it('gives the first and last date, or null for no lines', () => {
    expect(dateRange([{ date: '2026-06-03' }, { date: '2026-05-30' }, { date: '2026-06-01' }]))
      .toEqual({ from: '2026-05-30', to: '2026-06-03' });
    expect(dateRange([])).toBeNull();
  });
});
