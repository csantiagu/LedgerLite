// Backups: the nightly database export and file copy to the BACKUPS bucket, their health check,
// and a restore drill that rebuilds rows from a backup and compares them with the originals.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import worker from '../../src/index';
import { issueAccessToken } from '../../src/middleware/auth';
import { backupDatabase, backupFiles, DATABASE_CRON, FILES_CRON } from '../../src/services/backup';
import { insertSql, parseBackup } from '../../src/services/backupFormat';

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
const uid = () => crypto.randomUUID().replace(/-/g, '');
let ownerToken = '';
let accountantToken = '';
let ownerId = '';

type Json = any;   // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(method: string, path: string, token = ownerToken) {
  return worker.fetch(new Request(`http://api.test${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' },
  }), env, ctx);
}

const count = async (table: string) =>
  (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;

beforeAll(async () => {
  ownerId = uid();
  const accountantId = uid();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (id, email, name, role, password_hash) VALUES (?, ?, 'O', 'owner', 'x')`)
      .bind(ownerId, `${ownerId}@test.local`),
    env.DB.prepare(`INSERT INTO users (id, email, name, role, password_hash) VALUES (?, ?, 'A', 'accountant', 'x')`)
      .bind(accountantId, `${accountantId}@test.local`),
    // Awkward values: quotes, unicode, nulls, reals
    env.DB.prepare(`INSERT INTO clients (id, name, notes, address, created_by) VALUES (?, ?, ?, NULL, ?)`)
      .bind(uid(), `O'Brien & “Sons” – £`, 'Line one\nLine two', ownerId),
  ]);
  ownerToken = await issueAccessToken(ownerId, `${ownerId}@test.local`, 'owner', env.JWT_SECRET);
  accountantToken = await issueAccessToken(accountantId, `${accountantId}@test.local`, 'accountant', env.JWT_SECRET);
});

