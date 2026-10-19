// Pure rules for the For Review list, kept apart from the component so they can be tested.
import type { Txn } from './shared';

// "HMRC VAT 123456789 DD" → "HMRC VAT", "STARLING ACCOUNT , TRANSFER , ..." → "STARLING ACCOUNT":
// up to 3 leading words of the first comma-separated part, stopping at the first word with digits
export function suggestRuleText(description: string): string {
  const out: string[] = [];
  for (const w of description.split(',')[0].trim().split(/\s+/)) {
    if (/\d/.test(w) && out.length) break;
    out.push(w);
    if (out.length === 3) break;
  }
  return out.join(' ');
}

export function ruleHref(t: Txn): string {
  const p = new URLSearchParams({
    text: suggestRuleText(t.description),
    category: t.expense_category_id ?? '',
    direction: t.amount < 0 ? 'out' : 'in',
  });
  if (t.notes) p.set('explanation', t.notes);
  return `/settings/rules?${p.toString()}`;
}

/**
 * What a line's Post button does, and whether the server will accept it (the same rule as
 * cannotPost in the worker): a category explains any line; without one, the matches (including
 * a suggestion about to be accepted) have to cover the whole amount.
 */
export function postAction(t: Txn): { label: 'Match' | 'Post'; ready: boolean } {
  const suggested = t.match_status === 'suggested';
  const matched = (t.allocated_total ?? 0) + (suggested ? t.match_allocated ?? 0 : 0);
  const ready = !!t.expense_category_id || (matched > 0 && matched >= Math.abs(t.amount));
  return { label: suggested ? 'Match' : 'Post', ready };
}
