import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { requireRole } from '../middleware/rbac';
import { actorOf, auditStatement, changedFields } from '../middleware/audit';
import { applyRules } from '../services/categorisationRules';
import type { Env } from '../types';

const router = new Hono<{ Bindings: Env }>();

const RuleSchema = z.object({
  matchText: z.string().trim().min(2, 'Match text must be at least 2 characters').max(120),
  direction: z.enum(['any', 'in', 'out']).default('any'),
  expenseCategoryId: z.string().min(1),
  explanation: z.string().trim().max(500).nullable().optional(),
  priority: z.number().int().min(0).max(1000).default(100),
  // VAT included in the lines it categorises: 0 = no VAT, 0.2 = 20%; null = the category's usual VAT
  vatRate: z.number().min(0).max(1).nullable().optional(),
});

router.get('/', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT r.id, r.match_text, r.direction, r.expense_category_id, r.explanation, r.priority,
            r.vat_rate, ec.name as category_name, ec.default_vat_rate,
            (SELECT COUNT(*) FROM transactions t WHERE t.categorised_by_rule_id = r.id) as times_applied
     FROM categorisation_rules r
     JOIN expense_categories ec ON ec.id = r.expense_category_id
     WHERE r.is_active = 1
     ORDER BY r.priority ASC, length(r.match_text) DESC, r.match_text ASC`
  ).all();
  return c.json(results);
});

router.post('/', requireRole('owner'), zValidator('json', RuleSchema), async (c) => {
  const user = c.get('user');
  const data = c.req.valid('json');

  const category = await c.env.DB.prepare(
    'SELECT id FROM expense_categories WHERE id = ? AND is_active = 1'
  ).bind(data.expenseCategoryId).first();
  if (!category) return c.json({ error: 'Category not found' }, 400);

  const dup = await c.env.DB.prepare(
    `SELECT id FROM categorisation_rules
     WHERE lower(match_text) = lower(?) AND direction = ? AND is_active = 1`
  ).bind(data.matchText, data.direction).first();
  if (dup) return c.json({ error: 'A rule for that text already exists' }, 409);

  const id = crypto.randomUUID().replace(/-/g, '');
  const actor = actorOf(c);
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO categorisation_rules
         (id, match_text, direction, expense_category_id, explanation, priority, vat_rate, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, data.matchText, data.direction, data.expenseCategoryId,
           data.explanation || null, data.priority, data.vatRate ?? null, user.id),
    auditStatement(c.env.DB, actor, {
      action: 'categorisation_rule.created', resourceType: 'categorisation_rule', resourceId: id,
      newValues: data, summary: `Added rule "${data.matchText}"`,
    }),
  ]);

  // Tag existing uncategorised transactions straight away
  const applied = await applyRules(c.env.DB, undefined, actor);

  return c.json({ id, applied }, 201);
});

router.put('/:id', requireRole('owner'), zValidator('json', RuleSchema), async (c) => {
  const id = c.req.param('id');
  const data = c.req.valid('json');

  const existing = await c.env.DB.prepare(
    `SELECT id, match_text, direction, expense_category_id, explanation, priority, vat_rate
     FROM categorisation_rules WHERE id = ? AND is_active = 1`
  ).bind(id).first<{
    match_text: string; direction: string; expense_category_id: string; explanation: string | null;
    priority: number; vat_rate: number | null;
  }>();
  if (!existing) return c.json({ error: 'Not found' }, 404);

  const category = await c.env.DB.prepare(
    'SELECT id FROM expense_categories WHERE id = ? AND is_active = 1'
  ).bind(data.expenseCategoryId).first();
  if (!category) return c.json({ error: 'Category not found' }, 400);

  const actor = actorOf(c);
  const diff = changedFields(
    {
      matchText: existing.match_text, direction: existing.direction, expenseCategoryId: existing.expense_category_id,
      explanation: existing.explanation, priority: existing.priority, vatRate: existing.vat_rate,
    },
    { ...data, explanation: data.explanation || null, vatRate: data.vatRate ?? null },
  );
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE categorisation_rules
       SET match_text = ?, direction = ?, expense_category_id = ?, explanation = ?, priority = ?,
           vat_rate = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).bind(data.matchText, data.direction, data.expenseCategoryId,
           data.explanation || null, data.priority, data.vatRate ?? null, id),
    ...(diff ? [auditStatement(c.env.DB, actor, {
      action: 'categorisation_rule.updated', resourceType: 'categorisation_rule', resourceId: id, ...diff,
      summary: `Edited rule "${data.matchText}"`,
    })] : []),
  ]);

  const applied = await applyRules(c.env.DB, undefined, actor);

  return c.json({ ok: true, applied });
});

// Soft delete. Transactions it already categorised keep their category.
router.delete('/:id', requireRole('owner'), async (c) => {
  const id = c.req.param('id');
  // The audit row runs first and only while the rule is still active, so it's written exactly when the delete is
  const [audited] = await c.env.DB.batch([
    auditStatement(c.env.DB, actorOf(c), {
      action: 'categorisation_rule.deleted', resourceType: 'categorisation_rule', resourceId: id,
      oldValues: { is_active: true }, newValues: { is_active: false }, summary: 'Deleted rule',
    }, { sql: 'EXISTS (SELECT 1 FROM categorisation_rules WHERE id = ? AND is_active = 1)', binds: [id] }),
    c.env.DB.prepare(
      `UPDATE categorisation_rules SET is_active = 0, updated_at = datetime('now')
       WHERE id = ? AND is_active = 1`
    ).bind(id),
  ]);
  if (!audited.meta.changes) return c.json({ error: 'Not found' }, 404);
  return c.json({ ok: true });
});

// Re-run every rule against all uncategorised, unmatched transactions
router.post('/apply', requireRole('owner'), async (c) => {
  const applied = await applyRules(c.env.DB, undefined, actorOf(c));
  return c.json({ applied });
});

export { router as categorisationRuleRoutes };
