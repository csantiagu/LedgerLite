import { Hono } from 'hono';
import { z } from 'zod';
import type { Env, AuthUser } from '../types';
import { requireRole } from '../middleware/rbac';
import { actorOf, auditStatement, changedFields } from '../middleware/audit';
import { checkUpload, fileResponse, IMAGE_TYPES } from '../services/files';

const router = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();

const SettingsSchema = z.object({
  company_name:         z.string().max(200).optional(),
  company_reg_number:   z.string().max(50).optional(),
  vat_number:           z.string().max(50).optional(),
  address:              z.string().max(500).optional(),
  email:                z.string().email().max(200).optional(),
  phone:                z.string().max(50).optional(),
  bank_account_name:    z.string().max(200).optional(),
  bank_sort_code:       z.string().max(20).optional(),
  bank_account_number:  z.string().max(20).optional(),
  bank_name:            z.string().max(200).optional(),
  invoice_prefix:       z.string().max(20).regex(/^[A-Za-z0-9-]*$/, 'Letters, digits and dashes only').optional(),
  invoice_next_sequence: z.coerce.number().int().min(1).optional(),
});

// GET /api/v1/settings/company
router.get('/', async (c) => {
  const row = await c.env.DB.prepare('SELECT * FROM company_settings WHERE id = 1').first();
  return c.json(row ?? {});
});

// PATCH /api/v1/settings/company
router.patch('/', requireRole('owner'), async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = SettingsSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const d = parsed.data;
  const sets: string[] = ["updated_at = datetime('now')"];
  const vals: unknown[] = [];

  const fields: Array<[keyof typeof d, string]> = [
    ['company_name', 'company_name'],
    ['company_reg_number', 'company_reg_number'],
    ['vat_number', 'vat_number'],
    ['address', 'address'],
    ['email', 'email'],
    ['phone', 'phone'],
    ['bank_account_name', 'bank_account_name'],
    ['bank_sort_code', 'bank_sort_code'],
    ['bank_account_number', 'bank_account_number'],
    ['bank_name', 'bank_name'],
    ['invoice_prefix', 'invoice_prefix'],
    ['invoice_next_sequence', 'invoice_next_sequence'],
  ];

  for (const [key, col] of fields) {
    if (Object.hasOwn(d, key)) { sets.push(`${col} = ?`); vals.push(d[key] ?? null); }
  }

  const before = await c.env.DB.prepare('SELECT * FROM company_settings WHERE id = 1')
    .first<Record<string, unknown>>();
  const diff = changedFields(before ?? {}, d);
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE company_settings SET ${sets.join(', ')} WHERE id = 1`
    ).bind(...vals),
    ...(diff ? [auditStatement(c.env.DB, actorOf(c), {
      action: 'company.updated', resourceType: 'company_settings', ...diff,
      summary: `Changed ${Object.keys(diff.newValues).join(', ').replace(/_/g, ' ')}`,
    })] : []),
  ]);

  const updated = await c.env.DB.prepare('SELECT * FROM company_settings WHERE id = 1').first();
  return c.json(updated);
});

// PUT /api/v1/settings/company/migration — mark the QuickBooks migration complete (bank lines can
// then only be matched to open invoices and bills) or reopen it to link more old receipts
router.put('/migration', requireRole('owner'), async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ complete: z.boolean() }).safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const { complete } = parsed.data;

  // Keeps the first completion date if it's marked complete twice
  const [updated] = await c.env.DB.batch([
    c.env.DB.prepare(`
      UPDATE company_settings SET
        migration_completed_at = CASE WHEN ? THEN COALESCE(migration_completed_at, datetime('now')) END,
        updated_at = datetime('now')
      WHERE id = 1 RETURNING migration_completed_at
    `).bind(complete ? 1 : 0),
    auditStatement(c.env.DB, actorOf(c), {
      action: complete ? 'company.migration_completed' : 'company.migration_reopened',
      resourceType: 'company_settings',
      newValues: { complete },
      summary: complete ? 'Marked the QuickBooks migration complete' : 'Reopened the QuickBooks migration',
    }),
  ]);
  const row = updated.results[0] as { migration_completed_at: string | null } | undefined;

  return c.json({ migration_completed_at: row?.migration_completed_at ?? null });
});

// POST /api/v1/settings/company/logo
router.post('/logo', requireRole('owner'), async (c) => {
  const form = await c.req.formData().catch(() => null);
  const checked = await checkUpload(form?.get('file') ?? null, IMAGE_TYPES, 2 * 1024 * 1024);
  if (!checked.ok) return c.json({ error: checked.error }, 400);
  const file = { name: checked.name };
  // A new key every upload, so invoices restored from a backup still find the logo they were drawn with
  const key = `company/logo-${Date.now()}.${checked.ext}`;
  await c.env.R2.put(key, checked.bytes, { httpMetadata: { contentType: checked.type } });

  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE company_settings SET logo_r2_key = ?, logo_filename = ?, updated_at = datetime('now') WHERE id = 1`
    ).bind(key, file.name),
    auditStatement(c.env.DB, actorOf(c), {
      action: 'company.updated', resourceType: 'company_settings',
      newValues: { logo: file.name, key }, summary: 'Changed the logo',
    }),
  ]);

  return c.json({ ok: true, logo_r2_key: key, logo_filename: file.name });
});

// GET /api/v1/settings/company/logo
router.get('/logo', async (c) => {
  const row = await c.env.DB.prepare('SELECT logo_r2_key, logo_filename FROM company_settings WHERE id = 1')
    .first<{ logo_r2_key: string | null; logo_filename: string | null }>();
  if (!row?.logo_r2_key) return c.json({ error: 'No logo' }, 404);

  const obj = await c.env.R2.get(row.logo_r2_key);
  if (!obj) return c.json({ error: 'Not found' }, 404);

  return fileResponse(obj.body, obj.httpMetadata?.contentType, row.logo_filename ?? 'logo');
});

export { router as companySettingsRoutes };
