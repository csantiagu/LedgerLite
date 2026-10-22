# Backups and restoring

## What is backed up, and where

| What | How | Kept |
|---|---|---|
| The database (D1 `accounts-db`) | **Time Travel**, built into D1 | 7 days on Workers Free (30 on Paid), to the minute |
| The database | Nightly export at 02:30 UTC to the `ledgerlite-backups` R2 bucket, `db-daily/YYYY-MM-DD.ndjson` | 35 days (lifecycle rule below) |
| The database | First backup of each month, `db-monthly/YYYY-MM.ndjson` | For good (HMRC wants records kept 6 years) |
| Receipts, invoice PDFs, statements, logo | Copied to `ledgerlite-backups/files/<same key>`, a few each hour | For good |
| A copy outside Cloudflare | **Settings → Backups → Download latest backup**, on your own machine | Up to you: monthly is a good habit |

Stored files are never overwritten (every upload gets a new key), so a database restored to any
earlier point still finds every file it refers to, in the main bucket and in the backup bucket.

Not in the backup: sign-in sessions (everyone signs in again after a restore) and the migration log
(a restore applies migrations first). Secrets (`JWT_SECRET`, `ENCRYPTION_KEY`, …) are not in the
database: keep them in your password manager. Without the same `ENCRYPTION_KEY`, two-factor sign-in
has to be set up again.

## One-time setup

```bash
cd worker
npx wrangler r2 bucket create ledgerlite-backups
# Daily exports expire after 35 days; monthly ones and files are kept
npx wrangler r2 bucket lifecycle add ledgerlite-backups expire-daily db-daily/ --expire-days 35
npx wrangler d1 migrations apply accounts-db --remote
npm run deploy:api
```

Then open **Settings → Backups** and press **Back up now** once to check it works.

## Restoring

### A recent mistake (within the last 7 days)

Use D1 Time Travel. It moves the whole database back to a moment; changes after it are lost.

```bash
cd worker
npx wrangler d1 time-travel info accounts-db --timestamp "2026-10-22T09:00:00Z"   # check the point first
npx wrangler d1 time-travel restore accounts-db --timestamp "2026-10-22T09:00:00Z"
```

Files need nothing: they were never overwritten.

### Older than Time Travel reaches, or the database is lost

1. Get the backup: download it from **Settings → Backups**, or from the bucket:
   ```bash
   npx wrangler r2 object get ledgerlite-backups/db-daily/2026-10-21.ndjson --remote --file backup.ndjson
   ```
2. Check it is whole (row counts and hashes):
   ```bash
   node scripts/restore-backup.mts backup.ndjson --check
   ```
3. Make a fresh database and apply the migrations. Use the code version the backup came from: the
   check prints its migration, e.g. `029_backups.sql`.
   ```bash
   npx wrangler d1 create accounts-db-restored
   # put its database_id in wrangler.toml under the DB binding, then:
   npx wrangler d1 migrations apply accounts-db-restored --remote
   ```
4. Load the backup:
   ```bash
   node scripts/restore-backup.mts backup.ndjson > restore.sql
   npx wrangler d1 execute accounts-db-restored --remote --file restore.sql
   ```
5. Deploy (`npm run deploy:api`), sign in and check the dashboard figures against the old ones.

### The main file bucket is lost

Every file is in `ledgerlite-backups/files/` under the same key. Copy them back with any S3 tool
pointed at R2 (e.g. `rclone copy r2:ledgerlite-backups/files r2:accounts-storage`), or point the
`R2` binding at a new bucket filled that way.

## Restore drill

`test/integration/backup.test.ts` runs a drill on every test run: it backs up, rebuilds tables from
the backup and checks every row matches. Once before going live, and then once a quarter, also do it
for real against a copy:

```bash
npx wrangler r2 object get ledgerlite-backups/db-daily/<latest>.ndjson --remote --file drill.ndjson
node scripts/restore-backup.mts drill.ndjson --check
rm -rf .wrangler/state && npx wrangler d1 migrations apply accounts-db --local
node scripts/restore-backup.mts drill.ndjson > drill.sql
npx wrangler d1 execute accounts-db --local --file drill.sql
npx wrangler dev   # sign in locally and compare the dashboard with production
```

(This wipes your local data: it's a scratch copy.)

## Limits on Workers Free

Each scheduled run gets about 10 ms of CPU and 50 database queries, so the export isn't compressed
and files are copied 15 an hour. If the database grows past roughly 50,000 rows, the export may
start to fail: the dashboard says so, and Workers Paid ($5/month) lifts the limits.
