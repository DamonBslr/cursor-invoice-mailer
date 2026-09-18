import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "./config.js";
import { createRunLogger } from "./logger.js";
import { withRetry } from "./retry.js";
import { loadSession } from "./session/store.js";
import { launchBrowser } from "./browser/launch.js";
import { applyStealth } from "./browser/stealth.js";
import {
  navigateToInvoicePage,
  scrapeInvoices,
  downloadInvoice,
  invoicePageBlockError,
} from "./browser/invoices.js";
import { SessionAccessError } from "./errors.js";
import { loadLedger, hasBeenSent, needsSeedMigration, recordSent, seedExistingInvoices, touchLedger } from "./ledger/store.js";
import { notifyAdminOfSessionFailure } from "./mail/admin-alert.js";
import { createMailer } from "./mail/index.js";

export interface JobResult {
  runId: string;
  dryRun: boolean;
  sentInvoiceIds: string[];
  skippedAlreadySent: string[];
  message: string;
}

export interface RunJobOptions {
  /** Forces dry-run regardless of the DRY_RUN env var (used by the local CLI's --dry-run flag). */
  dryRunOverride?: boolean;
}

/**
 * The single orchestrator used by both the Vercel Cron route and the local
 * run-once script: load session -> launch browser -> navigate -> scrape all
 * rows -> one-time historical seed if needed -> dedupe against the ledger ->
 * download + email + record each unsent invoice individually. Every
 * network-ish step is wrapped in retry/backoff and logged with a shared runId.
 */
