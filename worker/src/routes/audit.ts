import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';

// Read-only view of the audit log for the owner and the accountant. Rows are written by
// `auditStatement` alongside each change, and the database refuses to edit or delete them.
const router = new Hono<{ Bindings: Env }>();

type AuditRow = {
  id: string; action: string; resource_type: string; resource_id: string | null;
  old_values: string | null; new_values: string | null; summary: string | null;
  user_id: string | null; user_name: string | null; api_key_id: string | null;
  ip_address: string | null; created_at: string;
};

const SELECT = `
  SELECT a.id, a.action, a.resource_type, a.resource_id, a.old_values, a.new_values, a.summary,
         a.user_id, u.name AS user_name, a.api_key_id, a.ip_address, a.created_at
  FROM audit_log a LEFT JOIN users u ON u.id = a.user_id`;

const parse = (row: AuditRow) => ({
  ...row,
  old_values: row.old_values ? JSON.parse(row.old_values) as unknown : null,
  new_values: row.new_values ? JSON.parse(row.new_values) as unknown : null,
});

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const ListQuery = z.object({
  resourceType: z.string().max(40).optional(),
  resourceId:   z.string().max(64).optional(),
  userId:       z.string().max(64).optional(),
  action:       z.string().max(60).optional(),
  from:         date.optional(),
  to:           date.optional(),
  page:         z.coerce.number().int().min(1).default(1),
  pageSize:     z.coerce.number().int().min(1).max(200).default(50),
});

// GET /api/v1/audit — the whole log, newest first. Filters: resourceType, resourceId, userId,
// action (exact, or a prefix ending in '.', e.g. 'invoice.'), from/to (dates, inclusive).
// Sign-in events are left out unless asked for with resourceType=user or action=auth.
router.get('/', async (c) => {
  const parsed = ListQuery.safeParse(c.req.query());
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const q = parsed.data;

  const where: string[] = [];
  const binds: unknown[] = [];
  if (q.resourceType) { where.push('a.resource_type = ?'); binds.push(q.resourceType); }
  if (q.resourceId)   { where.push('a.resource_id = ?');   binds.push(q.resourceId); }
  if (q.userId)       { where.push('a.user_id = ?');       binds.push(q.userId); }
  if (q.action?.endsWith('.')) { where.push('a.action LIKE ?'); binds.push(`${q.action.replace(/[%_]/g, '')}%`); }
  else if (q.action)  { where.push('a.action = ?');        binds.push(q.action); }
  else if (!q.resourceType) where.push(`a.action NOT LIKE 'auth.%'`);
  if (q.from) { where.push('a.created_at >= ?'); binds.push(q.from); }
  if (q.to)   { where.push(`a.created_at < date(?, '+1 day')`); binds.push(q.to); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [rows, count] = await c.env.DB.batch([
    c.env.DB.prepare(`${SELECT} ${whereSql} ORDER BY a.created_at DESC, a.rowid DESC LIMIT ? OFFSET ?`)
      .bind(...binds, q.pageSize, (q.page - 1) * q.pageSize),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_log a ${whereSql}`).bind(...binds),
  ]);
  return c.json({
    rows: (rows.results as AuditRow[]).map(parse),
    total: (count.results[0] as { n: number }).n,
    page: q.page, pageSize: q.pageSize,
  });
});

const RESOURCE_TYPES = ['invoice', 'bill', 'transaction', 'client', 'vendor', 'bank_account', 'expense_category', 'categorisation_rule'];

// GET /api/v1/audit/:type/:id — one record's history, oldest first. A bank line's history also
// shows the import that brought it in and any rule that categorised it, which are recorded once
// for many lines.
router.get('/:type/:id', async (c) => {
  const type = c.req.param('type');
  const id = c.req.param('id');
  if (!RESOURCE_TYPES.includes(type)) return c.json({ error: 'Unknown record type' }, 400);

  const sharedRows = type === 'transaction'
    ? ` OR (a.action IN ('bank_import.created', 'categorisation_rule.applied')
            AND EXISTS (SELECT 1 FROM json_each(a.new_values, '$.transactionIds') WHERE value = ?))`
    : '';
  const { results } = await c.env.DB.prepare(`
    ${SELECT}
    WHERE (a.resource_type = ? AND a.resource_id = ?)${sharedRows}
    ORDER BY a.created_at ASC, a.rowid ASC
    LIMIT 500
  `).bind(type, id, ...(sharedRows ? [id] : [])).all<AuditRow>();
  return c.json(results.map(parse));
});

export { router as auditRoutes };
