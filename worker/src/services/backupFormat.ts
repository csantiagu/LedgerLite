// The database backup format, shared by the Worker that writes it and scripts/restore-backup.ts
// that turns it back into SQL. No imports, so Node can run it directly.
//
// One NDJSON file per backup. The first line is the header, then one line per row:
//   {"format":"ledgerlite-backup","version":1,"createdAt":"…","migration":"029_backups.sql","tables":{"clients":{"rows":3,"sha256":"…"}}}
//   {"t":"clients","r":{"id":"…","name":"Acme",…}}
// Rows hold SQLite values as they were: text, integer, real or null (no blobs in this schema).

export const BACKUP_FORMAT = 'ledgerlite-backup';
export const BACKUP_VERSION = 1;

/** Tables left out: D1/SQLite internals, the migration log (restores apply migrations first), and
 *  sign-in sessions (a restore signs everyone out, rather than reviving old refresh tokens). */
export const SKIPPED_TABLES = new Set(['d1_migrations', 'refresh_tokens', 'sqlite_sequence']);
export const isBackedUp = (table: string) =>
  !SKIPPED_TABLES.has(table) && !table.startsWith('_cf_') && !table.startsWith('sqlite_');

export type BackupHeader = {
  format: typeof BACKUP_FORMAT;
  version: number;
  createdAt: string;
  migration: string | null;   // the latest migration the backed-up database had
  tables: Record<string, { rows: number; sha256: string }>;
};

export type Row = Record<string, string | number | null>;

/** One row as a line of the backup. */
export const rowLine = (table: string, row: Row) => JSON.stringify({ t: table, r: row });

/** A value as an SQL literal. */
export function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`Can't restore the number ${v}`);
    return String(v);
  }
  if (typeof v === 'string') return `'${v.replace(/'/g, "''")}'`;
  throw new Error(`Can't restore a value of type ${typeof v}`);
}

const ident = (name: string) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Unexpected name in backup: ${name}`);
  return `"${name}"`;
};

/** The INSERT that puts one row back. OR REPLACE, so rows the migrations seed (categories, the
 *  company settings row) take the backed-up values. */
export function insertSql(table: string, row: Row): string {
  const cols = Object.keys(row);
  return `INSERT OR REPLACE INTO ${ident(table)} (${cols.map(ident).join(', ')}) VALUES (${cols.map(c => sqlLiteral(row[c])).join(', ')});`;
}

/** Reads a backup file: its header and rows, checking it's one of ours and complete. */
export function parseBackup(text: string): { header: BackupHeader; rows: Array<{ t: string; r: Row }> } {
  const lines = text.split('\n').filter(l => l.trim());
  const header = JSON.parse(lines[0] ?? '{}') as BackupHeader;
  if (header.format !== BACKUP_FORMAT) throw new Error('This is not a LedgerLite backup');
  if (header.version !== BACKUP_VERSION) throw new Error(`Backup format version ${header.version} is not supported`);
  const rows = lines.slice(1).map(l => JSON.parse(l) as { t: string; r: Row });
  const counts = new Map<string, number>();
  for (const { t } of rows) counts.set(t, (counts.get(t) ?? 0) + 1);
  for (const [table, { rows: expected }] of Object.entries(header.tables)) {
    if ((counts.get(table) ?? 0) !== expected) {
      throw new Error(`The backup is incomplete: ${table} has ${counts.get(table) ?? 0} rows, the header says ${expected}`);
    }
  }
  return { header, rows };
}

/** SQL that loads a backup into a database whose migrations are already applied. */
export function restoreSql(text: string): string {
  const { header, rows } = parseBackup(text);
  return [
    `-- LedgerLite backup taken ${header.createdAt}, at migration ${header.migration ?? 'unknown'}`,
    // Rows go in table by table, so a child may arrive before its parent
    'PRAGMA defer_foreign_keys = true;',
    ...rows.map(({ t, r }) => insertSql(t, r)),
    '',
  ].join('\n');
}
