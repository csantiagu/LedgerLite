import { describe, expect, it } from 'vitest';
import { findMatchingRule, type CategorisationRule } from '../../src/services/categorisationRules';

const rule = (over: Partial<CategorisationRule>): CategorisationRule => ({
  id: over.match_text ?? 'r', match_text: 'x', direction: 'any', expense_category_id: 'c', explanation: null, priority: 100, vat_rate: null,
  ...over,
});

describe('findMatchingRule', () => {
  const rules = [
    rule({ id: 'vat', match_text: 'HMRC VAT', direction: 'out' }),
    rule({ id: 'hmrc', match_text: 'hmrc' }),
    rule({ id: 'refund', match_text: 'HMRC VAT', direction: 'in' }),
  ];

  it('matches case-insensitively in description or reference', () => {
    expect(findMatchingRule(rules, { description: 'hmrc vat 123 dd', reference: null, amount: -100 })?.id).toBe('vat');
    expect(findMatchingRule(rules, { description: 'DIRECT DEBIT', reference: 'HMRC PAYE', amount: -100 })?.id).toBe('hmrc');
  });

  it('respects direction', () => {
    expect(findMatchingRule(rules, { description: 'HMRC VAT', reference: null, amount: 100 })?.id).toBe('hmrc');
    expect(findMatchingRule([rules[0], rules[2]], { description: 'HMRC VAT', reference: null, amount: 100 })?.id).toBe('refund');
  });

  it('ignores runs of whitespace', () => {
    expect(findMatchingRule(rules, { description: 'HMRC   VAT', reference: null, amount: -1 })?.id).toBe('vat');
  });

  it('returns null when nothing matches', () => {
    expect(findMatchingRule(rules, { description: 'Tesco', reference: null, amount: -1 })).toBeNull();
  });
});
