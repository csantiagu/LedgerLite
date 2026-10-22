// Nightly backups to the BACKUPS R2 bucket, sized for the Workers Free plan (about 10 ms of CPU and
// 50 D1 queries per run): no compression, rows read a page at a time in batches, and receipts
// copied a few per night in a separate run.
//
// Bucket layout:
//   db-daily/YYYY-MM-DD.ndjson    every night (expire these after 35 days with a lifecycle rule)
//   db-monthly/YYYY-MM.ndjson     the first backup of each month (keep: HMRC wants 6 years)
//   files/<key in R2>              each stored file, copied once (keys are never reused); an hourly
//                                  run copies up to FILES_PER_RUN, so a backlog clears in a day or two
import type { Env } from '../types';
import { BACKUP_FORMAT, BACKUP_VERSION, isBackedUp, rowLine, type BackupHeader, type Row } from './backupFormat';

const PAGE = 2_000;
export const FILES_PER_RUN = 15;

const sha256Hex = async (text: string) => [...new Uint8Array(
  await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
)].map(b => b.toString(16).padStart(2, '0')).join('');

const ident = (name: string) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Unexpected table name: ${name}`);
  return `"${name}"`;
};

async function startRun(db: D1Database, kind: 'database' | 'files') {
  const id = crypto.randomUUID().replace(/-/g, '');
  await db.prepare('INSERT INTO backup_runs (id, kind) VALUES (?, ?)').bind(id, kind).run();
  return id;
}

async function finishRun(db: D1Database, id: string, ok: boolean, detail: unknown, objectKey: string | null = null) {
  await db.prepare(`UPDATE backup_runs SET finished_at = datetime('now'), ok = ?, detail = ?, object_key = ? WHERE id = ?`)
    .bind(ok ? 1 : 0, JSON.stringify(detail), objectKey, id).run();
}

/** Exports every table to one NDJSON file in the backup bucket and records the run. */
export async function backupDatabase(env: Env, now = new Date(), pageSize = PAGE): Promise<{ key: string; header: BackupHeader }> {
  const db = env.DB;
  const runId = await startRun(db, 'database');
  try {
    const [tables, migration] = await db.batch([
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`),
      db.prepare(`SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1`),
    ]);
    const names = (tables!.results as Array<{ name: string }>).map(t => t.name).filter(isBackedUp);

    // First page of every table in one batch; only big tables need more
    const pageSql = (t: string) => `SELECT rowid AS "__rowid", * FROM ${ident(t)} WHERE rowid > ? ORDER BY rowid LIMIT ${pageSize}`;
    const first = await db.batch(names.map(t => db.prepare(pageSql(t)).bind(0)));
    const header: BackupHeader = {
      format: BACKUP_FORMAT, version: BACKUP_VERSION, createdAt: now.toISOString(),
      migration: (migration!.results[0] as { name: string } | undefined)?.name ?? null,
      tables: {},
    };
    const body: string[] = [];
    for (const [i, table] of names.entries()) {
      const lines: string[] = [];
      let page = first[i]!.results as Array<Row & { __rowid: number }>;
      for (;;) {
        for (const { __rowid: _rowid, ...row } of page) lines.push(rowLine(table, row));
        if (page.length < pageSize) break;
        page = (await db.prepare(pageSql(table)).bind(page.at(-1)!.__rowid).all<Row & { __rowid: number }>()).results;
      }
      header.tables[table] = { rows: lines.length, sha256: await sha256Hex(lines.join('\n')) };
      body.push(...lines);
    }

    const text = [JSON.stringify(header), ...body, ''].join('\n');
    const day = now.toISOString().slice(0, 10);
    const key = `db-daily/${day}.ndjson`;
    const meta = { httpMetadata: { contentType: 'application/x-ndjson' }, customMetadata: { createdAt: header.createdAt } };
    await env.BACKUPS.put(key, text, meta);
    // The first backup of a month is kept for good (onlyIf: don't replace an existing one)
    await env.BACKUPS.put(`db-monthly/${day.slice(0, 7)}.ndjson`, text, { ...meta, onlyIf: new Headers({ 'If-None-Match': '*' }) });

    const rows = Object.values(header.tables).reduce((n, t) => n + t.rows, 0);
    await finishRun(db, runId, true, { tables: header.tables, rows, bytes: text.length, migration: header.migration }, key);
    return { key, header };
  } catch (err) {
    await finishRun(db, runId, false, { error: String(err) }).catch(() => {});
    throw err;
  }
}

