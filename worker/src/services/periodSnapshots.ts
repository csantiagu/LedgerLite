// The VAT return figures a quarter had when it was locked, and what has changed since. Credit
// notes, voids and VAT-only invoices may still be dated in a reviewed quarter (that is how a filed
// return is corrected), so the snapshot is what shows the quarter moved after it was submitted.
import type { Quarter } from './periods';
import { vatReturn, type VatBoxes, type VatScheme } from './vatReturn';

export const BOX_KEYS = ['box1', 'box2', 'box3', 'box4', 'box5', 'box6', 'box7', 'box8', 'box9'] as const;

/** Snapshots at most this many quarters per lock (the newest), to stay within D1's per-request queries. */
export const MAX_SNAPSHOT_QUARTERS = 8;

export type Snapshot = { period_start: string; period_end: string; scheme: VatScheme; boxes: VatBoxes; taken_at: string };
export type BoxChange = { box: (typeof BOX_KEYS)[number]; before: number; now: number };

export const pickBoxes = (r: VatBoxes): VatBoxes =>
  Object.fromEntries(BOX_KEYS.map(k => [k, r[k]])) as VatBoxes;

/** The boxes that differ between the snapshot and now. */
export function boxChanges(before: VatBoxes, now: VatBoxes): BoxChange[] {
  return BOX_KEYS.filter(k => before[k] !== now[k]).map(box => ({ box, before: before[box], now: now[box] }));
}

/** INSERTs that store each quarter's figures as they stand, written only if the lock row `lockId` is. */
export async function snapshotStatements(
  db: D1Database, lockId: string, quarters: Quarter[], scheme: VatScheme,
): Promise<D1PreparedStatement[]> {
  const newest = quarters.slice(-MAX_SNAPSHOT_QUARTERS);
  const figures = await Promise.all(newest.map(q => vatReturn(db, q.start, q.end, scheme)));
  return newest.map((q, i) => db.prepare(`
    INSERT INTO period_snapshots (period_lock_id, period_start, period_end, scheme, boxes)
    SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM period_locks WHERE id = ?)
  `).bind(lockId, q.start, q.end, scheme, JSON.stringify(pickBoxes(figures[i]!)), lockId));
}

/** The latest snapshot of each quarter (by its end date) still covered by an active lock. */
export async function activeSnapshots(db: D1Database): Promise<Map<string, Snapshot>> {
  const { results } = await db.prepare(`
    SELECT s.period_start, s.period_end, s.scheme, s.boxes, s.taken_at
    FROM period_snapshots s JOIN period_locks l ON l.id = s.period_lock_id
    WHERE l.unlocked_at IS NULL
    ORDER BY s.taken_at ASC, s.rowid ASC
  `).all<Omit<Snapshot, 'boxes'> & { boxes: string }>();
  const out = new Map<string, Snapshot>();
  for (const r of results) out.set(r.period_end, { ...r, boxes: JSON.parse(r.boxes) as VatBoxes });
  return out;
}

/**
 * Which snapshotted quarters' figures have changed since they were locked. Only quarters where
 * something that can still move them happened after the snapshot (an invoice or credit note dated
 * in the quarter created, voided or edited, or a category or VAT setting changed) are worked out
 * again, so the periods page stays cheap.
 */
export async function changesSinceLocked(db: D1Database, snapshots: Snapshot[]): Promise<Map<string, BoxChange[]>> {
  const out = new Map<string, BoxChange[]>();
  if (!snapshots.length) return out;
  const touched = await db.batch(snapshots.map(s => db.prepare(`
    -- >=: timestamps are to the second, so a change in the same second as the lock still counts
    -- (working the figures out again when nothing moved only costs a few queries)
    SELECT EXISTS (SELECT 1 FROM invoices
                   WHERE issue_date BETWEEN ? AND ? AND status != 'draft' AND updated_at >= ?)
        OR EXISTS (SELECT 1 FROM audit_log
                   WHERE action IN ('expense_category.updated', 'company.updated') AND created_at >= ?) AS touched
  `).bind(s.period_start, s.period_end, s.taken_at, s.taken_at)));
  const recheck = snapshots.filter((_, i) => (touched[i]!.results[0] as { touched: number }).touched);
  const now = await Promise.all(recheck.map(s => vatReturn(db, s.period_start, s.period_end, s.scheme)));
  recheck.forEach((s, i) => {
    const changes = boxChanges(s.boxes, pickBoxes(now[i]!));
    if (changes.length) out.set(s.period_end, changes);
  });
  return out;
}
