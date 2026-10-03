import type { Env } from '../types';

export type AuditAction =
  | 'invoice.created' | 'invoice.updated' | 'invoice.voided' | 'invoice.paid'
  | 'bill.created' | 'bill.updated' | 'bill.flagged'
  | 'payment.created' | 'payment.deleted'
  | 'user.created' | 'user.updated' | 'user.deleted'
  | 'bank_import.created'
  | 'transaction.updated' | 'transaction.matched'
  | 'expense_category.created' | 'expense_category.updated'
  | 'categorisation_rule.created' | 'categorisation_rule.updated' | 'categorisation_rule.deleted'
  | 'auth.login' | 'auth.logout' | 'auth.logout_all' | 'auth.password_changed' | 'auth.refresh_reuse'
  | 'auth.2fa_enabled' | 'auth.2fa_disabled' | 'auth.recovery_codes_regenerated';

export async function writeAudit(env: Env, opts: {
  userId?: string; apiKeyId?: string;
  action: AuditAction; resourceType: string; resourceId?: string;
  oldValues?: object; newValues?: object;
  ipAddress?: string; userAgent?: string;
}) {
  await env.DB.prepare(`
    INSERT INTO audit_log
      (user_id, api_key_id, action, resource_type, resource_id,
       old_values, new_values, ip_address, user_agent)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).bind(
    opts.userId ?? null, opts.apiKeyId ?? null,
    opts.action, opts.resourceType, opts.resourceId ?? null,
    opts.oldValues ? JSON.stringify(opts.oldValues) : null,
    opts.newValues ? JSON.stringify(opts.newValues) : null,
    opts.ipAddress ?? null, opts.userAgent ?? null,
  ).run();
}
