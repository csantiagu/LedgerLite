import { describe, expect, it } from 'vitest';
import {
  amountMatch, matchesQuery, nameMatch, numberMatch, pickCandidates, rankCandidates, BEST_LIMIT, type Candidate,
} from '../../src/services/matchCandidates';

const inv = (id: string, party: string, outstanding: number, over: Partial<Candidate> = {}): Candidate => ({
  type: 'invoice', id, number: `INV-2026-${id.padStart(4, '0')}`, party, total: outstanding, outstanding,
  date: '2026-09-01', ...over,
});

describe('nameMatch', () => {
  it('finds the name in any case, ignoring Ltd and friends', () => {
    expect(nameMatch('Acme Linking Ltd', 'FASTER PAYMENT ACME LINKING')).toBe(1);
    expect(nameMatch('The Bakery Co', 'bakery')).toBe(1);
  });

  it('copes with bank text cut short or run together', () => {
    expect(nameMatch('Acme Linking Ltd', 'ACME LINKI')).toBe(1);
    expect(nameMatch('Acme Linking Ltd', 'ACMELINKING REF 123')).toBe(1);
  });

  it('gives a share for part of a name, and nothing for generic words alone', () => {
    expect(nameMatch('John Smith Plumbing', 'J SMITH')).toBeCloseTo(1 / 3);
    expect(nameMatch('Bright Solutions Ltd', 'SOLUTIONS LTD')).toBe(0);
    expect(nameMatch('Acme', 'BARCLAYS')).toBe(0);
  });
});

describe('numberMatch', () => {
  it('finds invoice numbers however they are spaced', () => {
    expect(numberMatch('INV-2026-0001', 'PAYMENT INV 2026 0001')).toBe(true);
    expect(numberMatch('INV-2026-0001', 'INV-2026-0010')).toBe(false);
  });

  it('needs a bare QuickBooks number to be a whole word', () => {
    expect(numberMatch('1043', 'ACME 1043')).toBe(true);
    expect(numberMatch('1043', 'ACME 21043')).toBe(false);
    expect(numberMatch('12', 'ACME 12')).toBe(false);
  });
});

describe('amountMatch', () => {
  it('ranks exact, then within 2% or £1, then nothing', () => {
    expect(amountMatch(10000, 10000)).toBe(2);
    expect(amountMatch(10150, 10000)).toBe(1);
    expect(amountMatch(1099, 1000)).toBe(1);
    expect(amountMatch(1200, 1000)).toBe(0);
    expect(amountMatch(1000, 0)).toBe(0);
  });
});

describe('rankCandidates', () => {
  const line = { description: 'FASTER PAYMENT ACME LINKING', reference: null, remaining: 50000 };

  it("puts the customer's invoices first, closest amount at the top", () => {
    const ranked = rankCandidates([
      inv('1', 'Other Client', 50000),
      inv('2', 'Acme Linking Ltd', 12000),
      inv('3', 'Acme Linking Ltd', 50000),
      inv('4', 'Acme Linking Ltd', 49000),
      inv('5', 'Acme Linking Ltd', 70000),
    ], line);
    expect(ranked.map(r => r.id)).toEqual(['3', '4', '5', '2', '1']);
    expect(ranked[0].reasons).toEqual(['name', 'exact']);
    expect(ranked[1].reasons).toEqual(['name', 'near']);
    expect(ranked[4].reasons).toEqual(['exact']);
  });

  it('puts an invoice whose number is in the text above everything', () => {
    const ranked = rankCandidates([inv('3', 'Acme Linking Ltd', 50000), inv('9', 'Other', 100)],
      { ...line, reference: 'INV-2026-0009' });
    expect(ranked[0]).toMatchObject({ id: '9', reasons: ['number'] });
  });
});

describe('pickCandidates', () => {
  const line = { description: 'ACME', reference: null, remaining: 1000 };
  const ranked = rankCandidates([
    inv('1', 'Acme', 300), inv('2', 'Zed', 1000), inv('3', 'Other', 777), inv('4', 'Other', 2500),
  ], line);

  it('shows only candidates with a reason by default, and says how many are hidden', () => {
    expect(pickCandidates(ranked, {})).toMatchObject({ hidden: 2 });
    expect(pickCandidates(ranked, {}).results.map(r => r.id)).toEqual(['1', '2']);
  });

  it('shows everything with all, still ranked', () => {
    expect(pickCandidates(ranked, { all: true }).results.map(r => r.id)).toEqual(['1', '2', '3', '4']);
  });

  it('searches number, name or amount across all candidates', () => {
    expect(pickCandidates(ranked, { q: 'other' }).results.map(r => r.id)).toEqual(['3', '4']);
    expect(pickCandidates(ranked, { q: '7.77' }).results.map(r => r.id)).toEqual(['3']);
    expect(pickCandidates(ranked, { q: '0004' }).results.map(r => r.id)).toEqual(['4']);
  });

  it('caps the best matches', () => {
    const many = rankCandidates(Array.from({ length: 30 }, (_, i) => inv(String(i + 1), 'Acme', 5)), line);
    expect(pickCandidates(many, {}).results).toHaveLength(BEST_LIMIT);
  });

  it('matchesQuery ignores blank searches', () => {
    expect(matchesQuery(inv('1', 'Acme', 1), '  ')).toBe(true);
  });
});
