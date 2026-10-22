import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { requireRole } from '../middleware/rbac';
import { actorOf, auditStatement, changedFields } from '../middleware/audit';
import type { Env } from '../types';

const router = new Hono<{ Bindings: Env }>();

const CategorySchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional().nullable(),
  // VAT a bank line gets when this category is chosen: 0 = no VAT, 0.2 = 20%; null = ask each time
  defaultVatRate: z.number().min(0).max(1).optional().nullable(),
  // Where its bank lines go in the VAT return: purchases (boxes 4 and 7), sales (1 and 6), or neither
  vatBox: z.enum(['purchases', 'sales', 'excluded']).optional(),
  // Purchases whose VAT cannot be reclaimed (client entertainment): the net stays in box 7
  vatReclaim: z.boolean().optional(),
  // Where its bank lines go in the profit and loss: expense, income, or neither
  plLine: z.enum(['expense', 'income', 'excluded']).optional(),
});

router.get('/', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, name, description, default_vat_rate, vat_box, vat_reclaim, pl_line
     FROM expense_categories
     WHERE is_active = 1
     ORDER BY name ASC`
  ).all();
  return c.json(rows.results);
});

router.post('/', requireRole('owner'), zValidator('json', CategorySchema), async (c) => {
  const data = c.req.valid('json');
  const id = crypto.randomUUID().replace(/-/g, '');

  const dup = await c.env.DB.prepare(
    `SELECT id FROM expense_categories WHERE lower(name) = lower(?) AND is_active = 1`
  ).bind(data.name.trim()).first();
  if (dup) return c.json({ error: 'Category name already exists' }, 409);

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO expense_categories (id, name, description, default_vat_rate, vat_box, vat_reclaim, pl_line, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
    ).bind(
      id, data.name.trim(), data.description ?? null, data.defaultVatRate ?? null,
      data.vatBox ?? 'purchases', data.vatReclaim === false ? 0 : 1, data.plLine ?? 'expense',
    ),
    auditStatement(c.env.DB, actorOf(c), {
      action: 'expense_category.created', resourceType: 'expense_category', resourceId: id, newValues: data,
      summary: `Added category ${data.name.trim()}`,
    }),
  ]);

  return c.json({ id }, 201);
});

router.put('/:id', requireRole('owner'), zValidator('json', CategorySchema), async (c) => {
  const id = c.req.param('id');
  const data = c.req.valid('json');

  const existing = await c.env.DB.prepare(
    `SELECT id, name, description, default_vat_rate, vat_box, vat_reclaim, pl_line FROM expense_categories WHERE id = ? AND is_active = 1`
  ).bind(id).first<{ id: string; name: string; description: string | null; default_vat_rate: number | null; vat_box: string; vat_reclaim: number; pl_line: string }>();
  if (!existing) return c.json({ error: 'Not found' }, 404);

  const dup = await c.env.DB.prepare(
    `SELECT id FROM expense_categories
     WHERE lower(name) = lower(?) AND id != ? AND is_active = 1`
  ).bind(data.name.trim(), id).first();
  if (dup) return c.json({ error: 'Category name already exists' }, 409);

  const diff = changedFields(
    { name: existing.name, description: existing.description, defaultVatRate: existing.default_vat_rate, vatBox: existing.vat_box, vatReclaim: existing.vat_reclaim === 1, plLine: existing.pl_line },
    { name: data.name.trim(), description: data.description ?? null, defaultVatRate: data.defaultVatRate, vatBox: data.vatBox, vatReclaim: data.vatReclaim ?? existing.vat_reclaim === 1, plLine: data.plLine },
  );
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE expense_categories
       SET name = ?, description = ?,
           default_vat_rate = CASE WHEN ? THEN ? ELSE default_vat_rate END,
           vat_box = COALESCE(?, vat_box),
           vat_reclaim = COALESCE(?, vat_reclaim),
           pl_line = COALESCE(?, pl_line)
       WHERE id = ?`
    ).bind(
      data.name.trim(), data.description ?? null,
      Object.hasOwn(data, 'defaultVatRate') ? 1 : 0, data.defaultVatRate ?? null,
      data.vatBox ?? null, data.vatReclaim === undefined ? null : data.vatReclaim ? 1 : 0, data.plLine ?? null, id,
    ),
    ...(diff ? [auditStatement(c.env.DB, actorOf(c), {
      action: 'expense_category.updated', resourceType: 'expense_category', resourceId: id, ...diff,
      summary: `Edited category ${existing.name}`,
    })] : []),
  ]);

  return c.json({ ok: true });
});

export { router as expenseCategoryRoutes };
