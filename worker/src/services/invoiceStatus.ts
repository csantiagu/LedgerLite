/** Past-due sent and part-paid invoices become overdue. Called before the screens that show status. */
export function markOverdue(db: D1Database) {
  return db.prepare(`
    UPDATE invoices
    SET status = 'overdue', updated_at = CURRENT_TIMESTAMP
    WHERE status IN ('sent', 'partial')
      AND due_date IS NOT NULL
      AND due_date < date('now')
  `).run();
}
