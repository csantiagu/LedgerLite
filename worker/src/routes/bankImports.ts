import { Hono, type Context } from 'hono';
import { requireRole } from '../middleware/rbac';
import { actorOf, auditStatement } from '../middleware/audit';
import { uploadToR2 } from '../services/r2';
import { parseBankCsv, type BankFormat, type ParsedTransaction } from '../services/csvParser';
import { dateRange, newLines, type StatementLine } from '../services/importDedupe';
import { autoSuggestMatches } from '../services/matchingService';
import { applyRules } from '../services/categorisationRules';
import type { Env } from '../types';
import type { AuthUser } from '../types';

const router = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();

const LINES_PER_INSERT = 12;

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function alreadyImported(c: Context, previous: { id: string; imported_at: string; imported_by_name: string }) {
  return c.json({
    error: `This file was already imported on ${previous.imported_at.slice(0, 10)} by ${previous.imported_by_name}.`
      + ' Undo that import first if you want to bring it in again.',
    importId: previous.id,
  }, 409);
}

// Work on a line that undoing its import would throw away. A rule's category and the note it
// copies in don't count: importing the file again puts them back.
const BLOCK_REASONS_SQL = `
  t.is_reconciled AS posted,
  EXISTS (SELECT 1 FROM transaction_matches m WHERE m.transaction_id = t.id AND m.status IN ('pending','posted')) AS matched,
  t.attachment_r2_key IS NOT NULL AS receipt,
  (t.expense_category_id IS NOT NULL AND t.categorised_by_rule_id IS NULL AND t.category_auto = 0) AS categorised,
  COALESCE(t.notes, '') NOT IN ('', COALESCE((SELECT explanation FROM categorisation_rules WHERE id = t.categorised_by_rule_id), '')) AS noted,
  (t.flagged = 1 OR COALESCE(t.accountant_notes, '') != '') AS flagged`;
const BLOCKING_SQL = `(
  t.is_reconciled = 1
  OR EXISTS (SELECT 1 FROM transaction_matches m WHERE m.transaction_id = t.id AND m.status IN ('pending','posted'))
  OR t.attachment_r2_key IS NOT NULL
  OR (t.expense_category_id IS NOT NULL AND t.categorised_by_rule_id IS NULL AND t.category_auto = 0)
  OR COALESCE(t.notes, '') NOT IN ('', COALESCE((SELECT explanation FROM categorisation_rules WHERE id = t.categorised_by_rule_id), ''))
  OR t.flagged = 1 OR COALESCE(t.accountant_notes, '') != '')`;

type LineWithReasons = {
  id: string; date: string; description: string; amount: number;
  posted: number; matched: number; receipt: number; categorised: number; noted: number; flagged: number;
};

