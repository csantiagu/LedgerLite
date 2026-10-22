import { auditStatement, type AuditActor } from '../middleware/audit';
import { lockDate } from './periods';

export type CategorisationRule = {
  id: string;
  match_text: string;
  direction: 'any' | 'in' | 'out';
  expense_category_id: string;
  explanation: string | null;
  priority: number;
  vat_rate: number | null;     // the rule's own, else the category's usual VAT
};

type RuleCandidate = {
  description: string;
  reference: string | null;
  amount: number;
};

// D1 caps bound parameters per statement at 100
const ID_CHUNK = 90;

export async function loadActiveRules(db: D1Database): Promise<CategorisationRule[]> {
  const { results } = await db.prepare(
    `SELECT r.id, r.match_text, r.direction, r.expense_category_id, r.explanation, r.priority,
            COALESCE(r.vat_rate, ec.default_vat_rate) AS vat_rate
     FROM categorisation_rules r
     JOIN expense_categories ec ON ec.id = r.expense_category_id AND ec.is_active = 1
     WHERE r.is_active = 1
     ORDER BY r.priority ASC, length(r.match_text) DESC`
  ).all<CategorisationRule>();
  return results;
}

// Rules must already be sorted by priority, then specificity (loadActiveRules does this).
export function findMatchingRule(
  rules: CategorisationRule[],
  tx: RuleCandidate,
): CategorisationRule | null {
  // Collapse whitespace so "HMRC  VAT" in a bank export still matches a rule for "HMRC VAT"
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const haystack = norm(`${tx.description} ${tx.reference ?? ''}`);
  for (const rule of rules) {
    if (rule.direction === 'in' && tx.amount <= 0) continue;
    if (rule.direction === 'out' && tx.amount >= 0) continue;
    if (haystack.includes(norm(rule.match_text))) return rule;
  }
  return null;
}

/**
 * Categorise transactions that have no category and no invoice/bill match.
 * Never overwrites a category or notes the user has set by hand.
 * Pass transactionIds to limit to those rows (e.g. a fresh import); omit to sweep everything.
 */
export async function applyRules(db: D1Database, transactionIds?: string[], actor?: AuditActor): Promise<number> {
  const rules = await loadActiveRules(db);
  if (rules.length === 0) return 0;
  if (transactionIds && transactionIds.length === 0) return 0;

  // Lines in a locked VAT period are left alone
  const lock = await lockDate(db);
  const baseSql = `
    SELECT t.id, t.description, t.reference, t.amount
    FROM transactions t
    WHERE t.expense_category_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM transaction_matches tm WHERE tm.transaction_id = t.id)
      AND (? IS NULL OR t.date > ?)`;

  const candidates: Array<RuleCandidate & { id: string }> = [];
  if (transactionIds) {
    for (let i = 0; i < transactionIds.length; i += ID_CHUNK) {
      const chunk = transactionIds.slice(i, i + ID_CHUNK);
      const { results } = await db.prepare(
        `${baseSql} AND t.id IN (${chunk.map(() => '?').join(',')})`
      ).bind(lock, lock, ...chunk).all<RuleCandidate & { id: string }>();
      candidates.push(...results);
    }
  } else {
    const { results } = await db.prepare(baseSql).bind(lock, lock).all<RuleCandidate & { id: string }>();
    candidates.push(...results);
  }

  const updates: D1PreparedStatement[] = [];
  const byRule = new Map<CategorisationRule, string[]>();
  for (const tx of candidates) {
    const rule = findMatchingRule(rules, tx);
    if (!rule) continue;
    byRule.set(rule, [...(byRule.get(rule) ?? []), tx.id]);
    updates.push(
      db.prepare(
        `UPDATE transactions
         SET expense_category_id = ?,
             categorised_by_rule_id = ?,
             notes = COALESCE(NULLIF(notes, ''), ?),
             vat_rate = COALESCE(vat_rate, ?),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND expense_category_id IS NULL`
      ).bind(rule.expense_category_id, rule.id, rule.explanation, rule.vat_rate, tx.id)
    );
  }

  // One audit row per rule listing the lines it categorised (a line's history finds it there),
  // rather than one per line, to keep the number of D1 queries down
  const audits = actor ? [...byRule].map(([rule, ids]) => auditStatement(db, actor, {
    action: 'categorisation_rule.applied', resourceType: 'categorisation_rule', resourceId: rule.id,
    newValues: { transactionIds: ids, expenseCategoryId: rule.expense_category_id, vatRate: rule.vat_rate },
    summary: `Rule "${rule.match_text}" categorised ${ids.length} line${ids.length === 1 ? '' : 's'}`,
  })) : [];
  const statements = [...updates, ...audits];
  for (let i = 0; i < statements.length; i += 50) {
    await db.batch(statements.slice(i, i + 50));
  }
  return updates.length;
}
