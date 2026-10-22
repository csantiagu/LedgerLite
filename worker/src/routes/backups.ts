import { Hono } from 'hono';
import { requireRole } from '../middleware/rbac';
import { actorOf, auditStatement } from '../middleware/audit';
import { backupDatabase, backupFiles, fileBackupStatus } from '../services/backup';
import { fileResponse } from '../services/files';
import type { Env } from '../types';

// Backup health for the owner, a manual run, and a download of the latest database backup so a
// copy can be kept outside Cloudflare.
const router = new Hono<{ Bindings: Env }>();
router.use('*', requireRole('owner'));

/** A database backup older than this is flagged on the dashboard. */
const STALE_HOURS = 36;

type Run = { started_at: string; finished_at: string | null; ok: number; object_key: string | null; detail: string | null };

router.get('/', async (c) => {
  const db = c.env.DB;
  const [lastGood, lastRun, files] = await Promise.all([
    db.prepare(`SELECT started_at, finished_at, ok, object_key, detail FROM backup_runs
                WHERE kind = 'database' AND ok = 1 ORDER BY started_at DESC LIMIT 1`).first<Run>(),
    db.prepare(`SELECT started_at, finished_at, ok, object_key, detail FROM backup_runs
                WHERE kind = 'database' ORDER BY started_at DESC LIMIT 1`).first<Run>(),
    fileBackupStatus(db),
  ]);
  const ageHours = lastGood ? (Date.now() - Date.parse(`${lastGood.finished_at!.replace(' ', 'T')}Z`)) / 3_600_000 : null;
  const detail = (r: Run | null) => (r?.detail ? JSON.parse(r.detail) as Record<string, unknown> : null);
  return c.json({
    database: {
      lastGood: lastGood && { at: lastGood.finished_at, key: lastGood.object_key, ...pick(detail(lastGood), ['rows', 'bytes', 'migration']) },
      lastFailed: lastRun && !lastRun.ok ? { at: lastRun.started_at, error: detail(lastRun)?.error ?? 'Did not finish' } : null,
      stale: ageHours === null || ageHours > STALE_HOURS,
    },
    files,
  });
});

// POST /run — back up now (the database, and the next batch of files)
router.post('/run', async (c) => {
  const { key, header } = await backupDatabase(c.env);
  const files = await backupFiles(c.env);
  await auditStatement(c.env.DB, actorOf(c), {
    action: 'backup.run', resourceType: 'backup', resourceId: key,
    newValues: { key, rows: Object.values(header.tables).reduce((n, t) => n + t.rows, 0), filesCopied: files.copied.length },
    summary: 'Backed up by hand',
  }).run();
  return c.json({ key, filesCopied: files.copied.length, filesMissing: files.missing.length });
});

// GET /latest — download the latest good database backup
router.get('/latest', async (c) => {
  const run = await c.env.DB.prepare(`SELECT object_key FROM backup_runs
    WHERE kind = 'database' AND ok = 1 ORDER BY started_at DESC LIMIT 1`).first<{ object_key: string }>();
  if (!run) return c.json({ error: 'No backup has been made yet' }, 404);
  const obj = await c.env.BACKUPS.get(run.object_key);
  if (!obj) return c.json({ error: 'That backup is no longer in the backup bucket' }, 404);
  await auditStatement(c.env.DB, actorOf(c), {
    action: 'backup.downloaded', resourceType: 'backup', resourceId: run.object_key, summary: 'Downloaded a database backup',
  }).run();
  return fileResponse(obj.body, undefined, `ledgerlite-${run.object_key.split('/').pop()}`);
});

function pick(obj: Record<string, unknown> | null, keys: string[]) {
  return Object.fromEntries(keys.filter(k => obj && k in obj).map(k => [k, obj![k]]));
}

export { router as backupRoutes };