function blockReasons(l: LineWithReasons): string[] {
  return [
    l.posted && 'posted', l.matched && 'matched to an invoice or bill', l.receipt && 'has a receipt',
    l.categorised && 'category chosen by hand', l.noted && 'has notes', l.flagged && 'flagged or noted by the accountant',
  ].filter((r): r is string => !!r);
}

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
  const bytes = await upload.arrayBuffer();
  const sha = await sha256Hex(bytes);

  // The same file twice is refused outright (unless the earlier import was undone)
  const previous = await c.env.DB.prepare(`
    SELECT bi.id, bi.imported_at, u.name AS imported_by_name FROM bank_imports bi
    JOIN users u ON u.id = bi.imported_by
    WHERE bi.bank_account_id = ? AND bi.file_sha256 = ? AND bi.undone_at IS NULL
  `).bind(bankAccountId, sha).first<{ id: string; imported_at: string; imported_by_name: string }>();
  if (previous) return alreadyImported(c, previous);

  let parsed: ParsedTransaction[];
  try {
    parsed = parseBankCsv(new TextDecoder().decode(bytes), csvFormat);
  } catch (err) {
    return c.json({ error: `This file couldn't be read as a ${csvFormat} statement: ${(err as Error).message}` }, 400);
  }
  const range = dateRange(parsed);

  // Lines already in the books on the file's dates. Counting them (not just looking them up) keeps
  // genuine identical payments while dropping lines an earlier, overlapping file brought in.
  const existing = range ? (await c.env.DB.prepare(`
    SELECT date, description, amount, reference FROM transactions
    WHERE bank_account_id = ? AND date BETWEEN ? AND ?
  `).bind(bankAccountId, range.from, range.to).all<StatementLine>()).results : [];
  const { fresh, duplicates } = newLines(parsed, existing);

  // Earlier imports covering some of the same dates, so the owner knows why lines were skipped
  const overlaps = range ? (await c.env.DB.prepare(`
    SELECT bi.id, bi.filename, bi.imported_at, MIN(t.date) AS first_date, MAX(t.date) AS last_date
    FROM bank_imports bi JOIN transactions t ON t.import_id = bi.id
    WHERE bi.bank_account_id = ? AND bi.undone_at IS NULL
    GROUP BY bi.id
    HAVING MIN(t.date) <= ? AND MAX(t.date) >= ?
    ORDER BY bi.imported_at
  `).bind(bankAccountId, range.to, range.from).all<{
    id: string; filename: string; imported_at: string; first_date: string; last_date: string;
  }>()).results : [];

  const importId = crypto.randomUUID().replace(/-/g, '');
  const safeName = upload.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const key = `bank-imports/${importId}/${safeName}`;
  // Stored as plain text whatever the browser claimed; it is only ever parsed, never served
  await uploadToR2(c.env.R2, key, bytes, 'text/plain');

  const actor = actorOf(c);
  const db = c.env.DB;
  const rows = fresh.map(tx => ({ ...tx, id: crypto.randomUUID().replace(/-/g, '') }));
  const statements: D1PreparedStatement[] = [
    db.prepare(`
      INSERT INTO bank_imports
        (id, filename, r2_key, imported_by, bank_account_id, status, row_count, new_row_count, file_sha256)
      VALUES (?, ?, ?, ?, ?, 'complete', ?, ?, ?)
    `).bind(importId, upload.name, key, user.id, bankAccountId, parsed.length, rows.length, sha),
  ];

  // An account still at the default opening balance gets it from the earliest line with a balance
  const firstWithBalance = [...parsed].sort((a, b) => a.date.localeCompare(b.date)).find(t => t.balance !== null);
  const openingBalanceSet = account.opening_balance === 0 && !!firstWithBalance;
  if (openingBalanceSet) {
    const computedOpening = firstWithBalance!.balance! - firstWithBalance!.amount;
    statements.push(
      db.prepare('UPDATE bank_accounts SET opening_balance = ? WHERE id = ? AND opening_balance = 0')
        .bind(computedOpening, bankAccountId),
      auditStatement(db, actor, {
        action: 'bank_account.updated', resourceType: 'bank_account', resourceId: bankAccountId,
        oldValues: { openingBalance: 0 }, newValues: { openingBalance: computedOpening },
        summary: `Opening balance set from ${upload.name}`,
      }),
    );
  }

  // Several lines per INSERT (8 values each, under D1's 100 bound values per statement)
  for (let i = 0; i < rows.length; i += LINES_PER_INSERT) {
    const chunk = rows.slice(i, i + LINES_PER_INSERT);
    statements.push(db.prepare(`
      INSERT INTO transactions (id, import_id, bank_account_id, date, description, amount, balance, reference)
      VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}
    `).bind(...chunk.flatMap(tx => [
      tx.id, importId, bankAccountId, tx.date, tx.description, tx.amount, tx.balance ?? null, tx.reference ?? null,
    ])));
  }

  statements.push(auditStatement(db, actor, {
    action: 'bank_import.created', resourceType: 'bank_import', resourceId: importId,
    newValues: {
      filename: upload.name, bankAccountId, format: csvFormat, rowCount: parsed.length, newRowCount: rows.length,
      skipped: duplicates.length, transactionIds: rows.map(r => r.id),
    },
    summary: `Imported ${rows.length} new line${rows.length === 1 ? '' : 's'} from ${upload.name}`
      + (duplicates.length ? ` (${duplicates.length} already in the books)` : ''),
  }));

  // One batch: the import, every line and the audit row land together, or nothing does
  try {
    await db.batch(statements);
  } catch (err) {
    if (/UNIQUE constraint failed: bank_imports\./.test(String(err))) {
      const winner = await c.env.DB.prepare(`
        SELECT bi.id, bi.imported_at, u.name AS imported_by_name FROM bank_imports bi
        JOIN users u ON u.id = bi.imported_by
        WHERE bi.bank_account_id = ? AND bi.file_sha256 = ? AND bi.undone_at IS NULL
      `).bind(bankAccountId, sha).first<{ id: string; imported_at: string; imported_by_name: string }>();
      if (winner) return alreadyImported(c, winner);
    }
    throw err;
  }

  const insertedIds = rows.map(r => r.id);
  const { suggested } = await autoSuggestMatches(db, insertedIds);
  // Rules run after matching so invoice/bill suggestions take precedence
  const categorised = await applyRules(db, insertedIds, actor);

  return c.json({
    id: importId, rowCount: parsed.length, newRowCount: rows.length, skipped: duplicates.length,
    overlaps, suggested, categorised, openingBalanceSet,
  }, 201);
});

