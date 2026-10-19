import { describe, expect, it } from 'vitest';
import { postAction, ruleHref, suggestRuleText } from '@/app/transactions/reviewRules';
import type { Txn } from '@/app/transactions/shared';

const txn = (over: Partial<Txn>): Txn => ({
  id: 't', bank_account_id: 'a', date: '2026-04-01', description: 'X', amount: -1000,
  expense_category_id: null, is_reconciled: 0, flagged: 0, notes: null, accountant_notes: null,
  attachment_r2_key: null, attachment_filename: null, categorised_by_rule_id: null, allocated_total: 0,
  ...over,
});

describe('suggestRuleText', () => {
  it.each([
    ['HMRC VAT 123456789 DD', 'HMRC VAT'],
    ['STARLING ACCOUNT , TRANSFER , VIA MOBILE', 'STARLING ACCOUNT'],
    ['GOCARDLESS EXELACCOUNTA HMGYX EXTRA WORDS', 'GOCARDLESS EXELACCOUNTA HMGYX'],
    ['04JUL A/C 24148008', '04JUL A/C'],
  ])('%s → %s', (description, text) => {
    expect(suggestRuleText(description)).toBe(text);
  });
});

describe('ruleHref', () => {
  it('pre-fills the rule from the line', () => {
    const href = ruleHref(txn({ description: 'HMRC VAT 1 DD', expense_category_id: 'vat', notes: 'Quarterly VAT' }));
    const p = new URLSearchParams(href.split('?')[1]);
    expect(Object.fromEntries(p)).toEqual({ text: 'HMRC VAT', category: 'vat', direction: 'out', explanation: 'Quarterly VAT' });
  });
});

describe('postAction', () => {
  it('needs a category or a match before posting', () => {
    expect(postAction(txn({}))).toEqual({ label: 'Post', ready: false });
    expect(postAction(txn({ expense_category_id: 'c' }))).toEqual({ label: 'Post', ready: true });
  });

  it('posts a matched line only when the matches cover all of it, unless it has a category', () => {
    expect(postAction(txn({ match_status: 'pending', allocated_total: 1000 })).ready).toBe(true);
    expect(postAction(txn({ match_status: 'pending', allocated_total: 400 })).ready).toBe(false);
    expect(postAction(txn({ match_status: 'pending', allocated_total: 400, expense_category_id: 'c' })).ready).toBe(true);
    expect(postAction(txn({ amount: 1000, match_kind: 'link', match_status: 'posted', allocated_total: 1000 })).ready).toBe(true);
  });

  it('offers Match for a suggestion that covers the line', () => {
    expect(postAction(txn({ match_status: 'suggested', match_allocated: 1000 }))).toEqual({ label: 'Match', ready: true });
    expect(postAction(txn({ match_status: 'suggested', match_allocated: 300 }))).toEqual({ label: 'Match', ready: false });
  });
});
