import { Hono } from 'hono';
import { requireRole } from '../middleware/rbac';
import { writeAudit } from '../middleware/audit';
import { uploadToR2 } from '../services/r2';
import { parseBankCsv, type BankFormat } from '../services/csvParser';
import type { Env } from '../types';

const router = new Hono<{ Bindings: Env }>();

function isBankFormat(v: string): v is BankFormat {
  return ['barclays', 'hsbc', 'lloyds', 'natwest', 'monzo', 'starling'].includes(v);
}

router.post('/', requireRole('owner'), async (c) => {
  const user = c.get('user');
  const form = await c.req.formData();
  const formatRaw = `${form.get('format') ?? ''}`.toLowerCase();
  const file = form.get('file');

  if (!isBankFormat(formatRaw)) return c.json({ error: 'Invalid format' }, 400);
  if (!file || typeof file === 'string' || typeof (file as Blob).arrayBuffer !== 'function') {
    return c.json({ error: 'file is required' }, 400);
  }

  const upload = file as File;
  const importId = crypto.randomUUID().replace(/-/g, '');
  const safeName = upload.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const key = `bank-imports/${importId}/${safeName}`;
  const bytes = await upload.arrayBuffer();

  await c.env.DB.prepare(
    `INSERT INTO bank_imports (id, filename, r2_key, imported_by, status, row_count)
     VALUES (?, ?, ?, ?, 'processing', 0)`
  ).bind(importId, upload.name, key, user.id).run();

  try {
    await uploadToR2(c.env.R2, key, bytes, upload.type || 'text/csv');
    const csv = new TextDecoder().decode(bytes);
    const parsed = parseBankCsv(csv, formatRaw);

    let inserted = 0;
    for (const tx of parsed) {
      const dup = await c.env.DB.prepare(
        `SELECT id FROM transactions
         WHERE date = ? AND description = ? AND amount = ?
           AND COALESCE(reference, '') = COALESCE(?, '')
         LIMIT 1`
      ).bind(tx.date, tx.description, tx.amount, tx.reference).first();
      if (dup) continue;

      await c.env.DB.prepare(
        `INSERT INTO transactions
          (id, import_id, date, description, amount, balance, reference)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        crypto.randomUUID().replace(/-/g, ''),
        importId,
        tx.date,
        tx.description,
        tx.amount,
        tx.balance,
        tx.reference
      ).run();
      inserted += 1;
    }

    await c.env.DB.prepare(
      `UPDATE bank_imports SET row_count = ?, status = 'complete' WHERE id = ?`
    ).bind(inserted, importId).run();

    await writeAudit(c.env, {
      userId: user.id,
      action: 'bank_import.created',
      resourceType: 'bank_import',
      resourceId: importId,
      newValues: { filename: upload.name, format: formatRaw, inserted },
      ipAddress: c.req.header('CF-Connecting-IP'),
      userAgent: c.req.header('User-Agent'),
    });

    return c.json({ id: importId, rowCount: inserted }, 201);
  } catch (err) {
    await c.env.DB.prepare(`UPDATE bank_imports SET status = 'error' WHERE id = ?`).bind(importId).run();
    throw err;
  }
});

router.get('/', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT bi.id, bi.filename, bi.row_count, bi.status, bi.imported_at,
            u.name as imported_by_name
     FROM bank_imports bi
     JOIN users u ON u.id = bi.imported_by
     ORDER BY bi.imported_at DESC`
  ).all();
  return c.json(rows.results);
});

router.get('/:id', async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    `SELECT bi.*, u.name as imported_by_name
     FROM bank_imports bi
     JOIN users u ON u.id = bi.imported_by
     WHERE bi.id = ?`
  ).bind(id).first();
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json(row);
});

router.get('/:id/transactions', async (c) => {
  const id = c.req.param('id');
  const rows = await c.env.DB.prepare(
    `SELECT t.id, t.date, t.description, t.amount, t.balance, t.reference,
            t.flagged, t.is_reconciled
     FROM transactions t
     WHERE t.import_id = ?
     ORDER BY t.date DESC, t.created_at DESC`
  ).bind(id).all();
  return c.json(rows.results);
});

export { router as bankImportRoutes };
