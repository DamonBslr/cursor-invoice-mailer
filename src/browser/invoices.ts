import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import type { Config } from "../config.js";

export interface InvoiceInfo {
  /** Stable-ish identifier used for ledger dedupe (href hash, or date+index fallback). */
  id: string;
  /** Raw scraped date text, for logging/subject lines. */
  dateText: string;
  /** Absolute URL to the PDF, if one could be resolved from the row. */
  downloadUrl: string | null;
  rowIndex: number;
}

export interface DownloadedInvoice extends InvoiceInfo {
  filePath: string;
  fileName: string;
}

/**
 * Navigates to the configured invoice source URL and throws a clear,
 * actionable error if the session turns out to be invalid/expired (detected
 * via a redirect to a login-looking URL or the presence of a password
 * field), rather than failing confusingly deeper in the scrape step.
 */
export async function navigateToInvoicePage(page: Page, config: Config): Promise<void> {
  await page.goto(config.INVOICE_SOURCE_URL, { waitUntil: "domcontentloaded" });

  const looksLikeLogin =
    /\/(login|sign-?in|auth)(\/|$|\?)/i.test(page.url()) ||
    (await page.locator('input[type="password"]').count()) > 0;

  if (looksLikeLogin) {
    throw new Error(
      `Session appears expired or invalid — landed on a login page (${page.url()}) instead of the invoice page. ` +
        `Re-run "npm run bootstrap-login" to capture a fresh session.`,
    );
  }
}

/**
 * Scrapes the invoice table using the configurable selectors, returning up
 * to `config.INVOICE_COUNT` most recent rows in DOM order (the billing page
 * is assumed to list invoices newest-first, which is the Cursor/Stripe
 * convention).
 */
export async function scrapeInvoices(page: Page, config: Config): Promise<InvoiceInfo[]> {
  const rows = page.locator(config.INVOICE_ROW_SELECTOR);
  const count = await rows.count();

  const invoices: InvoiceInfo[] = [];

  for (let i = 0; i < count && invoices.length < config.INVOICE_COUNT; i++) {
    const row = rows.nth(i);

    const dateText = (await row.locator(config.INVOICE_DATE_SELECTOR).first().innerText().catch(() => "")).trim();

    const downloadLocator = row.locator(config.INVOICE_DOWNLOAD_SELECTOR).first();
    const hasDownload = (await downloadLocator.count()) > 0;
    let downloadUrl: string | null = null;

    if (hasDownload) {
      const href = await downloadLocator.getAttribute("href").catch(() => null);
      if (href) {
        downloadUrl = new URL(href, page.url()).toString();
      }
    }

    if (!dateText && !downloadUrl) {
      // Nothing usable on this row — likely a header row or selector mismatch.
      continue;
    }

    const idSource = downloadUrl ?? `${dateText}-${i}`;
    const id = createHash("sha256").update(idSource).digest("hex").slice(0, 16);

    invoices.push({ id, dateText: dateText || `row-${i}`, downloadUrl, rowIndex: i });
  }

  return invoices;
}

/**
 * Downloads a single invoice PDF to `destDir`. Prefers fetching the resolved
 * href directly through the authenticated browser context (most reliable for
 * direct PDF links); falls back to clicking the row's download control and
 * capturing Playwright's `download` event for JS-triggered downloads.
 */
export async function downloadInvoice(
  page: Page,
  context: BrowserContext,
  invoice: InvoiceInfo,
  destDir: string,
  config: Config,
): Promise<DownloadedInvoice> {
  await mkdir(destDir, { recursive: true });
  const fileName = `invoice-${invoice.dateText.replace(/[^\w-]+/g, "_") || invoice.id}.pdf`;
  const filePath = path.join(destDir, fileName);

  if (invoice.downloadUrl) {
    const response = await context.request.get(invoice.downloadUrl);
    if (!response.ok()) {
      throw new Error(`Failed to download invoice PDF: ${response.status()} ${response.statusText()}`);
    }
    const buffer = await response.body();
    await writeFile(filePath, buffer);
    return { ...invoice, filePath, fileName };
  }

  // Fallback for JS-triggered downloads (no plain href): click the row's
  // download control and capture Playwright's native `download` event.
  const row = page.locator(config.INVOICE_ROW_SELECTOR).nth(invoice.rowIndex);
  const downloadControl = row.locator(config.INVOICE_DOWNLOAD_SELECTOR).first();

  if ((await downloadControl.count()) === 0) {
    throw new Error(
      `Could not resolve a download URL or control for invoice (row ${invoice.rowIndex}, date "${invoice.dateText}"). ` +
        `Check INVOICE_DOWNLOAD_SELECTOR against the actual billing page markup.`,
    );
  }

  const [download] = await Promise.all([page.waitForEvent("download"), downloadControl.click()]);
  await download.saveAs(filePath);
  return { ...invoice, filePath, fileName };
}
