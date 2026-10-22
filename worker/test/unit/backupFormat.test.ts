import { describe, expect, it } from 'vitest';
import { insertSql, isBackedUp, parseBackup, restoreSql, rowLine, sqlLiteral } from '../../src/services/backupFormat';

const header = (tables: Record<string, number>) => JSON.stringify({
  format: 'ledgerlite-backup', version: 1, createdAt: '2026-10-22T02:30:00.000Z', migration: '029_backups.sql',
  tables: Object.fromEntries(Object.entries(tables).map(([t, rows]) => [t, { rows, sha256: 'x' }])),
});

describe('backup format', () => {
  it('writes values as SQL literals, escaping quotes', () => {
    expect(sqlLiteral(null)).toBe('NULL');
    expect(sqlLiteral(1250)).toBe('1250');
    expect(sqlLiteral(0.2)).toBe('0.2');
    expect(sqlLiteral("O'Brien's")).toBe("'O''Brien''s'");
    expect(sqlLiteral('£ – “quoted”')).toBe("'£ – “quoted”'");
    expect(() => sqlLiteral(Number.NaN)).toThrow();
    expect(() => sqlLiteral({})).toThrow();
  });

  it('builds INSERT OR REPLACE, refusing odd table or column names', () => {
    expect(insertSql('clients', { id: 'a', notes: null })).toBe(`INSERT OR REPLACE INTO "clients" ("id", "notes") VALUES ('a', NULL);`);
    expect(() => insertSql('clients; DROP TABLE x', { id: 'a' })).toThrow(/Unexpected name/);
    expect(() => insertSql('clients', { 'id"': 'a' })).toThrow(/Unexpected name/);
  });

  it('leaves out internals, the migration log and sign-in sessions', () => {
    expect(['clients', 'audit_log', 'users'].every(isBackedUp)).toBe(true);
    expect(['d1_migrations', 'refresh_tokens', '_cf_METADATA', 'sqlite_sequence'].some(isBackedUp)).toBe(false);
  });

  it('reads a backup back, and turns it into SQL', () => {
    const text = [header({ clients: 1 }), rowLine('clients', { id: 'a', name: 'Acme' }), ''].join('\n');
    expect(parseBackup(text).rows).toEqual([{ t: 'clients', r: { id: 'a', name: 'Acme' } }]);
    expect(restoreSql(text).split('\n')).toEqual([
      '-- LedgerLite backup taken 2026-10-22T02:30:00.000Z, at migration 029_backups.sql',
      'PRAGMA defer_foreign_keys = true;',
      `INSERT OR REPLACE INTO "clients" ("id", "name") VALUES ('a', 'Acme');`,
      '',
    ]);
  });

  it('refuses a file that is not a backup, or one cut short', () => {
    expect(() => parseBackup('{"hello":1}')).toThrow(/not a LedgerLite backup/);
    expect(() => parseBackup(header({ clients: 2 }) + '\n' + rowLine('clients', { id: 'a' })))
      .toThrow(/incomplete: clients has 1 rows, the header says 2/);
  });
});
