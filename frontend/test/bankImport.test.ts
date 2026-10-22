import { describe, expect, it } from 'vitest';
import { importSummary } from '@/lib/bankImport';

describe('importSummary', () => {
  it('says how many lines came in and what was done with them', () => {
    expect(importSummary({ newRowCount: 3, suggested: 1, categorised: 2 }))
      .toBe('Imported 3 new transactions into For Review · 1 match suggestion · 2 categorised by rules.');
    expect(importSummary({ newRowCount: 1, openingBalanceSet: true }))
      .toBe('Imported 1 new transaction into For Review · opening balance auto-detected from CSV.');
  });

  it('explains skipped lines, naming the earlier import when there is one', () => {
    const overlap = { filename: 'may.csv', imported_at: '2026-06-02 10:00:00', first_date: '2026-05-01', last_date: '2026-05-31' };
    expect(importSummary({ newRowCount: 0, skipped: 1, overlaps: [overlap] }))
      .toBe('Imported 0 new transactions into For Review · 1 line already in the books skipped (also in may.csv, imported 02 Jun 2026).');
    expect(importSummary({ newRowCount: 2, skipped: 5, overlaps: [overlap, overlap] }))
      .toBe('Imported 2 new transactions into For Review · 5 lines already in the books skipped (also in 2 earlier imports).');
  });
});
