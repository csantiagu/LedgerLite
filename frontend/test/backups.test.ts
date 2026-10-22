import { describe, expect, it } from 'vitest';
import { backupWarning, formatBytes, type BackupStatus } from '@/lib/backups';

const status = (over: Partial<BackupStatus['database']> = {}, files: Partial<BackupStatus['files']> = {}): BackupStatus => ({
  database: { lastGood: { at: '2026-10-22 02:30:01', key: 'db-daily/2026-10-22.ndjson' }, lastFailed: null, stale: false, ...over },
  files: { referenced: 10, pending: 0, missing: 0, last_copied_at: null, ...files },
});

describe('backupWarning', () => {
  it('is quiet when the last backup is recent and complete', () => {
    expect(backupWarning(status())).toBeNull();
    expect(backupWarning(status({}, { pending: 4 }))).toBeNull();   // still copying: not a problem
  });

  it('warns about no backup, a failed one, an old one, or missing files', () => {
    expect(backupWarning(status({ lastGood: null, stale: true }))).toBe('No backup has been made yet.');
    expect(backupWarning(status({ lastFailed: { at: 'x', error: 'boom' } }))).toBe('The last backup failed.');
    expect(backupWarning(status({ stale: true }))).toMatch(/more than a day and a half old/);
    expect(backupWarning(status({}, { missing: 2 }))).toBe('2 stored files were missing when backed up.');
  });
});

describe('formatBytes', () => {
  it('rounds to a readable size', () => {
    expect(formatBytes(900)).toBe('900 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(250 * 1024 * 1024)).toBe('250 MB');
  });
});
