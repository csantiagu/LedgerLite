<p align="center"><img src="docs/logo.png" alt="LedgerLite" width="240"></p>

# LedgerLite

Lightweight bookkeeping for a small UK limited company, built to replace a QuickBooks subscription.

It covers the jobs a one- or two-person company actually does: raise a few invoices a month, record supplier bills, import bank statements, explain every bank line, and hand the accountant a clean spreadsheet each VAT quarter and at year end. It runs on Cloudflare Workers, D1 and R2, and is designed to fit within the free or $5/month plan.

> **Status:** built for one small company and not yet deployed or hardened for general production use. It is not accounting advice and does not file anything with HMRC. See [Limitations](#limitations).

## Features

- **Invoices**: line items with VAT, branded PDFs (logo, company and bank details), payments, voiding
- **QuickBooks import**: bring past invoices across from a QuickBooks Online export (CSV or Excel) with their original numbers, customers, VAT and paid/outstanding status, attach the original PDFs, and carry on the numbering
- **Bills**: supplier bills with expense categories per line and attached PDFs
- **Bank import**: CSV import for Barclays, HSBC, Lloyds, NatWest, Monzo and Starling, with de-duplication and a running-balance check
- **Reconciliation**: auto-suggested matches between bank lines and open invoices/bills, partial payments across several lines, posted atomically
- **Categorisation rules**: "description contains `HMRC VAT` → VAT Payments", applied on every import so recurring payments (VAT, PAYE, subscriptions) are never missed
- **Accountant export**: an `.xlsx` per VAT quarter or custom period with every bank line, its category and explanation, plus invoices and bills (optionally zipped with receipts)
- **Reports**: P&L, outstanding invoices, aged debtors, cash flow, and a year-end ZIP per UK tax year
- **Two roles**: `owner` (everything) and `accountant` (read, flag, add notes, export), enforced on the server
- **Secure sign-in**: two-factor login, session revocation and the rest of [Security](#security)

## Stack

| Layer | Tech |
|---|---|
| API | Cloudflare Workers, [Hono](https://hono.dev), TypeScript, Zod |
| Database | Cloudflare D1 (SQLite), plain SQL migrations |
| Files | Cloudflare R2 (private; all access goes through the Worker) |
| Rate limiting | Workers Rate Limiting binding |
| Frontend | Next.js 16 (App Router, static export on Cloudflare Pages), React 19, TanStack Query, React Hook Form, Tailwind |
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
cp .dev.vars.example .dev.vars          # then set JWT_SECRET, API_KEY_SALT and ENCRYPTION_KEY
npx wrangler d1 migrations apply accounts-db --local
npm run dev -- --port 8787

# Frontend (second terminal)
cd frontend
npm install
npm run dev                             # http://localhost:3001 (calls the API on :8787)
```

Open <http://localhost:3001/setup> to create the first owner account, then add your company details under **Company** and your bank accounts under **Bank accounts**.

`ALLOWED_ORIGIN` in `worker/.dev.vars` must match the dev frontend's origin exactly (CORS is locked to it). In production the site and the API share one origin (Pages forwards API paths to the Worker), so CORS doesn't come into it.

To start from an empty database: `rm -rf worker/.wrangler/state` and apply the migrations again.

## Tests

```bash
cd worker
npm run typecheck   # app + tests
npm test            # unit tests + API integration tests against a fresh D1 with all migrations
```

For the frontend: `npm run typecheck` and `npm run build` in `frontend/` (the build writes the static site to `frontend/out`).

CI runs all of these on every push and pull request.

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

## Security

The app holds bank statements and company finances, so sign-in is layered:

- **Passwords** are hashed with PBKDF2-SHA256 (100,000 iterations), need 12+ characters, and changing one signs out every other device.
- **Two-factor sign-in** with any authenticator app (TOTP), with single-use recovery codes. Turn it on under **Security**. The secrets are encrypted in the database.
- **Sessions:** a 15-minute access token kept only in memory, plus a refresh token in an `httpOnly`, `Secure`, `SameSite=Strict` cookie that is replaced on every use. If an old refresh token is ever replayed, every session for that user is revoked. **Security → Sign out everywhere** ends all sessions.
- **Immediate revocation:** each request re-checks the user, so deactivating someone or changing a password takes effect at once, including for their API keys.
- **First-owner setup** needs a `SETUP_TOKEN` secret, so nobody else can claim a fresh deployment.
- **Uploads** are identified by their content (PDF, PNG, JPEG, WebP only) and always served back as sandboxed downloads.
- **Rate limits** on login, two-factor codes, token refresh and the API; strict CORS; a CSRF header check; security headers (CSP, HSTS, `nosniff`, no framing, `no-store`) on the API and the static site.

## Deployment

Two pieces, one address:

- **`ledgerlite-api`**, a Cloudflare Worker with the API, D1 and R2. It has **no public URL** (`workers_dev = false`).
- **A Cloudflare Pages project** (e.g. `ledgerlite-books.pages.dev`) that serves the built frontend and forwards `/api/*` and `/auth/*` to the Worker through a service binding (`frontend/functions/`, `frontend/wrangler.toml`).

The browser only ever talks to the Pages address, so the `SameSite=Strict` sign-in cookie works, no CORS is involved, and the API can't be reached any other way. It all fits the free plan and needs no domain of your own.

1. Log in: `npx wrangler login` (in `worker/`), and check the account with `npx wrangler whoami`.
2. Create the database and the private file bucket, and put the database ID that `d1 create` prints into `worker/wrangler.toml`:

   ```bash
   npx wrangler d1 create accounts-db --location weur
   npx wrangler r2 bucket create accounts-storage --location weur
   npm run migrate:remote
   ```

   (R2 has to be enabled once in the dashboard first.) The three rate limiters need no setup beyond `namespace_id` values that are unique within your account.
3. Create the Pages project. Its name becomes the address, so pick one that isn't taken (Cloudflare adds a random suffix if it is), and put the same name in `frontend/wrangler.toml`:

   ```bash
   npx wrangler pages project create ledgerlite-books --production-branch main
   ```

4. Deploy both. `npm run deploy` deploys the API Worker, builds the frontend (which writes `out/_headers`, the site's security headers) and deploys it to Pages:

   ```bash
   npm run deploy
   ```

5. Set the Worker's secrets (each takes effect immediately). Until they are set the API answers "Server is misconfigured":

   ```bash
   openssl rand -base64 32 | npx wrangler secret put JWT_SECRET
   openssl rand -base64 32 | npx wrangler secret put API_KEY_SALT
   openssl rand -base64 32 | npx wrangler secret put ENCRYPTION_KEY   # encrypts 2FA secrets; changing it turns off everyone's 2FA
   openssl rand -hex 16 | tee ~/ledgerlite-setup-token.txt | npx wrangler secret put SETUP_TOKEN   # used once at /setup
   printf https://ledgerlite-books.pages.dev | npx wrangler secret put ALLOWED_ORIGIN   # the Pages address
   ```

   `ALLOWED_ORIGIN` is a secret rather than a `wrangler.toml` variable so a public copy of the code doesn't advertise where your login page is.
6. Open `/setup`, create the owner with the setup token, then turn on two-factor sign-in under **Security** straight away. Afterwards delete `~/ledgerlite-setup-token.txt` and run `npx wrangler secret delete SETUP_TOKEN`.

**A custom domain** is optional: add it to the Pages project (**Custom domains**) and put the new URL in the `ALLOWED_ORIGIN` secret.

To try the production layout locally, run the Worker (`npm run dev -- --port 8787` in `worker/`), build the frontend, and run `npx wrangler pages dev --port 3002` in `frontend/` (using the worker's wrangler); the service binding connects to the local Worker.

### Recommended: Cloudflare Access in front

For a one- or two-person company there is no reason for the login page to be reachable by the whole internet. [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-public-app/) is free for up to 50 users and stops every request at Cloudflare's edge until the visitor proves who they are (for example with a one-time code emailed to an allowed address):

In the Cloudflare dashboard, go to **Zero Trust → Access → Applications → Add an application → Self-hosted**, add the Pages address (e.g. `ledgerlite-books.pages.dev`, and `*.ledgerlite-books.pages.dev` to cover the per-deployment preview addresses), and add an **Allow** policy that includes only your email address and your accountant's. Keep **One-time PIN** as the login method, or add Google / Microsoft sign-in. Since the API Worker has no address of its own, this covers everything.

LedgerLite's own login and two-factor still apply behind Access; Access just means nobody else can even reach them.

See `docs/plan.md` (Phase 6–7) for details.

## Limitations

- **Single company, GBP, UK only.** One set of books per deployment; UK tax years and VAT quarters.
- **No HMRC filing.** There is no Making Tax Digital (MTD) VAT submission and no payroll. The export is designed for an accountant who files.
- **Rate limits are per Cloudflare location** and approximate (that's how the Rate Limiting binding works), which is fine for slowing down password guessing but not a hard quota.

## Licence

[MIT](LICENSE)
