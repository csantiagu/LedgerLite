// Posting bank lines out of For Review, and sending them back (undo), like QuickBooks' bank feed.
// A line is posted when is_reconciled = 1. Posting turns its pending invoice/bill matches into
// payments; undoing deletes those payments again and reopens the invoices/bills they paid.

import { isOpenTarget, paymentIdFor, planPost, type PostCandidate } from './matchAllocation';

export type Fail = { ok: false; status: 400 | 404 | 409 | 422; error: string };

export const debtorsControlCategory = (db: D1Database) => db.prepare(
  `SELECT id FROM expense_categories WHERE LOWER(name) = 'debtors control account' LIMIT 1`
).first<{ id: string }>();

/**
 * SQL SET fragment that fills an empty category from a match and remembers it was filled that way
 * (category_auto), so undo/unlink can clear it again. Binds: the category id, twice.
 */
export const FILL_CATEGORY_SQL = `
  category_auto = CASE WHEN expense_category_id IS NULL AND ? IS NOT NULL THEN 1 ELSE category_auto END,
  expense_category_id = COALESCE(expense_category_id, ?)`;

/** SQL SET fragment that clears a category only if a match filled it in. */
export const CLEAR_AUTO_CATEGORY_SQL = `
  expense_category_id = CASE WHEN category_auto = 1 THEN NULL ELSE expense_category_id END,
  category_auto = 0`;

/**
 * Turns pending matches that all point at one invoice or bill into a single payment, fills in the
 * lines' category if they have none, and marks the matches posted. It doesn't post the bank lines
 * themselves: callers decide that.
 */
export async function postPaymentMatches(db: D1Database, userId: string, matchIds: string[]): Promise<
  { ok: true; paymentId: string; type: 'invoice' | 'bill'; targetId: string; total: number; transactionIds: string[] } | Fail
> {
  const { results: rows } = await db.prepare(`
    SELECT tm.id, tm.status, tm.invoice_id, tm.bill_id, tm.allocated_amount, tm.transaction_id,
           t.date, t.amount AS txn_amount, t.expense_category_id
    FROM transaction_matches tm JOIN transactions t ON tm.transaction_id = t.id
    WHERE tm.kind = 'payment' AND tm.id IN (${matchIds.map(() => '?').join(',')})
  `).bind(...matchIds).all<PostCandidate & { id: string; transaction_id: string; date: string }>();
  if (rows.length !== matchIds.length) return { ok: false, status: 404, error: 'One or more match IDs not found' };

  const plan = planPost(rows);
  if (!plan.ok) return plan;

  const target = await checkTarget(db, plan.type, plan.targetId, plan.total);
  if (!target.ok) return target;

  const paymentDate = rows.map(r => r.date).sort().at(-1)!;
  const paymentId   = await paymentIdFor(matchIds);

  // Invoices → Debtors Control Account; bills → the bill's first line category
  const autoCategory = plan.type === 'invoice'
    ? await debtorsControlCategory(db)
    : await db.prepare(
        `SELECT expense_category_id AS id FROM bill_items
         WHERE bill_id = ? AND expense_category_id IS NOT NULL ORDER BY rowid ASC LIMIT 1`
      ).bind(plan.targetId).first<{ id: string }>();
  const categoryId = autoCategory?.id ?? null;

  const [paymentTable, targetTable, targetCol, openStatuses] = plan.type === 'invoice'
    ? ['payments_received', 'invoices', 'invoice_id', `'sent','partial','overdue'`]
    : ['payments_made', 'bills', 'bill_id', `'pending','partial'`];
  // One D1 batch = one SQL transaction, and any failing statement rolls the whole batch back.
  // The payment insert is the guard: if the target is no longer open with enough balance it
  // inserts a NULL amount and fails NOT NULL; if these matches were already posted, the
  // deterministic paymentId fails the primary key. Either way nothing below it is applied.
  const statements: D1PreparedStatement[] = [
    db.prepare(`
      INSERT INTO ${paymentTable} (id, ${targetCol}, amount, payment_date, method, created_by)
      VALUES (?, ?, (
        SELECT ? FROM ${targetTable}
        WHERE id = ? AND status IN (${openStatuses}) AND total - amount_paid >= ?
      ), ?, 'bank_transfer', ?)
    `).bind(paymentId, plan.targetId, plan.total, plan.targetId, plan.total, paymentDate, userId),
    db.prepare(`
      UPDATE ${targetTable} SET
        amount_paid = amount_paid + ?,
        status = CASE WHEN amount_paid + ? >= total THEN 'paid' ELSE 'partial' END,
        updated_at = datetime('now')
      WHERE id = ?
    `).bind(plan.total, plan.total, plan.targetId),
  ];
  for (const r of rows) {
    statements.push(
      db.prepare(`
        UPDATE transaction_matches
        SET status = 'posted', posted_by = ?, posted_at = datetime('now'), payment_id = ?
        WHERE id = ?
      `).bind(userId, paymentId, r.id),
      db.prepare(`UPDATE transactions SET ${FILL_CATEGORY_SQL}, updated_at = datetime('now') WHERE id = ?`)
        .bind(categoryId, categoryId, r.transaction_id),
    );
  }

  try {
    await db.batch(statements);
  } catch (err) {
    const msg = String(err);
    if (msg.includes('UNIQUE constraint failed')) {
      return { ok: false, status: 409, error: 'These matches have already been posted' };
    }
    if (msg.includes('NOT NULL constraint failed')) {
      return { ok: false, status: 409, error: `The ${plan.type} changed while posting; refresh and try again` };
    }
    throw err;
  }

  return {
    ok: true, paymentId, type: plan.type, targetId: plan.targetId, total: plan.total,
    transactionIds: [...new Set(rows.map(r => r.transaction_id))],
  };
}

