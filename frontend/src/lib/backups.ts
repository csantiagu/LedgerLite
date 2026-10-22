// Backup health as GET /api/v1/backups reports it.
export type BackupStatus = {
  database: {
    lastGood: { at: string; key: string; rows?: number; bytes?: number; migration?: string } | null;
    lastFailed: { at: string; error: string } | null;
    stale: boolean;
  };
  files: { referenced: number; pending: number; missing: number; last_copied_at: string | null };
};

/** One line on the state of backups, or null when all is well. */
export function backupWarning(s: BackupStatus): string | null {
  if (!s.database.lastGood) return 'No backup has been made yet.';
  if (s.database.lastFailed) return 'The last backup failed.';
  if (s.database.stale) return 'The last good backup is more than a day and a half old.';
  if (s.files.missing) return `${s.files.missing} stored file${s.files.missing === 1 ? ' was' : 's were'} missing when backed up.`;
  return null;
}

/** 1536 → "1.5 KB" */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