// POST /:id/undo — take back an import made by mistake: its lines are deleted and the file can be
// imported again. Refused while any of its lines has been worked on (posted, matched, a receipt,
// a category or notes set by hand, or the accountant's flag or notes), so no work is lost.
router.post('/:id/undo', requireRole('owner'), async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;
  const imp = await db.prepare('SELECT id, filename, undone_at FROM bank_imports WHERE id = ?')
    .bind(id).first<{ id: string; filename: string; undone_at: string | null }>();
  if (!imp) return c.json({ error: 'Not found' }, 404);
  if (imp.undone_at) return c.json({ error: 'This import was already undone' }, 409);

  const { results: lines } = await db.prepare(`
    SELECT t.id, t.date, t.description, t.amount, ${BLOCK_REASONS_SQL}
    FROM transactions t WHERE t.import_id = ? ORDER BY t.date, t.rowid
  `).bind(id).all<LineWithReasons>();
  const blocked = lines
    .map(l => ({ id: l.id, date: l.date, description: l.description, amount: l.amount, reasons: blockReasons(l) }))
    .filter(l => l.reasons.length);
  if (blocked.length) {
    return c.json({
      error: `${blocked.length} line${blocked.length === 1 ? ' from this import has' : 's from this import have'} been worked on. `
        + 'Undo or clear those first, or leave the import.',
      blocked,
    }, 409);
  }

  // Every statement re-checks that nothing was worked on meanwhile, so it all happens or none of it
  const untouched = `NOT EXISTS (SELECT 1 FROM transactions t WHERE t.import_id = ? AND ${BLOCKING_SQL})`;
  const results = await db.batch([
    auditStatement(db, actorOf(c), {
      action: 'bank_import.undone', resourceType: 'bank_import', resourceId: id,
      oldValues: { lines: lines.map(({ id: lineId, date, description, amount }) => ({ id: lineId, date, description, amount })) },
      newValues: { undone: true },
      summary: `Undid the import of ${imp.filename} (${lines.length} line${lines.length === 1 ? '' : 's'} removed)`,
    }, { sql: `${untouched} AND EXISTS (SELECT 1 FROM bank_imports WHERE id = ? AND undone_at IS NULL)`, binds: [id, id] }),
    db.prepare(`
      DELETE FROM transaction_matches
      WHERE transaction_id IN (SELECT id FROM transactions WHERE import_id = ?) AND ${untouched}
    `).bind(id, id),
    db.prepare(`DELETE FROM transactions WHERE import_id = ? AND ${untouched}`).bind(id, id),
    db.prepare(`
      UPDATE bank_imports SET undone_at = datetime('now'), undone_by = ?
      WHERE id = ? AND undone_at IS NULL AND ${untouched}
    `).bind(c.get('user').id, id, id),
  ]);
  if (!results[3]!.meta.changes) {
    return c.json({ error: 'Lines from this import were changed meanwhile; refresh and try again' }, 409);
  }
  return c.json({ ok: true, removed: lines.length });
});

// GET /?bankAccountId= — the latest 100 imports, newest first
router.get('/', async (c) => {
  const accountId = c.req.query('bankAccountId');
  const { results } = await c.env.DB.prepare(
    `SELECT bi.id, bi.filename, bi.row_count, bi.new_row_count, bi.status, bi.imported_at,
            bi.bank_account_id, ba.name as account_name, bi.undone_at,
            u.name as imported_by_name, uu.name as undone_by_name,
            (SELECT MIN(date) FROM transactions WHERE import_id = bi.id) AS first_date,
            (SELECT MAX(date) FROM transactions WHERE import_id = bi.id) AS last_date
     FROM bank_imports bi
     JOIN users u ON u.id = bi.imported_by
     LEFT JOIN users uu ON uu.id = bi.undone_by
     LEFT JOIN bank_accounts ba ON ba.id = bi.bank_account_id
     ${accountId ? 'WHERE bi.bank_account_id = ?' : ''}
     ORDER BY bi.imported_at DESC, bi.rowid DESC
     LIMIT 100`
  ).bind(...(accountId ? [accountId] : [])).all<Record<string, unknown>>();
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
