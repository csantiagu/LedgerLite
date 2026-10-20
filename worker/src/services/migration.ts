import type { D1Database } from '@cloudflare/workers-types';

/**
 * Whether bank lines may still be linked to paid QuickBooks invoices: only until the owner marks
 * the migration complete on Settings → Company (company_settings.migration_completed_at).
 */
export async function linksAllowed(db: D1Database): Promise<boolean> {
  const row = await db.prepare('SELECT migration_completed_at FROM company_settings WHERE id = 1')
    .first<{ migration_completed_at: string | null }>();
  return !row?.migration_completed_at;
}
