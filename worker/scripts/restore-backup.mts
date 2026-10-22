// Turns a LedgerLite database backup back into SQL, or checks one is whole.
//
//   node scripts/restore-backup.mts <backup.ndjson> --check        row counts and hashes match the header
//   node scripts/restore-backup.mts <backup.ndjson> > restore.sql  SQL that loads it
//
// The SQL goes into a database that already has every migration applied (see docs/restore.md).
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseBackup, restoreSql, rowLine } from '../src/services/backupFormat.ts';

const [file, flag] = process.argv.slice(2);
if (!file) {
  console.error('Usage: node scripts/restore-backup.mts <backup.ndjson> [--check]');
  process.exit(2);
}
const text = readFileSync(file, 'utf8');

if (flag === '--check') {
  const { header, rows } = parseBackup(text);
  const byTable = new Map<string, string[]>();
  for (const { t, r } of rows) byTable.set(t, [...(byTable.get(t) ?? []), rowLine(t, r)]);
  let bad = 0;
  for (const [table, { rows: count, sha256 }] of Object.entries(header.tables)) {
    const actual = createHash('sha256').update((byTable.get(table) ?? []).join('\n')).digest('hex');
    const ok = actual === sha256;
    if (!ok) bad += 1;
    console.log(`${ok ? 'ok  ' : 'BAD '} ${table.padEnd(24)} ${String(count).padStart(7)} rows`);
  }
  console.log(`\nBackup taken ${header.createdAt}, at migration ${header.migration ?? 'unknown'}.`);
  if (bad) {
    console.error(`${bad} table${bad === 1 ? '' : 's'} don't match their hash: this backup is damaged.`);
    process.exit(1);
  }
  console.log('Every table matches its row count and hash.');
} else {
  process.stdout.write(restoreSql(text));
}