export async function runJob(options: RunJobOptions = {}): Promise<JobResult> {
  const config = loadConfig();
  const runId = randomUUID();
  const logger = createRunLogger(runId);
  const dryRun = options.dryRunOverride ?? config.DRY_RUN;

  logger.info({ dryRun, invoiceSource: config.INVOICE_SOURCE_URL }, "Starting invoice mailer run");

  const retryDefaults = { retries: config.MAX_RETRIES, delayMs: config.RETRY_DELAY_MS, logger };

  const sessionJson = await withRetry(() => loadSession(config), { ...retryDefaults, label: "loadSession" });

  if (!sessionJson) {
    const missing = new SessionAccessError(
      'No stored session found. Run "npm run bootstrap-login" once from a local machine to log in and capture a session before the scheduled job can run.',
    );
    await notifyAdminOfSessionFailure({ config, logger, runId, dryRun, error: missing });
    throw missing;
  }

  const storageState = JSON.parse(sessionJson);
  const browser = await withRetry(() => launchBrowser({ headless: true }), { ...retryDefaults, label: "launchBrowser" });
  const tmpDir = await mkdtemp(path.join(tmpdir(), "cursor-invoice-mailer-"));

  try {
    const context = await browser.newContext({ storageState, acceptDownloads: true });
    await applyStealth(context);
    const page = await context.newPage();

    // Captured for the zero-rows diagnostics below — if the page's own JS
    // threw (rather than the invoice data merely not being there), this is
    // usually the fastest way to find out why.
    const consoleMessages: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (msg) => consoleMessages.push(`[${msg.type()}] ${msg.text()}`));
    page.on("pageerror", (err) => pageErrors.push(err.message));

    const { httpStatus } = await withRetry(() => navigateToInvoicePage(page, config), {
      ...retryDefaults,
      label: "navigateToInvoicePage",
    });
    const invoices = await withRetry(() => scrapeInvoices(page, config), { ...retryDefaults, label: "scrapeInvoices" });

    logger.info({ found: invoices.length }, "Scraped invoice rows");

    if (invoices.length === 0) {
      // Distinguish "genuinely no invoices" from "page didn't render what we
      // expected" — this environment runs a more easily fingerprinted
      // headless build than local dev/bootstrap, so a valid session can
      // still land on a page that renders without the invoice data.
      const diagnostics = await page
        .evaluate(() => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- `document` isn't declared in this project's (deliberately DOM-less) tsconfig lib; this callback runs in the browser, not Node.
          const doc = (globalThis as any).document;
          const bodyText: string = doc?.body?.innerText ?? "";
          return {
            title: doc?.title ?? "",
            bodyTextLength: bodyText.length,
            bodyTextSample: bodyText.slice(0, 2000),
            tableCount: doc?.querySelectorAll("table").length ?? 0,
            hasPasswordField: (doc?.querySelectorAll('input[type="password"]').length ?? 0) > 0,
          };
        })
        .catch((err) => ({ evalError: err instanceof Error ? err.message : String(err) }));

      const lateBlock =
        "evalError" in diagnostics
          ? null
          : invoicePageBlockError({
              url: page.url(),
              httpStatus,
              title: diagnostics.title,
              bodyTextSample: diagnostics.bodyTextSample,
              hasPasswordField: diagnostics.hasPasswordField,
            });
      if (lateBlock) {
        logger.error(
          {
            url: page.url(),
            httpStatus,
            diagnostics,
            consoleMessages: consoleMessages.slice(-20),
            pageErrors: pageErrors.slice(-20),
          },
          "Invoice page was blocked after navigation (login or Cloudflare challenge)",
        );
        throw lateBlock;
      }

      logger.warn(
        {
          url: page.url(),
          httpStatus,
          diagnostics,
          consoleMessages: consoleMessages.slice(-20),
          pageErrors: pageErrors.slice(-20),
        },
        "No invoice rows matched — diagnostics for this page load",
      );

      await touchLedger(await loadLedger(config), config);
      return {
        runId,
        dryRun,
        sentInvoiceIds: [],
        skippedAlreadySent: [],
        message: "No invoices found on the billing page (check INVOICE_*_SELECTOR configuration).",
      };
    }

    const ledger = await loadLedger(config);

    if (needsSeedMigration(ledger)) {
      const seedIds = invoices.map((inv) => inv.id);
      if (dryRun) {
        logger.info(
          { wouldSeed: seedIds },
          "DRY_RUN enabled — would seed existing invoices as already sent without emailing",
        );
        return {
          runId,
          dryRun,
          sentInvoiceIds: [],
          skippedAlreadySent: [],
          message: `Dry run: would seed ${seedIds.length} existing invoice(s) as sent without emailing.`,
        };
      }

      await seedExistingInvoices(ledger, seedIds, config);
      logger.info({ seeded: seedIds }, "Seeded existing invoices as sent (ledger v2 migration) — no emails");
      return {
        runId,
        dryRun,
        sentInvoiceIds: [],
        skippedAlreadySent: seedIds,
        message: `Seeded ${seedIds.length} existing invoice(s) as already sent. Future runs will email only new invoices.`,
      };
    }

    const newInvoices = invoices.filter((inv) => !hasBeenSent(ledger, inv.id));
    const alreadySent = invoices.filter((inv) => hasBeenSent(ledger, inv.id)).map((inv) => inv.id);

    if (newInvoices.length === 0) {
      logger.info({ alreadySent }, "No new invoices since last run — nothing to send");
      await touchLedger(ledger, config);
      return {
        runId,
        dryRun,
        sentInvoiceIds: [],
        skippedAlreadySent: alreadySent,
        message: "No new invoices since last run.",
      };
    }

    const mailer = dryRun ? null : await createMailer(config);
    let updatedLedger = ledger;
    const sentIds: string[] = [];

    for (const invoice of newInvoices) {
      const downloaded = await withRetry(() => downloadInvoice(context, invoice, tmpDir, config), {
        ...retryDefaults,
        label: `downloadInvoice:${invoice.id}`,
      });
      logger.info(
        { invoiceId: invoice.id, files: downloaded.files.map((f) => f.fileName) },
        "Downloaded invoice and receipt PDFs",
      );

      if (dryRun || !mailer) {
        logger.info(
          {
            invoiceId: invoice.id,
            dateText: downloaded.dateText,
            wouldSendTo: config.recipients,
            attachments: downloaded.files.map((f) => f.fileName),
          },
          "DRY_RUN enabled — would email this invoice",
        );
        continue;
      }

      const attachments = await Promise.all(
        downloaded.files.map(async (f) => ({
          filename: f.fileName,
          content: await readFile(f.filePath),
          contentType: "application/pdf",
        })),
      );

      await withRetry(
        () =>
          mailer.send({
            to: config.recipients,
            from: config.MAIL_FROM,
            subject: `Cursor Invoice & Receipt — ${downloaded.dateText}`,
            text: `Attached: invoice and receipt PDFs for Cursor billing period ${downloaded.dateText}.`,
            attachments,
          }),
        { ...retryDefaults, label: `sendEmail:${invoice.id}` },
      );

      updatedLedger = await recordSent(updatedLedger, invoice.id, config);
      sentIds.push(invoice.id);
      logger.info({ invoiceId: invoice.id, attachments: downloaded.files.map((f) => f.fileName) }, "Emailed invoice and updated ledger");
    }

    return {
      runId,
      dryRun,
      sentInvoiceIds: sentIds,
      skippedAlreadySent: alreadySent,
      message: dryRun
        ? `Dry run: would have emailed ${newInvoices.length} invoice(s) with receipt(s) to ${config.recipients.join(", ")}.`
        : `Emailed ${sentIds.length} invoice(s) with receipt(s) to ${config.recipients.join(", ")}.`,
    };
  } catch (err) {
    if (err instanceof SessionAccessError) {
      await notifyAdminOfSessionFailure({ config, logger, runId, dryRun, error: err });
    }
    throw err;
  } finally {
    await browser.close().catch(() => undefined);
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
