import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { hashPassword, passwordIterations } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { writeAudit } from '../middleware/audit';

const users = new Hono<{ Bindings: Env }>();

users.get('/', async (c) => {
  const rows = await c.env.DB
    .prepare('SELECT id, email, name, role, is_active, created_at FROM users ORDER BY created_at')
    .all<{ id: string; email: string; name: string; role: string; is_active: number; created_at: string }>();
  return c.json(rows.results);
});

users.post('/', requireRole('owner'), async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({
    name:     z.string().min(1),
    email:    z.string().email(),
    password: z.string().min(8),
    role:     z.enum(['accountant']),
  }).safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const existing = await c.env.DB
    .prepare('SELECT id FROM users WHERE email = ?')
    .bind(parsed.data.email.toLowerCase())
    .first();
  if (existing) return c.json({ error: 'Email already in use' }, 409);

  const hash = await hashPassword(parsed.data.password, passwordIterations(c.env));
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    'INSERT INTO users (id, email, name, role, password_hash) VALUES (?,?,?,?,?)'
  ).bind(id, parsed.data.email.toLowerCase(), parsed.data.name, parsed.data.role, hash).run();

  await writeAudit(c.env, {
    userId: c.get('user').id,
    action: 'user.created', resourceType: 'user', resourceId: id,
    newValues: { email: parsed.data.email, role: parsed.data.role },
    ipAddress: c.req.header('CF-Connecting-IP'),
  });

  return c.json({ id, email: parsed.data.email, role: parsed.data.role }, 201);
});

users.patch('/:id', requireRole('owner'), async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ is_active: z.boolean() }).safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid body' }, 400);

  const user = await c.env.DB
    .prepare('SELECT id, role FROM users WHERE id = ?')
    .bind(c.req.param('id'))
    .first<{ id: string; role: string }>();
  if (!user) return c.json({ error: 'Not found' }, 404);
  if (user.role === 'owner') return c.json({ error: 'Cannot deactivate owner' }, 403);

  await c.env.DB.prepare('UPDATE users SET is_active = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .bind(parsed.data.is_active ? 1 : 0, c.req.param('id')).run();

  await writeAudit(c.env, {
    userId: c.get('user').id,
    action: 'user.updated', resourceType: 'user', resourceId: user.id,
    newValues: { is_active: parsed.data.is_active },
    ipAddress: c.req.header('CF-Connecting-IP'),
  });

  return c.json({ ok: true });
});

export default users;
