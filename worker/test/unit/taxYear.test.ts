import { describe, expect, it } from 'vitest';
import { taxYearFor, taxYearRange } from '../../src/services/taxYear';

describe('taxYearRange', () => {
  it('maps a label to 6 April – 5 April', () => {
    expect(taxYearRange('2025-26')).toEqual({ from: '2025-04-06', to: '2026-04-05' });
    expect(taxYearRange('2099-00')).toEqual({ from: '2099-04-06', to: '2100-04-05' });
  });

  it.each(['', '2025', '2025-27', '25-26', '1999-00', '2025-26x', 'abcd-ef'])('rejects %j', (label) => {
    expect(taxYearRange(label)).toBeNull();
  });
});

describe('taxYearFor', () => {
  it('switches on 6 April', () => {
    expect(taxYearFor(new Date('2027-04-05T12:00:00Z'))).toBe('2026-27');
    expect(taxYearFor(new Date('2027-04-06T00:00:00Z'))).toBe('2027-28');
    expect(taxYearFor(new Date('2026-12-31T23:59:59Z'))).toBe('2026-27');
    expect(taxYearFor(new Date('2099-05-01T00:00:00Z'))).toBe('2099-00');
  });
});
