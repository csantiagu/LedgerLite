import { Hono } from 'hono';
import { z } from 'zod';
import { requireRole } from '../middleware/rbac';
import { actorOf, auditStatement } from '../middleware/audit';
import { isQuarterEnd, lockDate, nextQuarter, quarterFor, quartersBetween, today } from '../services/periods';
import { activeSnapshots, changesSinceLocked, snapshotStatements } from '../services/periodSnapshots';
import type { VatScheme } from '../services/vatReturn';
import type { Env } from '../types';

// VAT quarters and their locks. The accountant reviews a quarter and locks it, which is the one
// change an accountant can make; only the owner can unlock, and must say why.
const router = new Hono<{ Bindings: Env }>();

type LockRow = {
  id: string; period_start: string; period_end: string; locked_at: string; locked_by_name: string; note: string | null;
  unlocked_at: string | null; unlocked_by_name: string | null; unlock_reason: string | null;
};

const quarterEndMonth = async (db: D1Database) =>
  (await db.prepare('SELECT vat_quarter_end_month AS m FROM company_settings WHERE id = 1').first<{ m: number }>())?.m ?? 3;

/** The first dated record in the books, or null when there is none. */
async function firstDate(db: D1Database): Promise<string | null> {
  const earliest = await db.prepare(`
    SELECT MIN(d) AS d FROM (
      SELECT MIN(date) AS d FROM transactions
      UNION ALL SELECT MIN(issue_date) FROM invoices WHERE status != 'void'
      UNION ALL SELECT MIN(issue_date) FROM bills WHERE status != 'void')
  `).first<{ d: string | null }>();
  return earliest?.d ?? null;
}

/** Where the quarter list starts: the first dated record in the books, or three years ago if later. */
async function booksStart(db: D1Database, now: string): Promise<string> {
  const first = await firstDate(db);
  const threeYearsBack = `${Number(now.slice(0, 4)) - 3}${now.slice(4)}`;
  return first && first > threeYearsBack ? first : threeYearsBack;
}

// GET /api/v1/periods — the quarters since the books start (up to three years back), newest first,
// with their lock status and how many bank lines in each are still waiting in For Review
router.get('/', async (c) => {
  const db = c.env.DB;
  const [endMonth, lock] = await Promise.all([quarterEndMonth(db), lockDate(db)]);
  const now = today();

  const from = await booksStart(db, now);
  const [unposted, locks] = await db.batch([
    db.prepare('SELECT date, COUNT(*) AS n FROM transactions WHERE is_reconciled = 0 GROUP BY date'),
    db.prepare(`
      SELECT pl.id, pl.period_start, pl.period_end, pl.locked_at, lu.name AS locked_by_name, pl.note,
             pl.unlocked_at, uu.name AS unlocked_by_name, pl.unlock_reason
      FROM period_locks pl
      JOIN users lu ON lu.id = pl.locked_by
      LEFT JOIN users uu ON uu.id = pl.unlocked_by
      ORDER BY pl.locked_at DESC, pl.rowid DESC
    `),
  ]);
  const lockRows = locks!.results as LockRow[];
  const active = lockRows.filter(l => !l.unlocked_at);

  // Figures as locked, and which reviewed quarters have moved since
  const snapshots = await activeSnapshots(db);
  const changes = await changesSinceLocked(db, [...snapshots.values()]);

  const quarters = quartersBetween(from, now, endMonth).reverse().map(q => {
    const locked = !!lock && q.end <= lock;
    // The lock that covers it: the active one with the earliest end on or after this quarter's end
    const coveredBy = locked
      ? active.filter(l => l.period_end >= q.end).sort((a, b) => a.period_end.localeCompare(b.period_end))[0]
      : undefined;
    return {
      ...q,
      status: locked ? 'locked' : q.end < now ? 'ended' : 'current',
      unposted: (unposted!.results as Array<{ date: string; n: number }>)
        .filter(r => r.date >= q.start && r.date <= q.end).reduce((sum, r) => sum + r.n, 0),
      lock: coveredBy ?? null,
      snapshot: locked ? snapshots.get(q.end) ?? null : null,
      changedSinceLocked: locked ? changes.get(q.end) ?? [] : [],
    };
  });

  return c.json({ lockDate: lock, quarterEndMonth: endMonth, quarters, history: lockRows });
});

