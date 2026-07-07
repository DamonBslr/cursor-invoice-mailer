# Cursor Invoice Mailer

Automates fetching your latest Cursor billing invoice(s) and emailing them as
PDF attachments. Built with Playwright + TypeScript, deployed as a Vercel
Cron job.

- **Session reuse, not password automation on every run.** You log in once,
  locally, in a real browser (`npm run bootstrap-login`). The resulting
  session is encrypted and stored in Vercel Blob. The scheduled job reuses
  that session — it never re-types your password unattended.
- **Daily cron, effectively monthly delivery.** Vercel Cron triggers the job
  daily, but a small ledger (also in Vercel Blob) tracks which invoices have
  already been emailed, so you only ever get a new email when a new invoice
  actually appears.
- **Configurable invoice source.** The billing page URL and the CSS
  selectors used to find invoice rows/dates/download links are all
  environment variables — no code changes needed if Cursor's page layout
  differs from the defaults.
- **Pluggable email delivery.** SMTP (via nodemailer) or an email API
  (Resend or SendGrid), selected via `MAIL_PROVIDER`.
- **Retries, structured logs, dry-run.** Every network-ish step retries with
  exponential backoff; every run emits structured JSON logs tagged with a
  run ID; `DRY_RUN=true` (or `--dry-run`) runs the full pipeline without
  sending mail or marking anything as sent.

## How it works

```
scripts/bootstrap-login.ts   (run once, locally, headed browser)
        │  log in manually, including any 2FA/verification step
        ▼
  encrypted session  ──────────────►  Vercel Blob
        ▲
        │  loaded + decrypted each run
api/cron/invoice-mailer.ts   (Vercel Cron, daily)
        │
        ▼
  src/job.ts
   1. load + decrypt session
   2. launch headless Chromium (playwright-core + @sparticuz/chromium)
   3. navigate to INVOICE_SOURCE_URL
   4. scrape invoice rows (configurable selectors)
   5. skip invoices already recorded in the ledger
   6. download new invoice PDF(s)
   7. DRY_RUN? → log what would be sent, stop here
   8. email PDF(s) via SMTP / Resend / SendGrid
   9. record sent invoice id(s) in the ledger
```

## Prerequisites