/** Whether an invoice/bill can still take a payment of `amount`. */
async function checkTarget(db: D1Database, type: 'invoice' | 'bill', targetId: string, amount: number): Promise<{ ok: true } | Fail> {
  const target = await db.prepare(
    type === 'invoice'
      ? 'SELECT status, total - amount_paid AS outstanding FROM invoices WHERE id = ?'
      : 'SELECT status, total - amount_paid AS outstanding FROM bills WHERE id = ?'
  ).bind(targetId).first<{ status: string; outstanding: number }>();
  if (!target) return { ok: false, status: 404, error: 'Invoice or bill not found' };
  if (!isOpenTarget(type, target.status)) {
    return { ok: false, status: 409, error: `This ${type} is ${target.status} and cannot take payments` };
  }
  if (amount > target.outstanding) {
    return { ok: false, status: 422, error: `Total allocated exceeds the outstanding balance of the ${type}` };
  }
  return { ok: true };
}

/** Marks bank lines posted (out of For Review) by this user. */
export const markPosted = (db: D1Database, userId: string, transactionId: string) => db.prepare(`
  UPDATE transactions
  SET is_reconciled = 1, reviewed_at = datetime('now'), reviewed_by = ?, updated_at = datetime('now')
  WHERE id = ? AND is_reconciled = 0
`).bind(userId, transactionId);

/** Suggestions nobody took up are dropped once a line is posted. */
export const dropSuggestions = (db: D1Database, transactionId: string) =>
  db.prepare(`DELETE FROM transaction_matches WHERE transaction_id = ? AND status = 'suggested'`).bind(transactionId);

export type LineState = {
  id: string; amount: number; is_reconciled: number; expense_category_id: string | null;
  pending: number; allocated: number;
};

const LINE_STATE_SQL = `
  SELECT t.id, t.amount, t.is_reconciled, t.expense_category_id,
    (SELECT COUNT(*) FROM transaction_matches WHERE transaction_id = t.id AND status = 'pending') AS pending,
    (SELECT COALESCE(SUM(allocated_amount), 0) FROM transaction_matches
      WHERE transaction_id = t.id AND status IN ('pending','posted')) AS allocated
  FROM transactions t`;

/** Why a line can't be posted yet, or null when it can. */
export function cannotPost(line: LineState): Fail | null {
  if (line.is_reconciled) return { ok: false, status: 409, error: 'This line is already posted' };
  if (line.expense_category_id) return null;
  if (!line.allocated) {
    return { ok: false, status: 422, error: 'Choose a category, or match it to an invoice or bill, before posting' };
  }
  // Without a category, the matches have to account for the whole line
  if (line.allocated < Math.abs(line.amount)) {
    return { ok: false, status: 422, error: 'Part of this line is not matched yet: match the rest, or choose a category' };
  }
  return null;
}