describe('database backup', () => {
  it('exports every table with its row count, paging through big ones', async () => {
    const { key, header } = await backupDatabase(env, new Date('2026-10-22T02:30:00Z'), 3);
    expect(key).toBe('db-daily/2026-10-22.ndjson');
    expect(header.migration).toMatch(/^\d{3}_.*\.sql$/);
    for (const table of ['clients', 'users', 'expense_categories', 'audit_log']) {
      expect(header.tables[table]!.rows).toBe(await count(table));
    }
    expect(header.tables).not.toHaveProperty('refresh_tokens');
    expect(header.tables).not.toHaveProperty('d1_migrations');

    const text = await (await env.BACKUPS.get(key))!.text();
    expect(parseBackup(text).rows.length).toBe(Object.values(header.tables).reduce((n, t) => n + t.rows, 0));
  });

  it('keeps the first backup of each month', async () => {
    await backupDatabase(env, new Date('2026-11-01T02:30:00Z'));
    await backupDatabase(env, new Date('2026-11-02T02:30:00Z'));
    const monthly = await env.BACKUPS.get('db-monthly/2026-11.ndjson');
    expect(monthly!.customMetadata!.createdAt).toBe('2026-11-01T02:30:00.000Z');
  });

  it('rebuilds identical rows from the backup (restore drill)', async () => {
    const { key } = await backupDatabase(env, new Date('2026-10-23T02:30:00Z'));
    const { rows } = parseBackup(await (await env.BACKUPS.get(key))!.text());
    for (const table of ['clients', 'expense_categories', 'invoice_items']) {
      const copy = `restore_${table}`;
      await env.DB.prepare(`CREATE TABLE ${copy} AS SELECT * FROM ${table} WHERE 0`).run();
      const inserts = rows.filter(r => r.t === table).map(r => env.DB.prepare(insertSql(copy, r.r)));
      if (inserts.length) await env.DB.batch(inserts);
      const diff = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM (SELECT * FROM ${table} EXCEPT SELECT * FROM ${copy}
                                    UNION ALL SELECT * FROM ${copy} EXCEPT SELECT * FROM ${table})`
      ).first<{ n: number }>();
      expect(diff!.n, table).toBe(0);
      expect(await count(copy)).toBe(await count(table));
      await env.DB.prepare(`DROP TABLE ${copy}`).run();
    }
  });
});

describe('file backup', () => {
  it('copies each stored file once, and records missing ones without retrying them', async () => {
    const present = `transactions/${uid()}/1-receipt.pdf`;
    const absent = `transactions/${uid()}/2-gone.pdf`;
    await env.R2.put(present, '%PDF-1.7 receipt', { httpMetadata: { contentType: 'application/pdf' } });
    await env.DB.batch([present, absent].map(key => env.DB.prepare(
      `INSERT INTO transactions (id, date, description, amount, attachment_r2_key) VALUES (?, '2026-06-01', 'FILE', -1, ?)`
    ).bind(uid(), key)));

    const first = await backupFiles(env, 1_000);
    expect(first.copied).toContain(present);
    expect(first.missing).toEqual([absent]);
    const copy = await env.BACKUPS.get(`files/${present}`);
    expect(await copy!.text()).toBe('%PDF-1.7 receipt');
    expect(copy!.httpMetadata!.contentType).toBe('application/pdf');

    const runs = await count('backup_runs');
    expect(await backupFiles(env, 1_000)).toEqual({ copied: [], missing: [] });
    expect(await count('backup_runs')).toBe(runs);   // nothing to do, nothing recorded
  });

  it('includes files a later upload replaced', async () => {
    const old = `transactions/${uid()}/old.pdf`;
    await env.R2.put(old, '%PDF old');
    await env.DB.prepare(`
      INSERT INTO audit_log (action, resource_type, resource_id, old_values) VALUES ('transaction.receipt_uploaded', 'transaction', 'x', ?)
    `).bind(JSON.stringify({ key: old, file: 'old.pdf' })).run();
    expect((await backupFiles(env, 1_000)).copied).toEqual([old]);
  });
});

describe('the cron triggers', () => {
  it('runs the database export and the file copy on their schedules', async () => {
    const before = await count(`backup_runs WHERE kind = 'database'`);
    const waits: Promise<unknown>[] = [];
    const cronCtx = { ...ctx, waitUntil: (p: Promise<unknown>) => waits.push(p) } as unknown as ExecutionContext;
    await worker.scheduled({ cron: DATABASE_CRON, scheduledTime: Date.now(), noRetry() {} }, env, cronCtx);
    await worker.scheduled({ cron: FILES_CRON, scheduledTime: Date.now(), noRetry() {} }, env, cronCtx);
    await Promise.all(waits);
    expect(await count(`backup_runs WHERE kind = 'database'`)).toBe(before + 1);
  });
});

describe('backup routes', () => {
  it('report health, run on demand and download the latest, for the owner only', async () => {
    expect((await call('GET', '/api/v1/backups', accountantToken)).status).toBe(403);

    const run = await call('POST', '/api/v1/backups/run');
    expect(run.status).toBe(200);
    const { key } = await run.json() as Json;

    const health = await (await call('GET', '/api/v1/backups')).json() as Json;
    expect(health.database).toMatchObject({ stale: false, lastFailed: null, lastGood: { key } });
    expect(health.files).toMatchObject({ referenced: expect.any(Number), pending: expect.any(Number), missing: 1 });

    const download = await call('GET', '/api/v1/backups/latest');
    expect(download.headers.get('Content-Disposition')).toMatch(/attachment; filename="?ledgerlite-.*\.ndjson/);
    expect(parseBackup(await download.text()).header.format).toBe('ledgerlite-backup');

    const audit = await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action IN ('backup.run', 'backup.downloaded') AND user_id = ?`)
      .bind(ownerId).first<{ n: number }>();
    expect(audit!.n).toBe(2);
  });
});
