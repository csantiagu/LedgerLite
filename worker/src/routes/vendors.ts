import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { requireRole } from '../middleware/rbac';
import { actorOf, auditStatement, changedFields } from '../middleware/audit';
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

const COLUMNS = 'id, name, email, phone, address, tax_id, notes, is_active, created_at';

router.get('/', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT ${COLUMNS} FROM vendors WHERE is_active = 1 ORDER BY name ASC`
  ).all();
  return c.json(rows.results);
});

router.get('/:id', async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT ${COLUMNS} FROM vendors WHERE id = ?`
  ).bind(c.req.param('id')).first();
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json(row);
});

router.post('/', requireRole('owner'), zValidator('json', VendorSchema), async (c) => {
  const user = c.get('user');
  const data = c.req.valid('json');
  const id = crypto.randomUUID().replace(/-/g, '');

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO vendors (id, name, email, phone, address, tax_id, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, data.name, data.email ?? null, data.phone ?? null, data.address ?? null,
      data.tax_id ?? null, data.notes ?? null, user.id),
    auditStatement(c.env.DB, actorOf(c), {
      action: 'vendor.created', resourceType: 'vendor', resourceId: id, newValues: data,
      summary: `Added ${data.name}`,
    }),
  ]);

  return c.json({ id }, 201);
});

router.patch('/:id', requireRole('owner'), zValidator('json', VendorSchema.partial()), async (c) => {
  const id = c.req.param('id');
  const data = c.req.valid('json');

  const existing = await c.env.DB.prepare(`SELECT ${COLUMNS} FROM vendors WHERE id = ?`).bind(id)
    .first<Record<string, unknown>>();
  if (!existing) return c.json({ error: 'Not found' }, 404);

  const fields = Object.keys(data) as (keyof typeof data)[];
  if (fields.length === 0) return c.json({ error: 'No fields to update' }, 400);

  const sets = fields.map(f => `${f} = ?`).join(', ');
  const values = fields.map(f => data[f] ?? null);

  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE vendors SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(...values, id),
    ...updateAudit(c, id, existing, data),
  ]);

  return c.json({ ok: true });
});

router.put('/:id', requireRole('owner'), zValidator('json', VendorSchema), async (c) => {
  const id = c.req.param('id');
  const data = c.req.valid('json');

  const existing = await c.env.DB.prepare(`SELECT ${COLUMNS} FROM vendors WHERE id = ?`).bind(id)
    .first<Record<string, unknown>>();
  if (!existing) return c.json({ error: 'Not found' }, 404);

  const row = {
    name: data.name, email: data.email ?? null, phone: data.phone ?? null, address: data.address ?? null,
    tax_id: data.tax_id ?? null, notes: data.notes ?? null,
  };
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE vendors
       SET name = ?, email = ?, phone = ?, address = ?, tax_id = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).bind(row.name, row.email, row.phone, row.address, row.tax_id, row.notes, id),
    ...updateAudit(c, id, existing, row),
  ]);

  return c.json({ ok: true });
});

router.delete('/:id', requireRole('owner'), async (c) => {
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare('SELECT id, name, is_active FROM vendors WHERE id = ?').bind(id)
    .first<{ id: string; name: string; is_active: number }>();
  if (!existing) return c.json({ error: 'Not found' }, 404);

  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE vendors SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(id),
    ...(existing.is_active ? [auditStatement(c.env.DB, actorOf(c), {
      action: 'vendor.deactivated', resourceType: 'vendor', resourceId: id,
      oldValues: { is_active: true }, newValues: { is_active: false },
      summary: `Deactivated ${existing.name}`,
    })] : []),
  ]);

  return c.json({ ok: true });
});

function updateAudit(
  c: Parameters<typeof actorOf>[0], id: string, before: Record<string, unknown>, after: Record<string, unknown>,
): D1PreparedStatement[] {
  const diff = changedFields(before, after);
  return diff ? [auditStatement(c.env.DB, actorOf(c), {
    action: 'vendor.updated', resourceType: 'vendor', resourceId: id, ...diff,
    summary: `Edited ${Object.keys(diff.newValues).join(', ').replace(/_/g, ' ')}`,
  })] : [];
}

export { router as vendorRoutes };