/**
 * Posts one bank line: each invoice/bill it's pending against becomes a payment, then the line
 * moves to All Transactions. A line needs a category or a match to be posted; suggestions that
 * weren't taken up are dropped.
 */
export async function postTransaction(db: D1Database, userId: string, transactionId: string): Promise<
  { ok: true; payments: Array<{ paymentId: string; type: 'invoice' | 'bill'; targetId: string; total: number }> } | Fail
> {
  const line = await db.prepare(`${LINE_STATE_SQL} WHERE t.id = ?`).bind(transactionId).first<LineState>();
  if (!line) return { ok: false, status: 404, error: 'Transaction not found' };
  const blocked = cannotPost(line);
  if (blocked) return blocked;

  // One payment per invoice/bill this line pays
  const { results: pending } = await db.prepare(
    `SELECT id, match_type, invoice_id, bill_id, allocated_amount FROM transaction_matches
     WHERE transaction_id = ? AND status = 'pending' AND kind = 'payment'`
  ).bind(transactionId).all<{ id: string; match_type: 'invoice' | 'bill'; invoice_id: string | null; bill_id: string | null; allocated_amount: number }>();
  const byTarget = new Map<string, { type: 'invoice' | 'bill'; ids: string[]; total: number }>();
  for (const m of pending) {
    const key = (m.invoice_id ?? m.bill_id)!;
    const group = byTarget.get(key) ?? { type: m.match_type, ids: [], total: 0 };
    group.ids.push(m.id);
    group.total += m.allocated_amount;
    byTarget.set(key, group);
  }
  // Check every invoice/bill first, so a line isn't left half-posted when one of them can't be paid
  for (const [targetId, group] of byTarget) {
    const check = await checkTarget(db, group.type, targetId, group.total);
    if (!check.ok) return check;
  }

  const payments: Array<{ paymentId: string; type: 'invoice' | 'bill'; targetId: string; total: number }> = [];
  for (const group of byTarget.values()) {
    const res = await postPaymentMatches(db, userId, group.ids);
    if (!res.ok) return res;
    payments.push({ paymentId: res.paymentId, type: res.type, targetId: res.targetId, total: res.total });
  }

  await db.batch([dropSuggestions(db, transactionId), markPosted(db, userId, transactionId)]);
  return { ok: true, payments };
}

/**
 * Posts several lines. Lines that only need a category or are fully linked are posted together in
 * one batch, keeping the number of D1 queries per request small; lines with pending matches go
 * through postTransaction one by one.
 */
export async function postTransactions(db: D1Database, userId: string, ids: string[]): Promise<
  { posted: string[]; failed: Array<{ id: string; error: string }> }
> {
  const { results: lines } = await db.prepare(
    `${LINE_STATE_SQL} WHERE t.id IN (${ids.map(() => '?').join(',')})`
  ).bind(...ids).all<LineState>();
  const byId = new Map(lines.map(l => [l.id, l]));

  const posted: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  const simple: string[] = [];
  for (const id of ids) {
    const line = byId.get(id);
    if (!line) { failed.push({ id, error: 'Transaction not found' }); continue; }
    const blocked = cannotPost(line);
    if (blocked) { failed.push({ id, error: blocked.error }); continue; }
    if (!line.pending) { simple.push(id); continue; }
    const res = await postTransaction(db, userId, id);
    if (res.ok) posted.push(id); else failed.push({ id, error: res.error });
  }
  if (simple.length) {
    await db.batch(simple.flatMap(id => [dropSuggestions(db, id), markPosted(db, userId, id)]));
    posted.push(...simple);
  }
  return { posted, failed };
}

/**
 * Sends a posted line back to For Review. Payments its matches created are deleted and the
 * invoices/bills they paid reopen; those matches stay as pending so posting again is one click.
 * A payment can span several bank lines, so every line in such a payment goes back too, along
 * with any other payments those lines made. QuickBooks links on the lines are removed. Lines keep
 * their notes and receipt, and their category unless a match filled it in.
 */
