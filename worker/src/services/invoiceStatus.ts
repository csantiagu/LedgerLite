/** Past-due sent and part-paid invoices become overdue (credit notes never do). Called before the screens that show status. */
export function markOverdue(db: D1Database) {
  return db.prepare(`
    UPDATE invoices
    SET status = 'overdue', updated_at = CURRENT_TIMESTAMP
    WHERE status IN ('sent', 'partial') AND kind = 'invoice'
      AND due_date IS NOT NULL
      AND due_date < date('now')
  `).run();
}
