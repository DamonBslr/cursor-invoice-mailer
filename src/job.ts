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
import { navigateToInvoicePage, scrapeInvoices, downloadInvoice, type DownloadedInvoice } from "./browser/invoices.js";
import { loadLedger, hasBeenSent, recordSent, touchLedger } from "./ledger/store.js";
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
 * run-once script: load session -> launch browser -> navigate -> scrape ->
 * dedupe against the ledger -> download -> (dry-run short-circuit) -> email
 * -> record sent. Every network-ish step is wrapped in retry/backoff and
 * logged with a shared runId.
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
    throw new Error(
      'No stored session found. Run "npm run bootstrap-login" once from a local machine to log in and capture a session before the scheduled job can run.',
    );
  }

  const storageState = JSON.parse(sessionJson);
  const browser = await withRetry(() => launchBrowser({ headless: true }), { ...retryDefaults, label: "launchBrowser" });
  const tmpDir = await mkdtemp(path.join(tmpdir(), "cursor-invoice-mailer-"));

  try {
    const context = await browser.newContext({ storageState, acceptDownloads: true });
    await applyStealth(context);
    const page = await context.newPage();

    await withRetry(() => navigateToInvoicePage(page, config), { ...retryDefaults, label: "navigateToInvoicePage" });
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
            hasInvoicesHeading: bodyText.includes("Invoices"),
            tableCount: doc?.querySelectorAll("table").length ?? 0,
          };
        })
        .catch((err) => ({ evalError: err instanceof Error ? err.message : String(err) }));
      logger.warn({ url: page.url(), diagnostics }, "No invoice rows matched — diagnostics for this page load");

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

    const downloaded: DownloadedInvoice[] = [];
    for (const invoice of newInvoices) {
      const result = await withRetry(() => downloadInvoice(context, invoice, tmpDir, config), {
        ...retryDefaults,
        label: `downloadInvoice:${invoice.id}`,
      });
      downloaded.push(result);
      logger.info({ invoiceId: invoice.id, fileName: result.fileName }, "Downloaded invoice PDF");
    }

    if (dryRun) {
      logger.info(
        {
          wouldSendTo: config.recipients,
          attachments: downloaded.map((d) => d.fileName),
        },
        "DRY_RUN enabled — skipping email send and ledger update",
      );
      return {
        runId,
        dryRun,
        sentInvoiceIds: [],
        skippedAlreadySent: alreadySent,
        message: `Dry run: would have emailed ${downloaded.length} invoice(s) to ${config.recipients.join(", ")}.`,
      };
    }

    const mailer = await createMailer(config);
    const attachments = await Promise.all(
      downloaded.map(async (d) => ({
        filename: d.fileName,
        content: await readFile(d.filePath),
        contentType: "application/pdf",
      })),
    );

    const dateTexts = downloaded.map((d) => d.dateText);
    const subject =
      dateTexts.length === 1 ? `Cursor Invoice — ${dateTexts[0]}` : `Cursor Invoices — ${dateTexts.join(", ")}`;

    await withRetry(
      () =>
        mailer.send({
          to: config.recipients,
          from: config.MAIL_FROM,
          subject,
          text: `Attached: ${downloaded.length} Cursor invoice(s) (${downloaded.map((d) => d.dateText).join(", ")}).`,
          attachments,
        }),
      { ...retryDefaults, label: "sendEmail" },
    );

    let updatedLedger = ledger;
    for (const invoice of newInvoices) {
      updatedLedger = await recordSent(updatedLedger, invoice.id, config);
    }

    logger.info({ sent: newInvoices.map((i) => i.id) }, "Emailed invoice(s) and updated ledger");

    return {
      runId,
      dryRun,
      sentInvoiceIds: newInvoices.map((i) => i.id),
      skippedAlreadySent: alreadySent,
      message: `Emailed ${downloaded.length} invoice(s) to ${config.recipients.join(", ")}.`,
    };
  } finally {
    await browser.close().catch(() => undefined);
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