- Node.js 18.18+
- A [Vercel](https://vercel.com) project + a [Vercel Blob](https://vercel.com/docs/storage/vercel-blob)
  store (used to persist the encrypted session and the sent-invoice ledger)
- An SMTP account, or a [Resend](https://resend.com) / [SendGrid](https://sendgrid.com) API key

## Setup

### 1. Install

```bash
npm install
npx playwright install chromium   # local browser, used by bootstrap-login & run-once
```

### 2. Configure environment

```bash
cp .env.example .env
```

Fill in `.env`, in particular:

- `CURSOR_LOGIN_EMAIL` / `CURSOR_LOGIN_PASSWORD` — used only by the local
  bootstrap script, never deployed.
- `RECIPIENT_EMAIL`, `MAIL_PROVIDER` and the matching provider settings.
- `SESSION_ENCRYPTION_KEY` — generate one with:

  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```

- `BLOB_READ_WRITE_TOKEN` — from your Vercel project's Blob store settings.
- `CRON_SECRET` — any random string; used to authenticate Vercel's cron
  requests to the API route (see [Security](#security)).

### 3. Capture your login session

```bash
npm run bootstrap-login
```

A real Chrome window opens at your invoice page. If it redirects to a login
form, your email/password are auto-filled where possible — but **you**
complete anything automation shouldn't: a verification code, 2FA, a
CAPTCHA, whatever Cursor throws at that particular login. Once you're
looking at the billing/invoice page, go back to the terminal and press
Enter. Your session is encrypted and uploaded to Vercel Blob.

### 4. Verify the scrape locally (dry run)

```bash
npm run run-once -- --dry-run
```

This loads the session, navigates to the invoice page, scrapes rows, and
downloads PDF(s) to a temp directory — but does **not** send email or update
the ledger. Check the logged output:

- If no rows are found, adjust `INVOICE_ROW_SELECTOR` / `INVOICE_DATE_SELECTOR`
  / `INVOICE_DOWNLOAD_SELECTOR` in `.env` to match the actual page markup
  (open browser devtools on the real billing page to find the right
  selectors), then re-run.
- If it reports the session looks expired, re-run `npm run bootstrap-login`.

### 5. Try a real send (optional, local)

```bash
npm run run-once
```

This will actually email the latest invoice (if not already in the ledger)
using your configured `MAIL_PROVIDER`.

### 6. Deploy to Vercel

1. Push this project to a Git repo and import it into Vercel, or run
   `vercel deploy` from this directory.
2. Add every variable from `.env` (except you can omit
   `CURSOR_LOGIN_EMAIL`/`CURSOR_LOGIN_PASSWORD` — they're only used locally)
   as Vercel **Project Environment Variables**.
3. Deploy. `vercel.json` registers the daily cron:

   ```json
   { "crons": [{ "path": "/api/cron/invoice-mailer", "schedule": "0 9 * * *" }] }
   ```

4. From now on, whenever a new invoice appears, the next daily run will
   detect, download, and email it — and won't email it again.

## Configuration reference

| Variable | Purpose | Default |
|---|---|---|
| `INVOICE_SOURCE_URL` | Billing/invoice page to scrape | `https://cursor.com/settings/billing` |
| `INVOICE_ROW_SELECTOR` | CSS selector matching each invoice row | `[data-testid="invoice-row"], table tbody tr` |
| `INVOICE_DATE_SELECTOR` | Selector (scoped to a row) for the invoice date | `[data-testid="invoice-date"], td:nth-child(1)` |
| `INVOICE_DOWNLOAD_SELECTOR` | Selector (scoped to a row) for the download link/button | `a[href*="invoice"], a[download]` |
| `INVOICE_COUNT` | How many latest invoices to check each run | `1` |
| `RECIPIENT_EMAIL` | Destination address(es), comma-separated | — |
| `MAIL_PROVIDER` | `smtp` \| `resend` \| `sendgrid` | `smtp` |
| `MAIL_FROM` | From address/name | — |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` | SMTP settings | — |
| `RESEND_API_KEY` | Resend API key | — |
| `SENDGRID_API_KEY` | SendGrid API key | — |
| `SESSION_ENCRYPTION_KEY` | 32-byte hex key for AES-256-GCM | — |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob token | — |
| `SESSION_BLOB_KEY` | Blob pathname for the encrypted session | `cursor-invoice-mailer/session.enc` |
| `LEDGER_BLOB_KEY` | Blob pathname for the sent-invoice ledger | `cursor-invoice-mailer/ledger.json` |
| `CRON_SECRET` | Verifies Vercel Cron requests | — |
| `DRY_RUN` | Skip sending/ledger updates when `true` | `false` |
| `MAX_RETRIES` | Retry attempts per step | `3` |
| `RETRY_DELAY_MS` | Base retry delay (doubles each attempt) | `1000` |
| `LOG_LEVEL` | pino log level | `info` |

## Security

- **No password on the server.** `CURSOR_LOGIN_EMAIL`/`CURSOR_LOGIN_PASSWORD`
  are read only by the local `bootstrap-login` script and are never uploaded
  or used by the deployed cron job.
- **Session is encrypted at rest.** The Playwright `storageState` (cookies)
  is encrypted with AES-256-GCM (`SESSION_ENCRYPTION_KEY`) before being
  written to Vercel Blob. Vercel Blob's "public" access tier is used (a
  private-token-gated tier isn't available for arbitrary blobs at the time
  of writing) — the object is only reachable via its long random URL, and
  even if that URL leaked, the contents are still encrypted. Keep
  `SESSION_ENCRYPTION_KEY` and `BLOB_READ_WRITE_TOKEN` as secrets, never
  commit them.
- **Cron route is authenticated.** `api/cron/invoice-mailer.ts` rejects any
  request whose `Authorization` header doesn't match `Bearer $CRON_SECRET`,
  which Vercel sends automatically for cron-triggered invocations once
  `CRON_SECRET` is set as a project env var.
- **Session expiry fails loudly.** If the stored session no longer works
  (logged out, revoked, password changed), the job throws a clear error
  instead of attempting an unattended login — check the Vercel function
  logs and re-run `npm run bootstrap-login`.

## Known limitations / things to verify for your account

- The default CSS selectors are best-effort placeholders — Cursor's actual
  billing page markup wasn't available to inspect ahead of time. Run
  `npm run run-once -- --dry-run` after bootstrapping and adjust
  `INVOICE_*_SELECTOR` env vars if no rows are detected.
- Vercel Cron's minimum interval is daily; true monthly-only delivery is
  achieved by the ledger dedupe logic, not by the schedule itself.
- Running a full Chromium browser in a serverless function can exceed the
  Vercel Hobby plan's default execution time limit. `vercel.json` requests
  `maxDuration: 120` for the cron function, which requires a Pro plan (or
  Fluid Compute) — lower it if you're intentionally staying on Hobby and
  confirm the job still completes in time via the function logs.

## Local commands

| Command | Description |
|---|---|
| `npm run bootstrap-login` | One-time interactive login, captures + uploads encrypted session |
| `npm run run-once` | Runs the full job locally once (sends email if a new invoice exists) |
| `npm run run-once -- --dry-run` | Same, but never sends email or updates the ledger |
| `npm run typecheck` | TypeScript type checking |
| `npm run lint` | ESLint |
