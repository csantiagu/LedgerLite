import { Hono } from 'hono';
import { requireRole } from '../middleware/rbac';
import { writeAudit } from '../middleware/audit';
import { uploadToR2 } from '../services/r2';
import { parseBankCsv, type BankFormat } from '../services/csvParser';
import { autoSuggestMatches } from '../services/matchingService';
import { applyRules } from '../services/categorisationRules';
import type { Env } from '../types';
import type { AuthUser } from '../types';

const router = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();

router.post('/', requireRole('owner'), async (c) => {
  const user = c.get('user');
  const form = await c.req.formData();
  const bankAccountId = `${form.get('bankAccountId') ?? ''}`.trim();
  const file = form.get('file');

  if (!bankAccountId) return c.json({ error: 'bankAccountId is required' }, 400);
  if (!file || typeof file === 'string' || typeof (file as Blob).arrayBuffer !== 'function') {
    return c.json({ error: 'file is required' }, 400);
  }

  const account = await c.env.DB
    .prepare('SELECT id, csv_format, opening_balance FROM bank_accounts WHERE id = ? AND is_active = 1')
    .bind(bankAccountId)
    .first<{ id: string; csv_format: string; opening_balance: number }>();
  if (!account) return c.json({ error: 'Bank account not found' }, 404);

  const csvFormat = account.csv_format as BankFormat;
  const upload = file as File;
  const importId = crypto.randomUUID().replace(/-/g, '');
  const safeName = upload.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const key = `bank-imports/${importId}/${safeName}`;
  const bytes = await upload.arrayBuffer();

  await c.env.DB.prepare(`
    INSERT INTO bank_imports (id, filename, r2_key, imported_by, bank_account_id, status, row_count, new_row_count)
    VALUES (?, ?, ?, ?, ?, 'processing', 0, 0)
  `).bind(importId, upload.name, key, user.id, bankAccountId).run();

  try {
    // Stored as plain text whatever the browser claimed; it is only ever parsed, never served
    await uploadToR2(c.env.R2, key, bytes, 'text/plain');
    const csv = new TextDecoder().decode(bytes);
    const parsed = parseBankCsv(csv, csvFormat);

    // Auto-compute opening balance from CSV balance column if account still at default (0)
    // Sort ascending by date to find the earliest transaction
    let openingBalanceSet = false;
    if (account.opening_balance === 0 && parsed.length > 0) {
      const sorted = [...parsed].sort((a, b) => a.date.localeCompare(b.date));
      const firstWithBalance = sorted.find(t => t.balance !== null);
      if (firstWithBalance && firstWithBalance.balance !== null) {
        const computedOpening = firstWithBalance.balance - firstWithBalance.amount;
        await c.env.DB.prepare(
          'UPDATE bank_accounts SET opening_balance = ? WHERE id = ?'
        ).bind(computedOpening, bankAccountId).run();
        openingBalanceSet = true;
      }
    }

    const insertedIds: string[] = [];
    for (const tx of parsed) {
      const dup = await c.env.DB.prepare(
        `SELECT id FROM transactions
         WHERE date = ? AND description = ? AND amount = ?
           AND COALESCE(reference, '') = COALESCE(?, '')
         LIMIT 1`
      ).bind(tx.date, tx.description, tx.amount, tx.reference ?? null).first();
      if (dup) continue;

      const txId = crypto.randomUUID().replace(/-/g, '');
      await c.env.DB.prepare(`
        INSERT INTO transactions
          (id, import_id, bank_account_id, date, description, amount, balance, reference)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(txId, importId, bankAccountId, tx.date, tx.description, tx.amount, tx.balance ?? null, tx.reference ?? null).run();
      insertedIds.push(txId);
    }

    const rowCount = parsed.length;
    const newRowCount = insertedIds.length;

    await c.env.DB.prepare(
      `UPDATE bank_imports SET row_count = ?, new_row_count = ?, status = 'complete' WHERE id = ?`
    ).bind(rowCount, newRowCount, importId).run();

    const { suggested } = await autoSuggestMatches(c.env.DB, insertedIds);
    // Rules run after matching so invoice/bill suggestions take precedence
    const categorised = await applyRules(c.env.DB, insertedIds);

    await writeAudit(c.env, {
      userId: user.id,
      action: 'bank_import.created',
      resourceType: 'bank_import',
      resourceId: importId,
      newValues: { filename: upload.name, format: csvFormat, rowCount, newRowCount, suggested, categorised },
      ipAddress: c.req.header('CF-Connecting-IP'),
      userAgent: c.req.header('User-Agent'),
    });

    return c.json({ id: importId, rowCount, newRowCount, suggested, categorised, openingBalanceSet }, 201);
  } catch (err) {
    await c.env.DB.prepare(`UPDATE bank_imports SET status = 'error' WHERE id = ?`).bind(importId).run();
    throw err;
  }
});

router.get('/', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT bi.id, bi.filename, bi.row_count, bi.new_row_count, bi.status, bi.imported_at,
            bi.bank_account_id, ba.name as account_name,
            u.name as imported_by_name
     FROM bank_imports bi
     JOIN users u ON u.id = bi.imported_by
     LEFT JOIN bank_accounts ba ON ba.id = bi.bank_account_id
     ORDER BY bi.imported_at DESC`
  ).all<Record<string, unknown>>();
  return c.json(results);
});

router.get('/:id', async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    `SELECT bi.*, u.name as imported_by_name, ba.name as account_name
     FROM bank_imports bi
     JOIN users u ON u.id = bi.imported_by
     LEFT JOIN bank_accounts ba ON ba.id = bi.bank_account_id
     WHERE bi.id = ?`
  ).bind(id).first();
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json(row);
});

router.get('/:id/transactions', async (c) => {
  const id = c.req.param('id');
  const { results } = await c.env.DB.prepare(
    `SELECT t.id, t.date, t.description, t.amount, t.balance, t.reference,
            t.flagged, t.is_reconciled
     FROM transactions t
     WHERE t.import_id = ?
     ORDER BY t.date DESC, t.created_at DESC`
  ).bind(id).all<Record<string, unknown>>();
  return c.json(results);
});

export { router as bankImportRoutes };