// POST /api/v1/periods/lock — lock a quarter that has ended, and everything before it
router.post('/lock', requireRole('owner', 'accountant'), async (c) => {
  const parsed = z.object({
    periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    note: z.string().trim().max(1000).optional(),
  }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const { periodEnd, note } = parsed.data;
  const db = c.env.DB;

  const endMonth = await quarterEndMonth(db);
  if (!isQuarterEnd(periodEnd, endMonth)) return c.json({ error: 'That date is not the end of a VAT quarter' }, 400);
  if (periodEnd >= today()) return c.json({ error: 'A quarter can only be locked once it has ended' }, 422);
  const lock = await lockDate(db);
  if (lock && periodEnd <= lock) return c.json({ error: 'That quarter is already locked' }, 409);

  // Lines still in For Review would be stuck: they could never be posted into a locked period
  const waiting = (await db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE is_reconciled = 0 AND date <= ?')
    .bind(periodEnd).first<{ n: number }>())!.n;
  if (waiting) {
    return c.json({
      error: `${waiting} bank line${waiting === 1 ? ' dated' : 's dated'} on or before the quarter end ${waiting === 1 ? 'is' : 'are'} still in For Review. Post ${waiting === 1 ? 'it' : 'them'} first.`,
      unposted: waiting,
    }, 409);
  }

  const quarter = quarterFor(periodEnd, endMonth);
  const id = crypto.randomUUID().replace(/-/g, '');
  // The figures of every quarter this lock newly covers, as they stand now
  const scheme = (await db.prepare('SELECT vat_scheme FROM company_settings WHERE id = 1')
    .first<{ vat_scheme: VatScheme }>())?.vat_scheme ?? 'standard';
  // (snapshotStatements keeps the newest few when that's many quarters)
  const firstNew = lock
    ? nextQuarter(quarterFor(lock, endMonth), endMonth).start
    : [await firstDate(db), quarter.start].filter((d): d is string => !!d).sort()[0]!;
  const snapshots = await snapshotStatements(db, id, quartersBetween(firstNew, periodEnd, endMonth), scheme);
  // Only lands while no active lock reaches this far, so two people locking at once can't both
  const fresh = {
    sql: `NOT EXISTS (SELECT 1 FROM period_locks WHERE unlocked_at IS NULL AND period_end >= ?)
          AND NOT EXISTS (SELECT 1 FROM transactions WHERE is_reconciled = 0 AND date <= ?)`,
    binds: [periodEnd, periodEnd],
  };
  const [audited] = await db.batch([
    auditStatement(db, actorOf(c), {
      action: 'period.locked', resourceType: 'period_lock', resourceId: id,
      oldValues: { lockDate: lock }, newValues: { lockDate: periodEnd, quarter: quarter.label, note: note ?? null },
      summary: `Locked ${quarter.label}${lock ? '' : ' and everything before it'}`,
    }, fresh),
    db.prepare(`
      INSERT INTO period_locks (id, period_start, period_end, locked_by, note)
      SELECT ?, ?, ?, ?, ? WHERE ${fresh.sql}
    `).bind(id, quarter.start, periodEnd, c.get('user').id, note || null, ...fresh.binds),
    ...snapshots,
  ]);
  if (!audited!.meta.changes) return c.json({ error: 'The periods changed meanwhile; refresh and try again' }, 409);
  return c.json({ id, lockDate: periodEnd }, 201);
});

// POST /api/v1/periods/unlock — reopen the latest locked quarter (owner only, with a reason)
router.post('/unlock', requireRole('owner'), async (c) => {
  const parsed = z.object({ reason: z.string().trim().min(3, 'Say why the quarter is being reopened').max(1000) })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, 400);
  const db = c.env.DB;

  const latest = await db.prepare(`
    SELECT id, period_start, period_end FROM period_locks WHERE unlocked_at IS NULL
    ORDER BY period_end DESC LIMIT 1
  `).first<{ id: string; period_start: string; period_end: string }>();
  if (!latest) return c.json({ error: 'Nothing is locked' }, 404);
  const previous = await db.prepare(
    'SELECT MAX(period_end) AS d FROM period_locks WHERE unlocked_at IS NULL AND id != ?'
  ).bind(latest.id).first<{ d: string | null }>();
  const label = quarterFor(latest.period_end, await quarterEndMonth(db)).label;

  const stillLatest = {
    sql: `EXISTS (SELECT 1 FROM period_locks WHERE id = ? AND unlocked_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM period_locks WHERE unlocked_at IS NULL AND period_end > ?)`,
    binds: [latest.id, latest.period_end],
  };
  const [audited] = await db.batch([
    auditStatement(db, actorOf(c), {
      action: 'period.unlocked', resourceType: 'period_lock', resourceId: latest.id,
      oldValues: { lockDate: latest.period_end }, newValues: { lockDate: previous?.d ?? null, reason: parsed.data.reason },
      summary: `Unlocked ${label}: ${parsed.data.reason}`,
    }, stillLatest),
    db.prepare(`
      UPDATE period_locks SET unlocked_at = datetime('now'), unlocked_by = ?, unlock_reason = ?
      WHERE id = ? AND ${stillLatest.sql}
    `).bind(c.get('user').id, parsed.data.reason, latest.id, ...stillLatest.binds),
  ]);
  if (!audited!.meta.changes) return c.json({ error: 'The periods changed meanwhile; refresh and try again' }, 409);
  return c.json({ ok: true, lockDate: previous?.d ?? null });
});

export { router as periodRoutes };
