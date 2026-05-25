import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { requireRole } from '../middleware/rbac';
import type { Env } from '../types';

const router = new Hono<{ Bindings: Env }>();

const VendorSchema = z.object({
  name:    z.string().min(1).max(200),
  email:   z.string().email().optional().nullable(),
  phone:   z.string().max(30).optional().nullable(),
  address: z.string().max(500).optional().nullable(),
  tax_id:  z.string().max(50).optional().nullable(),
  notes:   z.string().max(1000).optional().nullable(),
});

router.get('/', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, name, email, phone, address, tax_id, notes, is_active, created_at
     FROM vendors WHERE is_active = 1 ORDER BY name ASC`
  ).all();
  return c.json(rows.results);
});

router.get('/:id', async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT id, name, email, phone, address, tax_id, notes, is_active, created_at
     FROM vendors WHERE id = ?`
  ).bind(c.req.param('id')).first();
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json(row);
});

router.post('/', requireRole('owner'), zValidator('json', VendorSchema), async (c) => {
  const user = c.get('user');
  const data = c.req.valid('json');
  const id = crypto.randomUUID().replace(/-/g, '');

  await c.env.DB.prepare(
    `INSERT INTO vendors (id, name, email, phone, address, tax_id, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, data.name, data.email ?? null, data.phone ?? null, data.address ?? null,
    data.tax_id ?? null, data.notes ?? null, user.id).run();

  return c.json({ id }, 201);
});

router.patch('/:id', requireRole('owner'), zValidator('json', VendorSchema.partial()), async (c) => {
  const id = c.req.param('id');
  const data = c.req.valid('json');

  const existing = await c.env.DB.prepare('SELECT id FROM vendors WHERE id = ?').bind(id).first();
  if (!existing) return c.json({ error: 'Not found' }, 404);

  const fields = Object.keys(data) as (keyof typeof data)[];
  if (fields.length === 0) return c.json({ error: 'No fields to update' }, 400);

  const sets = fields.map(f => `${f} = ?`).join(', ');
  const values = fields.map(f => data[f] ?? null);

  await c.env.DB.prepare(`UPDATE vendors SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(...values, id).run();

  return c.json({ ok: true });
});

router.put('/:id', requireRole('owner'), zValidator('json', VendorSchema), async (c) => {
  const id = c.req.param('id');
  const data = c.req.valid('json');

  const existing = await c.env.DB.prepare('SELECT id FROM vendors WHERE id = ?').bind(id).first();
  if (!existing) return c.json({ error: 'Not found' }, 404);

  await c.env.DB.prepare(
    `UPDATE vendors
     SET name = ?, email = ?, phone = ?, address = ?, tax_id = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).bind(
    data.name, data.email ?? null, data.phone ?? null, data.address ?? null, data.tax_id ?? null, data.notes ?? null, id
  ).run();

  return c.json({ ok: true });
});

router.delete('/:id', requireRole('owner'), async (c) => {
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare('SELECT id FROM vendors WHERE id = ?').bind(id).first();
  if (!existing) return c.json({ error: 'Not found' }, 404);

  await c.env.DB.prepare(`UPDATE vendors SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(id).run();

  return c.json({ ok: true });
});

export { router as vendorRoutes };
