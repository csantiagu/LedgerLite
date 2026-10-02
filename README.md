# LedgerLite

Lightweight bookkeeping for a small UK limited company, built to replace a QuickBooks subscription.

It covers the jobs a one- or two-person company actually does: raise a few invoices a month, record supplier bills, import bank statements, explain every bank line, and hand the accountant a clean spreadsheet each VAT quarter and at year end. It runs on Cloudflare Workers, D1 and R2, and is designed to fit within the free or $5/month plan.

> **Status:** built for one small company and not yet deployed or hardened for general production use. It is not accounting advice and does not file anything with HMRC. See [Limitations](#limitations).

## Features

- **Invoices**: line items with VAT, branded PDFs (logo, company and bank details), payments, voiding
- **Bills**: supplier bills with expense categories per line and attached PDFs
- **Bank import**: CSV import for Barclays, HSBC, Lloyds, NatWest, Monzo and Starling, with de-duplication and a running-balance check
- **Reconciliation**: auto-suggested matches between bank lines and open invoices/bills, partial payments across several lines, posted atomically
- **Categorisation rules**: "description contains `HMRC VAT` → VAT Payments", applied on every import so recurring payments (VAT, PAYE, subscriptions) are never missed
- **Accountant export**: an `.xlsx` per VAT quarter or custom period with every bank line, its category and explanation, plus invoices and bills (optionally zipped with receipts)
- **Reports**: P&L, outstanding invoices, aged debtors, cash flow, and a year-end ZIP per UK tax year
- **Two roles**: `owner` (everything) and `accountant` (read, flag, add notes, export), enforced on the server

## Stack

| Layer | Tech |
|---|---|
| API | Cloudflare Workers, [Hono](https://hono.dev), TypeScript, Zod |
| Database | Cloudflare D1 (SQLite), plain SQL migrations |
| Files | Cloudflare R2 (private; all access goes through the Worker) |
| Rate limiting | Cloudflare KV |
| Frontend | Next.js 14 (App Router), TanStack Query, React Hook Form, Tailwind |
| PDFs / ZIPs | pdf-lib, fflate (including a small built-in `.xlsx` writer) |
| Tests | Vitest with `@cloudflare/vitest-pool-workers` (runs against a real local D1) |

Money is stored as integer pence everywhere and only formatted for display. Totals are always recalculated on the server.

## Getting started

Requirements: Node.js 22+ and npm.

```bash
git clone https://github.com/csantiagu/LedgerLite.git
cd LedgerLite

# API
cd worker
npm install
cp .dev.vars.example .dev.vars          # then set JWT_SECRET and API_KEY_SALT
npx wrangler d1 migrations apply accounts-db --local
npm run dev -- --port 8787

# Frontend (second terminal)
cd frontend
npm install
cp .env.example .env.local
npm run dev                             # http://localhost:3001
```

Open <http://localhost:3001/setup> to create the first owner account, then add your company details under **Company** and your bank accounts under **Bank accounts**.

`ALLOWED_ORIGIN` in `worker/.dev.vars` must match the frontend origin exactly (CORS is locked to it).

To start from an empty database: `rm -rf worker/.wrangler/state` and apply the migrations again.

## Tests

```bash
cd worker
npm run typecheck   # app + tests
npm test            # unit tests + API integration tests against a fresh D1 with all migrations
```

CI runs these plus a frontend type-check and production build on every push and pull request.

## Project layout

```
worker/
  src/index.ts          Hono app, route registration
  src/middleware/       auth (JWT + API keys), RBAC, CSRF, rate limiting, audit log
  src/routes/           clients, vendors, invoices, bills, bank accounts/imports,
                        transactions, matches, categorisation rules, reports
  src/services/         money, CSV parsing, matching, rules, PDF, xlsx, exports
  migrations/           numbered D1 migrations
  test/                 unit/ and integration/ tests
frontend/
  src/app/              pages (App Router)
  src/components/       layout, match panel, role guard
  src/lib/              API client (silent token refresh), auth store, formatters
docs/plan.md            original build plan and design notes
```

## Deployment

Deployment to Cloudflare is not finished yet. The outline:

1. Create the D1 database, R2 bucket and KV namespace, and put their IDs in `worker/wrangler.toml`.
2. `wrangler secret put JWT_SECRET` and `wrangler secret put API_KEY_SALT`; set `ALLOWED_ORIGIN` to the frontend URL and `ENVIRONMENT=production`.
3. `wrangler d1 migrations apply accounts-db --remote`, then `wrangler deploy`.
4. Deploy the frontend with `NEXT_PUBLIC_API_URL` pointing at the Worker.

See `docs/plan.md` (Phase 6–7) for details.

## Limitations

- **Single company, GBP, UK only.** One set of books per deployment; UK tax years and VAT quarters.
- **No HMRC filing.** There is no Making Tax Digital (MTD) VAT submission and no payroll. The export is designed for an accountant who files.
- **Frontend is not a static export yet.** The dev setup uses Next.js rewrites. Next 14 has open advisories that affect self-hosted Next servers; the plan is a static export (or Next 16) before deployment.
- **Rate limiting writes to KV on every API request**, which exceeds the KV free-tier write quota under real use. A Cloudflare Rate Limiting binding would be a better fit.
- **Password hashes don't record their PBKDF2 iteration count**, so changing `ENVIRONMENT` between `local` and production invalidates existing local passwords.

## Licence

[MIT](LICENSE)
