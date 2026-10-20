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
  if (t.vat_rate !== null && t.vat_rate !== undefined) p.set('vat', String(t.vat_rate));
  return `/settings/rules?${p.toString()}`;
}

/**
 * What a line's Post button does, and whether the server will accept it (the same rule as
 * cannotPost in the worker): a category explains any line, once its VAT is chosen for the part
 * the matches don't cover; without one, the matches (including a suggestion about to be accepted)
 * have to cover the whole amount. `hint` says what's missing.
 */
export function postAction(t: Txn): { label: 'Match' | 'Post'; ready: boolean; hint?: string } {
  const suggested = t.match_status === 'suggested';
  const label = suggested ? 'Match' : 'Post';
  const matched = (t.allocated_total ?? 0) + (suggested ? t.match_allocated ?? 0 : 0);
  const covered = matched > 0 && matched >= Math.abs(t.amount);
  if (covered) return { label, ready: true };
  if (!t.expense_category_id) return { label, ready: false, hint: 'Choose a category or find a match first' };
  if (t.vat_rate === null || t.vat_rate === undefined) return { label, ready: false, hint: 'Choose the VAT first' };
  return { label, ready: true };
}
