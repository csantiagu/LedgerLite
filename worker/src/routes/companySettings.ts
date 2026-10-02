import { Hono } from 'hono';
import { z } from 'zod';
import type { Env, AuthUser } from '../types';
import { requireRole } from '../middleware/rbac';

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
  invoice_prefix:       z.string().min(1).max(20).optional(),
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

  await c.env.DB.prepare(
    `UPDATE company_settings SET ${sets.join(', ')} WHERE id = 1`
  ).bind(...vals).run();

  const updated = await c.env.DB.prepare('SELECT * FROM company_settings WHERE id = 1').first();
  return c.json(updated);
});

// POST /api/v1/settings/company/logo
router.post('/logo', requireRole('owner'), async (c) => {
  const form = await c.req.formData().catch(() => null);
  const file = form?.get('file') as File | null;
  if (!file) return c.json({ error: 'No file' }, 400);

  const ALLOWED = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];
  if (!ALLOWED.includes(file.type)) return c.json({ error: 'PNG, JPG, WebP or SVG only' }, 400);
  if (file.size > 2 * 1024 * 1024) return c.json({ error: 'Max 2 MB' }, 400);

  const ext = file.name.split('.').pop() ?? 'png';
  const key = `company/logo.${ext}`;
  await c.env.R2.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });

  await c.env.DB.prepare(
    `UPDATE company_settings SET logo_r2_key = ?, logo_filename = ?, updated_at = datetime('now') WHERE id = 1`
  ).bind(key, file.name).run();

  return c.json({ ok: true, logo_r2_key: key, logo_filename: file.name });
});

// GET /api/v1/settings/company/logo
router.get('/logo', async (c) => {
  const row = await c.env.DB.prepare('SELECT logo_r2_key, logo_filename FROM company_settings WHERE id = 1')
    .first<{ logo_r2_key: string | null; logo_filename: string | null }>();
  if (!row?.logo_r2_key) return c.json({ error: 'No logo' }, 404);

  const obj = await c.env.R2.get(row.logo_r2_key);
  if (!obj) return c.json({ error: 'Not found' }, 404);

  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType ?? 'image/png',
      'Cache-Control': 'public, max-age=3600',
    },
  });
});

export { router as companySettingsRoutes };
