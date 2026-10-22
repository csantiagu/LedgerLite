import type { Context } from 'hono';
import type { Env } from '../types';

export type AuditAction =
  | 'invoice.created' | 'invoice.updated' | 'invoice.voided' | 'invoice.paid' | 'invoice.imported'
  | 'invoice.finalized' | 'invoice.deleted' | 'invoice.original_pdf_uploaded'
  | 'bill.created' | 'bill.updated' | 'bill.voided' | 'bill.flagged' | 'bill.attachment_uploaded'
  | 'payment.created' | 'payment.deleted'
  | 'client.created' | 'client.updated' | 'client.deactivated'
  | 'vendor.created' | 'vendor.updated' | 'vendor.deactivated'
  | 'user.created' | 'user.updated' | 'user.deleted'
  | 'bank_account.created' | 'bank_account.updated'
  | 'bank_import.created' | 'bank_import.undone'
  | 'transaction.updated' | 'transaction.matched' | 'transaction.linked' | 'transaction.unlinked'
  | 'transaction.match_added' | 'transaction.match_removed'
  | 'transaction.posted' | 'transaction.unposted' | 'transaction.receipt_uploaded'
  | 'expense_category.created' | 'expense_category.updated'
  | 'period.locked' | 'period.unlocked'
  | 'backup.run' | 'backup.downloaded'
  | 'company.updated' | 'company.migration_completed' | 'company.migration_reopened'
  | 'categorisation_rule.created' | 'categorisation_rule.updated' | 'categorisation_rule.deleted'
  | 'categorisation_rule.applied'
  | 'auth.login' | 'auth.logout' | 'auth.logout_all' | 'auth.password_changed' | 'auth.refresh_reuse'
  | 'auth.2fa_enabled' | 'auth.2fa_disabled' | 'auth.recovery_codes_regenerated';

/** Who made a change and from where. */
export type AuditActor = {
  userId?: string; apiKeyId?: string;
  ipAddress?: string; userAgent?: string;
};

/** What changed. `oldValues`/`newValues` hold only the fields that changed (see `changedFields`). */
export type AuditEntry = {
  action: AuditAction; resourceType: string; resourceId?: string;
  oldValues?: object; newValues?: object;
  /** One readable line for the history list, e.g. "Voided INV-2026-0012" */
  summary?: string;
};

/** The signed-in user (or API key) and the request's IP and browser. */
export function actorOf(c: Context): AuditActor {
  return {
    userId: c.get('user')?.id,
    apiKeyId: c.get('apiKeyId'),
    ipAddress: c.req.header('CF-Connecting-IP'),
    userAgent: c.req.header('User-Agent'),
  };
}

/**
 * The INSERT for one audit row, not yet run. Put it in the same `DB.batch` as the change it
 * records, so the change and its record are written together or not at all.
 */
export function auditStatement(
  db: D1Database, actor: AuditActor, entry: AuditEntry,
  /** SQL condition (with its binds) checked when the batch runs: no row is written unless it holds,
   *  e.g. when the change itself is a conditional insert that may not land */
  onlyIf?: { sql: string; binds: unknown[] },
): D1PreparedStatement {
  return db.prepare(`
    INSERT INTO audit_log
      (user_id, api_key_id, action, resource_type, resource_id,
       old_values, new_values, summary, ip_address, user_agent)
    SELECT ?,?,?,?,?,?,?,?,?,?
    WHERE ${onlyIf?.sql ?? '1'}
  `).bind(
    actor.userId ?? null, actor.apiKeyId ?? null,
    entry.action, entry.resourceType, entry.resourceId ?? null,
    entry.oldValues ? JSON.stringify(entry.oldValues) : null,
    entry.newValues ? JSON.stringify(entry.newValues) : null,
    entry.summary ?? null,
    actor.ipAddress ?? null, actor.userAgent ?? null,
    ...(onlyIf?.binds ?? []),
  );
}

/** Writes an audit row on its own, for events that change nothing else (sign-ins, refused tokens). */
export async function writeAudit(env: Env, opts: AuditActor & AuditEntry) {
  const { userId, apiKeyId, ipAddress, userAgent, ...entry } = opts;
  await auditStatement(env.DB, { userId, apiKeyId, ipAddress, userAgent }, entry).run();
}

/**
 * The fields of `after` whose value differs from `before`, as `{ oldValues, newValues }`.
 * Only keys present in `after` are compared, so pass the update as `after` and the row as
 * it was as `before`. Returns null when nothing changed.
 */
export function changedFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): { oldValues: Record<string, unknown>; newValues: Record<string, unknown> } | null {
  const oldValues: Record<string, unknown> = {};
  const newValues: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(after)) {
    if (value === undefined) continue;
    const was = before[key] ?? null;
    const now = value ?? null;
    if (JSON.stringify(was) === JSON.stringify(now)) continue;
    oldValues[key] = was;
    newValues[key] = now;
  }
  return Object.keys(newValues).length ? { oldValues, newValues } : null;
}
