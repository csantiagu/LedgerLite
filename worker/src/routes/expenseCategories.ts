import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { requireRole } from '../middleware/rbac';
import { writeAudit } from '../middleware/audit';
import type { Env } from '../types';

const router = new Hono<{ Bindings: Env }>();

const CategorySchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional().nullable(),
  // VAT a bank line gets when this category is chosen: 0 = no VAT, 0.2 = 20%; null = ask each time
  defaultVatRate: z.number().min(0).max(1).optional().nullable(),
});

router.get('/', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, name, description, default_vat_rate
     FROM expense_categories
     WHERE is_active = 1
     ORDER BY name ASC`
  ).all();
  return c.json(rows.results);
});

router.post('/', requireRole('owner'), zValidator('json', CategorySchema), async (c) => {
  const user = c.get('user');
  const data = c.req.valid('json');
  const id = crypto.randomUUID().replace(/-/g, '');

  const dup = await c.env.DB.prepare(
    `SELECT id FROM expense_categories WHERE lower(name) = lower(?) AND is_active = 1`
  ).bind(data.name.trim()).first();
  if (dup) return c.json({ error: 'Category name already exists' }, 409);

  await c.env.DB.prepare(
    `INSERT INTO expense_categories (id, name, description, default_vat_rate, is_active)
     VALUES (?, ?, ?, ?, 1)`
  ).bind(id, data.name.trim(), data.description ?? null, data.defaultVatRate ?? null).run();

  await writeAudit(c.env, {
    userId: user.id,
    action: 'expense_category.created',
    resourceType: 'expense_category',
    resourceId: id,
    newValues: data,
    ipAddress: c.req.header('CF-Connecting-IP'),
    userAgent: c.req.header('User-Agent'),
  });

  return c.json({ id }, 201);
});

router.put('/:id', requireRole('owner'), zValidator('json', CategorySchema), async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const data = c.req.valid('json');

  const existing = await c.env.DB.prepare(
    `SELECT id, name, description, default_vat_rate FROM expense_categories WHERE id = ? AND is_active = 1`
  ).bind(id).first<{ id: string; name: string; description: string | null; default_vat_rate: number | null }>();
  if (!existing) return c.json({ error: 'Not found' }, 404);

  const dup = await c.env.DB.prepare(
    `SELECT id FROM expense_categories
     WHERE lower(name) = lower(?) AND id != ? AND is_active = 1`
  ).bind(data.name.trim(), id).first();
  if (dup) return c.json({ error: 'Category name already exists' }, 409);

  await c.env.DB.prepare(
    `UPDATE expense_categories
     SET name = ?, description = ?,
         default_vat_rate = CASE WHEN ? THEN ? ELSE default_vat_rate END
     WHERE id = ?`
  ).bind(
    data.name.trim(), data.description ?? null,
    Object.hasOwn(data, 'defaultVatRate') ? 1 : 0, data.defaultVatRate ?? null, id,
  ).run();

  await writeAudit(c.env, {
    userId: user.id,
    action: 'expense_category.updated',
    resourceType: 'expense_category',
    resourceId: id,
    oldValues: { name: existing.name, description: existing.description, defaultVatRate: existing.default_vat_rate },
    newValues: data,
    ipAddress: c.req.header('CF-Connecting-IP'),
    userAgent: c.req.header('User-Agent'),
  });

  return c.json({ ok: true });
});

export { router as expenseCategoryRoutes };