// Every R2 key the database refers to, including files a later upload replaced (their old key is
// in the audit trail), so a restore to any earlier point finds its files. One query per source:
// D1 allows only a few UNION terms in a query.
const FILE_SOURCES = [
  { table: 'invoices', key: 'pdf_r2_key' },
  { table: 'bills', key: 'attachment_r2_key' },
  { table: 'transactions', key: 'attachment_r2_key' },
  { table: 'company_settings', key: 'logo_r2_key' },
  { table: 'bank_imports', key: 'r2_key' },
  {
    table: 'audit_log', key: `json_extract(old_values, '$.key')`,
    where: `action IN ('transaction.receipt_uploaded', 'bill.attachment_uploaded', 'invoice.original_pdf_uploaded')`,
  },
] as const;

const sourceSql = (src: (typeof FILE_SOURCES)[number], select: string) =>
  `SELECT ${select} FROM ${src.table} WHERE ${src.key} IS NOT NULL${'where' in src ? ` AND ${src.where}` : ''}`;
const notCopied = (src: (typeof FILE_SOURCES)[number]) => `${src.key} NOT IN (SELECT r2_key FROM backup_files)`;

/** How many stored files the database refers to, and how many of them aren't backed up yet. */
export async function fileBackupStatus(db: D1Database) {
  const sum = (part: (src: (typeof FILE_SOURCES)[number]) => string) =>
    FILE_SOURCES.map(src => `(${part(src)})`).join(' + ');
  const row = (await db.prepare(`
    SELECT ${sum(src => sourceSql(src, 'COUNT(*)'))} AS referenced,
           ${sum(src => `${sourceSql(src, 'COUNT(*)')} AND ${notCopied(src)}`)} AS pending,
           (SELECT COUNT(*) FROM backup_files WHERE missing = 1) AS missing,
           (SELECT MAX(copied_at) FROM backup_files WHERE missing = 0) AS last_copied_at
  `).first<{ referenced: number; pending: number; missing: number; last_copied_at: string | null }>())!;
  return row;
}

/** Copies up to FILES_PER_RUN stored files not yet in the backup bucket, and records the run. */
export async function backupFiles(env: Env, limit = FILES_PER_RUN): Promise<{ copied: string[]; missing: string[] }> {
  const db = env.DB;
  const pages = await db.batch(FILE_SOURCES.map(src =>
    db.prepare(`${sourceSql(src, `DISTINCT ${src.key} AS k`)} AND ${notCopied(src)} LIMIT ?`).bind(limit)));
  const results = [...new Set(pages.flatMap(p => (p.results as Array<{ k: string }>).map(r => r.k)))]
    .slice(0, limit).map(k => ({ k }));
  // Most hours there's nothing new: no run is recorded then
  if (!results.length) return { copied: [], missing: [] };
  const runId = await startRun(db, 'files');
  try {
    const copied: string[] = [];
    const missing: string[] = [];
    for (const { k } of results) {
      const obj = await env.R2.get(k);
      if (!obj) { missing.push(k); continue; }
      // Streamed straight through: the Worker never holds the file
      await env.BACKUPS.put(`files/${k}`, obj.body.pipeThrough(new FixedLengthStream(obj.size)), {
        httpMetadata: obj.httpMetadata, customMetadata: obj.customMetadata,
      });
      copied.push(k);
    }
    await db.batch([...copied, ...missing].map(k =>
      db.prepare('INSERT OR IGNORE INTO backup_files (r2_key, missing) VALUES (?, ?)').bind(k, missing.includes(k) ? 1 : 0)));
    await finishRun(db, runId, missing.length === 0, { copied: copied.length, missing });
    return { copied, missing };
  } catch (err) {
    await finishRun(db, runId, false, { error: String(err) }).catch(() => {});
    throw err;
  }
}

/** Cron schedules (UTC), as in wrangler.toml */
export const DATABASE_CRON = '30 2 * * *';
export const FILES_CRON = '15 * * * *';