export async function undoTransaction(db: D1Database, transactionId: string): Promise<
  { ok: true; reopened: Array<{ type: 'invoice' | 'bill'; targetId: string; amount: number }>; alsoReturned: string[] } | Fail
> {
  const txn = await db.prepare('SELECT is_reconciled FROM transactions WHERE id = ?')
    .bind(transactionId).first<{ is_reconciled: number }>();
  if (!txn) return { ok: false, status: 404, error: 'Transaction not found' };
  if (!txn.is_reconciled) return { ok: false, status: 409, error: 'This line is already in For Review' };

  // Follow payments to the lines they span, and those lines to their other payments
  type Paid = { payment_id: string; match_type: 'invoice' | 'bill'; invoice_id: string | null; bill_id: string | null };
  const lines = new Set([transactionId]);
  const payments = new Map<string, Paid>();
  let frontier = [transactionId];
  while (frontier.length) {
    const { results: paid } = await db.prepare(`
      SELECT DISTINCT payment_id, match_type, invoice_id, bill_id FROM transaction_matches
      WHERE status = 'posted' AND kind = 'payment' AND payment_id IS NOT NULL
        AND transaction_id IN (${frontier.map(() => '?').join(',')})
    `).bind(...frontier).all<Paid>();
    const fresh = paid.filter(p => !payments.has(p.payment_id));
    fresh.forEach(p => payments.set(p.payment_id, p));
    if (!fresh.length) break;
    const { results: spanned } = await db.prepare(`
      SELECT DISTINCT transaction_id FROM transaction_matches
      WHERE payment_id IN (${fresh.map(() => '?').join(',')})
    `).bind(...fresh.map(p => p.payment_id)).all<{ transaction_id: string }>();
    frontier = spanned.map(s => s.transaction_id).filter(id => !lines.has(id));
    frontier.forEach(id => lines.add(id));
  }

  const statements: D1PreparedStatement[] = [];
  const reopened: Array<{ type: 'invoice' | 'bill'; targetId: string; amount: number }> = [];
  for (const p of payments.values()) {
    const invoice = p.match_type === 'invoice';
    const targetId = (invoice ? p.invoice_id : p.bill_id)!;
    const [paymentTable, targetTable, unpaidStatus] = invoice
      ? ['payments_received', 'invoices', 'sent'] : ['payments_made', 'bills', 'pending'];
    const target = await db.prepare(`SELECT status FROM ${targetTable} WHERE id = ?`)
      .bind(targetId).first<{ status: string }>();
    if (target?.status === 'void') {
      return { ok: false, status: 409, error: `The ${p.match_type} this line paid is void, so its payment can't be reopened` };
    }
    const payment = await db.prepare(`SELECT amount FROM ${paymentTable} WHERE id = ?`)
      .bind(p.payment_id).first<{ amount: number }>();
    if (payment) {
      reopened.push({ type: p.match_type, targetId, amount: payment.amount });
      statements.push(
        db.prepare(`DELETE FROM ${paymentTable} WHERE id = ?`).bind(p.payment_id),
        db.prepare(`
          UPDATE ${targetTable} SET
            amount_paid = MAX(0, amount_paid - ?),
            status = CASE WHEN amount_paid - ? <= 0 THEN ? ELSE 'partial' END,
            updated_at = datetime('now')
          WHERE id = ?
        `).bind(payment.amount, payment.amount, unpaidStatus, targetId),
      );
    }
    statements.push(db.prepare(`
      UPDATE transaction_matches SET status = 'pending', payment_id = NULL, posted_by = NULL, posted_at = NULL
      WHERE payment_id = ?
    `).bind(p.payment_id));
  }

  for (const id of lines) {
    statements.push(
      db.prepare(`DELETE FROM transaction_matches WHERE transaction_id = ? AND kind = 'link'`).bind(id),
      db.prepare(`
        UPDATE transactions SET is_reconciled = 0, reviewed_at = NULL, reviewed_by = NULL,
          ${CLEAR_AUTO_CATEGORY_SQL}, updated_at = datetime('now')
        WHERE id = ?
      `).bind(id),
    );
  }
  await db.batch(statements);

  return { ok: true, reopened, alsoReturned: [...lines].filter(id => id !== transactionId) };
}
