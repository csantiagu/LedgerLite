# Integrity plan — audit, reconciliation, period locks, backups, VAT

Written 2026-10-22 after reading the current code. Work through the phases in order; each one is
a separate commit (or a few) with its own migration and tests. Phases 1–3 build on each other.
Phase 4 (backups) can be done at any point. Phase 5 (VAT) relies on the period lock from phase 3.

Migrations start at **026**.

---

## Where we are today

| Area | What exists | Gaps found |
|---|---|---|
| Audit trail | `audit_log` table (006), `writeAudit()` called from most routes | Updates log only `newValues`, never the old ones. Creating or removing a match (`POST/DELETE /transaction-matches`) isn't audited. The audit row is written *after* the change, as a separate statement, so a failure can leave a change with no record. The table can be edited or deleted like any other. There's no screen for viewing it. |
| Reconciliation integrity | Import skips rows whose date + description + amount + reference already exist. `checkAllocation()` stops over-allocation. Posted lines can't change category or VAT. | **Real transactions get dropped:** two genuine identical payments on the same day (e.g. two £4.50 coffees) are treated as one. Imports run row by row with no batch, so a failure leaves half a file imported. Re-uploading the same file isn't detected up front. Match checks happen first and the write comes later, so two requests at the same moment can both pass and over-allocate. Nothing in the database stops duplicate `(transaction, invoice/bill)` match rows. A whole import can't be undone. |
| Period locking | Nothing | No VAT quarter setting, no lock, no record of the accountant's sign-off. |
| Backups | D1 Time Travel (Cloudflare's built-in point-in-time restore) | No backup taken on a schedule. Receipt keys on transactions are fixed (`transactions/:id/attachment.ext`), so uploading a new receipt **overwrites** the old one. A database restored to an earlier point would then show the wrong file. There's no written restore procedure and no restore drill. |
| VAT | Per-line `tax_rate`, VAT on bank lines (023), VAT-only invoices (024/025) | No credit notes. An invoice with a payment can't be corrected except by deleting the payment and voiding. Refunds aren't supported: `checkAllocation` rejects money in against a bill and money out against an invoice. There's no VAT return summary (boxes 1–9) to check against. |

---

## Phase 1 — Audit trail ✅ done 2026-10-22

> Built as below, except: no `request_id` column (one row per change makes it redundant); rule
> categorisation writes one row per rule listing its lines (keeps D1 query counts down), which a line's
> history picks up. Receipt, logo and original-PDF uploads already use unique R2 keys (phase 4 step 1).

**Goal:** every money-affecting change records who made it, when, and the before and after values. The record is written atomically with the change and can't be altered afterwards.

1. **Migration 026 `audit_hardening.sql`**
   - Triggers `BEFORE UPDATE` / `BEFORE DELETE ON audit_log` → `RAISE(ABORT, 'audit_log is append-only')`.
   - Add `request_id TEXT` and `summary TEXT` (a readable line such as "Voided INV-2026-0012").
   - Index `(resource_type, resource_id, created_at)`.
2. **`writeAudit` → `auditStatement()`** in `middleware/audit.ts`. It returns a prepared statement instead of running it, so each route adds it to the same `DB.batch([...])` as the change itself. Keep `writeAudit` for auth events, which don't change anything else.
3. **Capture old values.** Add a helper `diff(before, after)` that stores only the fields that changed. Apply it to:
   - `PATCH /transactions/:id` (category, VAT, notes, flag)
   - `PUT/PATCH /invoices/:id`, `PUT /bills/:id`, client/vendor/category/rule edits
   - void, post, undo, link and unlink (store the status before and after, plus the payment ids)
4. **Fill the gaps:** add `transaction.match_added` / `transaction.match_removed` (with the amount and target), `bill.voided`, `transaction.receipt_uploaded`, `bank_import.undone` (phase 2) and `period.locked` / `period.unlocked` (phase 3).
5. **API:** `GET /api/v1/audit?resourceType&resourceId&userId&from&to&page`, available to owner and accountant (read-only). `GET /api/v1/audit/resource/:type/:id` returns the history of one record.
6. **Frontend:**
   - A "History" panel on the invoice, bill and transaction detail views showing who, when and what changed.
   - An `/audit` page with filters for the whole log.
7. **Tests:** updating or deleting `audit_log` fails. Each mutating route writes exactly one row with the right old and new values. A failed batch writes no audit row.

**Done when:** for any transaction, invoice or bill you can answer "who changed this, when, and from what to what" in the UI.

---

## Phase 2 — Reconciliation integrity ✅ done 2026-10-22

> Built as below. Also: bill edits are refused when the new total is below bank lines waiting to
> post against it, void bills can't be edited, and the overlap warning names the earlier import.
> Not covered: two *different* files with overlapping lines imported at the same instant could both
> add a line (each checks before the other writes); the file hash stops the common case.

**Goal:** importing never drops or duplicates bank lines, and matching can't double-allocate, even when two requests arrive at the same moment.

1. **Count duplicates instead of dropping them**, in `bankImports.ts`, using a new pure function `services/importDedupe.ts`. For each key `(date, description, amount, reference)`, insert `count in file − count already in the account`, using only the existing lines on the dates the file covers. Two identical coffees in one file → both imported. The same file uploaded again → nothing imported.
2. **Detect a repeated file:** migration 027 adds `bank_imports.file_sha256`, with a unique index on `(bank_account_id, file_sha256)`. Re-uploading an identical file returns 409 "Already imported on <date> by <name>".
3. **Atomic import:** build every insert plus the `bank_imports` row and the audit row into one `DB.batch`. If the batch fails, nothing is imported. Run suggestions and rules after the batch, as now.
4. **Overlap warning:** when a file's date range overlaps an earlier import from the same account, include `overlap: { from, to, skipped }` in the response so the UI can show "12 lines already imported were skipped".
5. **Undo an import:** `POST /bank-imports/:id/undo` (owner only). It deletes the import's lines **only if none is posted, matched (pending/posted), linked or has a receipt**; otherwise it returns 409 with a list of what blocks it. Every deletion is audited.
6. **Match guards in the database** (migration 027):
   - Unique indexes on `transaction_matches(transaction_id, invoice_id) WHERE invoice_id IS NOT NULL`, and the same for `bill_id`.
   - Make the match insert or update conditional, so the over-allocation check runs inside the write: `INSERT … SELECT … WHERE (SELECT SUM(...)) + ? <= ABS(amount)`. If no row was changed (`meta.changes = 0`), return 409.
   - Check that `postMatchesAndReconcile` re-checks the outstanding amount when posting. If it doesn't, add the same conditional `UPDATE invoices SET amount_paid = amount_paid + ? WHERE … AND total - amount_paid >= ?`.
7. **No silent changes to posted items:** posted lines already refuse category and VAT changes. Extend this so that:
   - receipts and notes on posted lines can still be changed but are always audited (phase 1);
   - an invoice or bill with posted payments refuses changes to its amounts (check this covers `PATCH` as well as `PUT`).
8. **Tests:** duplicates within a file; the same file uploaded again; overlapping files; a failure halfway through a batch; two simultaneous match requests (fire both with `Promise.all` and expect one 409); undoing an import with and without blocking lines.

**Done when:** an import can't lose or double a line, and the totals of the matches on a line or invoice can never exceed its amount.

---

## Phase 3 — Period locking (VAT quarters) ✅ done 2026-10-22

> Decided: quarters end Mar/Jun/Sep/Dec (setting, default 3); the owner can unlock alone, with a
> reason. Built as a single lock date (locking a quarter locks everything before it; unlocking
> reopens the newest lock only), so no separate `lock_date` column. Locking is refused while lines
> on or before the quarter end are in For Review. Draft invoices stay editable (they aren't in the
> books until finalised). Edit buttons aren't hidden in locked periods; the server refuses with a
> clear 423 message and a "Locked period" badge shows on the record.

**Goal:** once the accountant has reviewed a VAT quarter, nothing dated inside it can change by accident.

1. **Migration 028**
   - `company_settings.vat_quarter_end_month INTEGER` (1–12, e.g. 3 means quarters end Mar/Jun/Sep/Dec). NULL means not VAT registered, so lock by month instead.
   - `period_locks(id, period_start, period_end, locked_at, locked_by, reviewed_by, note, unlocked_at, unlocked_by, unlock_reason)`. Rows are never deleted: unlocking sets `unlocked_*`, and locking again inserts a new row.
   - `company_settings.lock_date` (computed: the latest `period_end` of the active locks). Every check reads this one value.
2. **`services/periodLock.ts`**: `lockedThrough(db)` and `assertOpen(db, date)`, which returns 423 Locked with the message "<date> is in a locked period (Q2 2026, reviewed by …). Ask the owner to unlock it."
3. **Apply it to every write that changes the books for a date:**
   - Bank lines: post, undo, category or VAT change, match add/remove, import (refuse lines dated on or before the lock date, or skip and report them), undo import.
   - Invoices: create, edit, finalize, void, and payments (checked against `issue_date` and `payment_date`).
   - Bills: create, edit, void, and payments.
   - Credit notes (phase 5): checked against their own date, never the original invoice's date.
   - Notes, flags and receipt uploads stay allowed (they don't change the figures) but are audited.
4. **Who does what:**
   - The **accountant** can mark a quarter "Reviewed & locked". This is the one non-read action they get, enforced in `rbac.ts` / the route itself.
   - The **owner** can lock it too, but **only the owner can unlock**, with a reason that is required and audited.
   - Decision needed: should unlocking also need the accountant's agreement? The default in this plan: the owner can unlock, the accountant sees it on the dashboard with a "Re-review" badge.
5. **Frontend:**
   - A `/periods` page listing quarters with their status (Open / Locked by X on date / Re-opened), plus the lock and unlock buttons.
   - A lock icon and disabled edit buttons on any record dated in a locked period.
   - A dashboard banner: "Q3 2026 ready for review", which the accountant sees once the quarter has ended.
   - The accountant export defaults to the next unlocked quarter.
6. **Tests:** every guarded route returns 423 inside a locked period and works after unlocking. The accountant can lock but can't unlock. Import skips locked dates.

**Done when:** after the accountant locks Q2, no route can change a Q2 figure without an audited unlock.

---

## Phase 4 — Backups and recovery ✅ done 2026-10-22

> Workers Free, so: the export is one uncompressed NDJSON per night (≈10 ms CPU per run), files are
> copied 15 an hour rather than all at once, and a separate `ledgerlite-backups` R2 bucket (free
> tier) holds both. No R2 replication or versioning (not needed: keys are write-once). Offsite copy
> is the owner's "Download latest backup" button. Runbook in `docs/restore.md`; the restore drill
> runs in the test suite.

**Goal:** the database and the receipt files can be restored to the same point in time, and the restore procedure has been tested.

1. **Make R2 write-once:** never overwrite or delete a file in the bucket.
   - Transaction receipts: `transactions/:id/<timestamp>-<random>.<ext>`, as bills already do. Keep the old receipt (it's referenced by the audit row).
   - Check that the invoice PDF, the logo and the original QuickBooks PDF keys are unique for every upload.
   - With that in place, restoring the database to *any* earlier point still finds every file it refers to.
2. **Nightly scheduled backup** (a cron trigger in `wrangler.toml`, `scheduled()` handler in `index.ts`, `services/backup.ts`):
   - Export every table to NDJSON, gzip it with fflate, and write it to `backups/db/YYYY-MM-DD.ndjson.gz`. Use a **separate** R2 bucket, `ledgerlite-backups`, so a problem in the main bucket can't take the backups with it.
   - Write a manifest `backups/manifest/YYYY-MM-DD.json` with row counts, a SHA-256 of each table, the list of R2 keys the database refers to, and whether each key exists.
   - Lifecycle rule on the backup bucket: keep daily backups for 35 days and the first backup of each month for 7 years (HMRC requires records to be kept for 6 years).
3. **Back up the receipts:** turn on **R2 bucket replication or versioning** (if the account has it). Otherwise the nightly job copies any object not yet in `ledgerlite-backups/files/`. Because keys are never reused (step 1), this only ever adds files.
4. **Health check:** `GET /api/v1/settings/backups` (owner only) shows the last backup's time, size, row counts and any missing files. The dashboard shows a warning if the last backup is more than 36 hours old.
5. **`docs/restore.md` runbook:**
   - (a) Recent mistake: use D1 Time Travel `wrangler d1 time-travel restore accounts-db --timestamp=…`. Receipts are fine because R2 is write-once.
   - (b) Full loss: create a new D1 database, run the migrations, load the NDJSON with `scripts/restore-backup.ts`, point the binding at it, and copy `files/` back.
   - (c) Check it: run the manifest checker.
6. **Restore drill:** `scripts/restore-backup.ts --local` restores the latest backup into local D1, and a test checks that the row counts and hashes match the manifest. Run it once before going live (phase 7b) and then every quarter.

**Done when:** a nightly backup lands in its own bucket, the dashboard shows its age, and a restore drill from it has passed once.

---

## Phase 5 — VAT accuracy ✅ done 2026-10-22

> Decided: 20% on UK sales; services to customers outside the UK are outside the scope of UK VAT
> (client/invoice `vat_treatment`); VAT scheme is a setting, default standard. Built: sales credit
> notes (full or partial, auto-applied, refundable by hand or from the bank), the VAT return boxes
> on `/periods`, category `vat_box`, and 0/5/20% rates on new lines.
> **Not built:** supplier credit notes (a supplier refund can be a money-in bank line in a purchase
> category, which the VAT return already nets off); an `exempt` treatment (not needed so far);
> reverse charge on services bought from abroad; the P&L still counts negative bank lines in every
> category (loans, transfers) as expenses — `vat_box` could drive that too.

**Goal:** correct an invoice, refund money and record a supplier credit without breaking VAT or the P&L, plus a VAT summary the accountant can check against.

1. **Credit notes for sales invoices** (migration 029):
   - `invoices.kind TEXT NOT NULL DEFAULT 'invoice' CHECK (kind IN ('invoice','credit_note'))` and `credits_invoice_id TEXT REFERENCES invoices(id)`. Credit notes are numbered separately: `CN-YYYY-NNNN` (`company_settings.credit_note_next_sequence`).
   - Amounts are stored **positive**, and `kind` gives the sign. `money.ts` gets `signedTotal(kind, total)` so reports never subtract by hand.
   - Rules: the credit note's lines copy the original's VAT rates. The credited total can't exceed the original's total minus credits already issued. It's dated on its own date (period lock, phase 3).
   - Applying a credit note reduces the original invoice's outstanding balance (an allocation row in `credit_allocations(credit_note_id, invoice_id, amount)`). Any remainder can be refunded (step 3).
   - A PDF titled "Credit note" that refers to the original invoice number.
   - Frontend: a "Credit / correct" button on finalised invoices. It creates a full or partial credit note and, if needed, a new corrected invoice.
2. **Supplier credit notes for bills:** the same pattern for `bills` (`kind`, `credits_bill_id`) with allocations against the original bill.
3. **Refunds:**
   - `checkAllocation` accepts **money out against a sales credit note** (refund to a client) and **money in against a supplier credit note** (refund from a vendor).
   - Matching, posting and undoing work as for invoices and bills. `matchCandidates` offers open credit notes in the opposite direction.
   - Bank lines with no document (e.g. a card refund from a shop) already work through a category with a positive amount. Make sure `vatInGross` handles positive amounts in expense categories, so that VAT reclaimed goes down rather than up.
4. **VAT summary report:** `GET /reports/vat-return?from&to`, showing boxes 1, 4, 6 and 7 (plus 2, 8 and 9 as 0), worked out using the business's VAT scheme. **Decision needed: cash or accrual (standard) VAT accounting?** The P&L is on a cash basis. Cash accounting uses payment dates, while standard accounting uses invoice and bill dates and credit note dates.
   - Show it on `/periods` next to the lock button, so the accountant reviews the figures and locks in one place.
   - Add a "VAT return" sheet to the accountant export.
5. **Rate checks:** allow only the UK rates (0, 0.05, 0.20) plus "exempt" and "outside scope" (store these two as separate flags, `vat_treatment`, and not as rate 0, so boxes 6 and 7 are correct). Turn the existing REAL `tax_rate` into a fixed list in Zod, and keep the column type as it is.
6. **Tests:** a credit note reduces outstanding and VAT in the right period. A partial credit plus a refund leaves the balance at zero. Credit can't exceed the original's total. The VAT summary for a fixed set of data matches a hand-worked figure.

**Done when:** a wrong invoice can be corrected with a credit note and a new invoice, a refund can be matched to a bank line, and the quarter's VAT boxes come out right.

---

## Decisions needed before starting

1. **Phase 3:** when does each VAT quarter end (e.g. Mar/Jun/Sep/Dec)? And can the owner unlock alone, or does the accountant have to agree?
2. **Phase 4:** is the Cloudflare account on Workers Paid (cron triggers, Time Travel goes back 30 days rather than 7)? Is a second R2 bucket acceptable?
3. **Phase 5:** is the business on the cash VAT scheme or standard (accrual) accounting? Is it on the Flat Rate Scheme? (That would change box 1 completely.)

## Order of work

| # | Phase | Size (est.) | Depends on |
|---|---|---|---|
| 1 | Audit trail | M | — |
| 2 | Reconciliation integrity | M | 1 (audit statements) |
| 3 | Period locking | M | 1 |
| 4 | Backups and recovery | M | — (can run alongside) |
| 5 | VAT accuracy | L | 3 |
