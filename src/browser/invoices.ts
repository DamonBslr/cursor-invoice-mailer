import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import type { Config } from "../config.js";

export interface InvoiceInfo {
  /** Stable-ish identifier used for ledger dedupe (hash of the view URL, or date+index fallback). */
  id: string;
  /** Raw scraped date text, for logging/subject lines. */
  dateText: string;
  /**
   * Absolute URL to the invoice's "View" link. For Cursor (Stripe-billed)
   * this is a Stripe Hosted Invoice Page, NOT a direct PDF — the real PDF
   * link only exists on that hosted page, see {@link downloadInvoice}.
   */
  viewUrl: string | null;
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
 * to `config.INVOICE_COUNT` most recent rows in DOM order. Cursor's billing
 * page lists invoices newest-first (confirmed against the real markup: a
 * `<table>` with one `<tr>` per invoice, date in the first `<td>`, and a
 * "View" link — the Stripe Hosted Invoice Page — in the last `<td>`).
 */
export async function scrapeInvoices(page: Page, config: Config): Promise<InvoiceInfo[]> {
  const rows = page.locator(config.INVOICE_ROW_SELECTOR);
  const count = await rows.count();

  const invoices: InvoiceInfo[] = [];

  for (let i = 0; i < count && invoices.length < config.INVOICE_COUNT; i++) {
    const row = rows.nth(i);

    const dateText = (await row.locator(config.INVOICE_DATE_SELECTOR).first().innerText().catch(() => "")).trim();

    const viewLocator = row.locator(config.INVOICE_DOWNLOAD_SELECTOR).first();
    const hasViewLink = (await viewLocator.count()) > 0;
    let viewUrl: string | null = null;

    if (hasViewLink) {
      const href = await viewLocator.getAttribute("href").catch(() => null);
      if (href) {
        viewUrl = new URL(href, page.url()).toString();
      }
    }

    if (!dateText && !viewUrl) {
      // Nothing usable on this row — likely a header row or selector mismatch.
      continue;
    }

    const idSource = viewUrl ?? `${dateText}-${i}`;
    const id = createHash("sha256").update(idSource).digest("hex").slice(0, 16);

    invoices.push({ id, dateText: dateText || `row-${i}`, viewUrl, rowIndex: i });
  }

  return invoices;
}

/**
 * Downloads a single invoice PDF.
 *
 * Cursor's "View" link points to a Stripe Hosted Invoice Page (view/pay
 * page), not the PDF itself — Stripe only exposes the real PDF link on that
 * page. Stripe also explicitly rejects non-browser HTTP clients requesting
 * PDF URLs directly (documented anti-scraping behavior), so this
 * deliberately drives a real browser tab and clicks the PDF link rather
 * than fetching it out-of-band, and captures the resulting native
 * `download` event.
 */
export async function downloadInvoice(
  context: BrowserContext,
  invoice: InvoiceInfo,
  destDir: string,
  config: Config,
): Promise<DownloadedInvoice> {
  if (!invoice.viewUrl) {
    throw new Error(
      `No "View" link URL was resolved for invoice (row ${invoice.rowIndex}, date "${invoice.dateText}"). ` +
        `Check INVOICE_DOWNLOAD_SELECTOR against the actual billing page markup.`,
    );
  }

  await mkdir(destDir, { recursive: true });
  const fileName = `invoice-${invoice.dateText.replace(/[^\w-]+/g, "_") || invoice.id}.pdf`;
  const filePath = path.join(destDir, fileName);

  const invoicePage = await context.newPage();
  try {
    await invoicePage.goto(invoice.viewUrl, { waitUntil: "domcontentloaded" });

    const pdfLink = invoicePage.locator(config.INVOICE_PDF_LINK_SELECTOR).first();
    await pdfLink.waitFor({ state: "visible", timeout: 20_000 }).catch(() => {
      throw new Error(
        `Could not find a PDF download link on the hosted invoice page (${invoice.viewUrl}). ` +
          `Check INVOICE_PDF_LINK_SELECTOR against that page's markup.`,
      );
    });

    // Listen on the context (not just this page) in case the link opens the
    // PDF in yet another tab rather than downloading in-place.
    const [download] = await Promise.all([
      context.waitForEvent("download", { timeout: 30_000 }),
      pdfLink.click(),
    ]);
    await download.saveAs(filePath);
  } finally {
    await invoicePage.close().catch(() => undefined);
  }

  return { ...invoice, filePath, fileName };
}
