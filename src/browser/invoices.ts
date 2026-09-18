import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import type { Config } from "../config.js";
import { InvoiceScrapeError, SessionAccessError } from "../errors.js";

const STRIPE_INVOICE_LINK_SELECTOR = 'a[href*="invoice.stripe.com"], a[href*="invoicedata.stripe.com"]';
const INVOICE_DATA_WAIT_MS = 45_000;

export interface InvoiceInfo {
  /** Stable-ish identifier used for ledger dedupe (hash of the view URL, or date+index fallback). */
  id: string;
  /** Raw scraped date text, for logging/subject lines. */
  dateText: string;
  /**
   * Absolute URL to the invoice's "View" link. For Cursor (Stripe-billed)
   * this is a Stripe Hosted Invoice Page, NOT a direct PDF — the real PDF
   * links only exist on that hosted page, see {@link downloadInvoice}.
   */
  viewUrl: string | null;
  rowIndex: number;
}

export type PdfKind = "invoice" | "receipt";

export interface DownloadedPdf {
  kind: PdfKind;
  filePath: string;
  fileName: string;
}

export interface DownloadedInvoice extends InvoiceInfo {
  /** Invoice PDF plus receipt PDF, in that order when both succeed. */
  files: DownloadedPdf[];
}

export interface InvoicePageSignals {
  url: string;
  httpStatus: number | null;
  title: string;
  bodyTextSample: string;
  hasPasswordField: boolean;
}

export interface BillingTableSummary {
  headerText: string;
  rowCount: number;
  stripeLinkCount: number;
}

export interface BillingPageDiagnostics {
  title: string;
  bodyTextLength: number;
  bodyTextSample: string;
  tableCount: number;
  hasPasswordField: boolean;
  hasInvoicesHeading: boolean;
  hasInvoiceColumnHeader: boolean;
  stripeLinkCount: number;
  tables: BillingTableSummary[];
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function looksLikeLoginPage(signals: InvoicePageSignals): boolean {
  const host = hostnameOf(signals.url);
  if (host === "authenticator.cursor.sh" || host.startsWith("authenticator.")) return true;
  if (/\/(login|sign-?in|auth)(\/|$|\?)/i.test(signals.url)) return true;
  if (/[?&]authorization_session_id=/i.test(signals.url)) return true;
  return signals.hasPasswordField;
}

function looksLikeCloudflareChallenge(signals: InvoicePageSignals): boolean {
  const haystack = `${signals.title}\n${signals.bodyTextSample}`;
  return (
    /just a moment/i.test(signals.title) ||
    /performing security verification/i.test(haystack) ||
    /verify you are not a bot/i.test(haystack) ||
    (/ray id/i.test(haystack) && /cloudflare/i.test(haystack))
  );
}

/**
 * Builds a loud, actionable error when the billing page never actually
 * loaded — expired Cursor session, WorkOS authenticator redirect, or a
 * Cloudflare bot challenge. Returns null when the page looks like the
 * real invoice source (or an empty-but-otherwise-normal billing page).
 */
export function invoicePageBlockError(signals: InvoicePageSignals): SessionAccessError | null {
  const login = looksLikeLoginPage(signals);
  const cloudflare = looksLikeCloudflareChallenge(signals);
  if (!login && !cloudflare) return null;

  const status = signals.httpStatus != null ? `HTTP ${signals.httpStatus}` : "no HTTP status";

  if (login && cloudflare) {
    return new SessionAccessError(
      `Session appears expired or blocked — redirected to Cursor's authenticator (${signals.url}) ` +
        `and then hit a Cloudflare bot challenge (${status}). ` +
        `Re-run "npm run bootstrap-login" to capture a fresh session. ` +
        `If a fresh session still fails on Vercel, Cursor is blocking this headless runtime and the job needs a real Chrome (local cron, VPS, or hosted browser).`,
    );
  }

  if (cloudflare) {
    return new SessionAccessError(
      `Blocked by a Cloudflare bot challenge on ${signals.url} (${status}). ` +
        `The Vercel headless browser cannot pass this check. ` +
        `Re-run "npm run bootstrap-login" locally; if a fresh session still fails on Vercel, this job needs a real Chrome outside serverless.`,
    );
  }

  return new SessionAccessError(
    `Session appears expired or invalid — landed on a login page (${signals.url}) instead of the invoice page. ` +
      `Re-run "npm run bootstrap-login" to capture a fresh session.`,
  );
}

export async function collectInvoicePageSignals(
  page: Page,
  httpStatus: number | null = null,
): Promise<InvoicePageSignals> {
  const [title, bodyTextSample, passwordCount] = await Promise.all([
    page.title().catch(() => ""),
    page
      .locator("body")
      .innerText()
      .then((text) => text.slice(0, 2000))
      .catch(() => ""),
    page
      .locator('input[type="password"]')
      .count()
      .catch(() => 0),
  ]);

  return {
    url: page.url(),
    httpStatus,
    title,
    bodyTextSample,
    hasPasswordField: passwordCount > 0,
  };
}

/**
 * Navigates to the configured invoice source URL and throws a clear,
 * actionable error if the session turns out to be invalid/expired or the
 * headless browser is stuck on a Cloudflare challenge (Cursor's
 * authenticator host, a login-looking URL, a password field, or the
 * "Just a moment..." interstitial), rather than failing confusingly
 * later as "no invoice rows matched".
 *
 * Returns the navigation's HTTP status (when available) so callers can
 * distinguish a normal 200 response that simply didn't render the expected
 * content (e.g. a server-side data fetch failure) from a non-200 response
 * (e.g. a bot-mitigation block) that never reaches that page at all.
 */
export async function navigateToInvoicePage(page: Page, config: Config): Promise<{ httpStatus: number | null }> {
  const response = await page.goto(config.INVOICE_SOURCE_URL, { waitUntil: "domcontentloaded" });
  const httpStatus = response?.status() ?? null;

  const block = invoicePageBlockError(await collectInvoicePageSignals(page, httpStatus));
  if (block) throw block;

  // Give the client-rendered billing fetch a chance to start. networkidle
  // often never arrives on this dashboard (long-lived connections), so the
  // timeout is expected and not treated as a failure.
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);

  const lateBlock = invoicePageBlockError(await collectInvoicePageSignals(page, httpStatus));
  if (lateBlock) throw lateBlock;

  return { httpStatus };
}

export function looksLikeBillingShell(diagnostics: BillingPageDiagnostics): boolean {
  return diagnostics.hasInvoicesHeading || diagnostics.hasInvoiceColumnHeader;
}

export async function collectBillingDiagnostics(page: Page): Promise<BillingPageDiagnostics> {
  return page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- `document` isn't declared in this project's (deliberately DOM-less) tsconfig lib; this callback runs in the browser, not Node.
    const doc = (globalThis as any).document;
    const bodyText: string = doc?.body?.innerText ?? "";
    const tables = Array.from(doc?.querySelectorAll("table") ?? []).map((tableNode) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- browser DOM node in a Node tsconfig.
      const table = tableNode as any;
      const headerText = Array.from(table.querySelectorAll("th"))
        .map((th) => String((th as { innerText?: string }).innerText ?? "").trim())
        .filter(Boolean)
        .join(" | ");
      return {
        headerText,
        rowCount: table.querySelectorAll("tbody tr").length,
        stripeLinkCount: table.querySelectorAll(
          'a[href*="invoice.stripe.com"], a[href*="invoicedata.stripe.com"]',
        ).length,
      };
    });

    return {
      title: doc?.title ?? "",
      bodyTextLength: bodyText.length,
      bodyTextSample: bodyText.slice(0, 2000),
      tableCount: tables.length,
      hasPasswordField: (doc?.querySelectorAll('input[type="password"]').length ?? 0) > 0,
      hasInvoicesHeading: /(?:^|\n)Invoices(?:\n|$)/.test(bodyText),
      hasInvoiceColumnHeader: tables.some((table) => /invoice/i.test(table.headerText) && /date/i.test(table.headerText)),
      stripeLinkCount:
        doc?.querySelectorAll('a[href*="invoice.stripe.com"], a[href*="invoicedata.stripe.com"]').length ?? 0,
      tables,
    };
  });
}

function invoiceIdFrom(viewUrl: string | null, dateText: string, index: number): string {
  const idSource = viewUrl ?? `${dateText}-${index}`;
  return createHash("sha256").update(idSource).digest("hex").slice(0, 16);
}

async function scrapeConfiguredRows(page: Page, config: Config): Promise<InvoiceInfo[]> {
  const rows = page.locator(config.INVOICE_ROW_SELECTOR);
  const count = await rows.count();
  const limit = config.INVOICE_COUNT > 0 ? config.INVOICE_COUNT : Number.POSITIVE_INFINITY;
  const invoices: InvoiceInfo[] = [];

  for (let i = 0; i < count && invoices.length < limit; i++) {
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
      // Empty placeholder / header row — the billing shell often renders
      // these before the invoice data fetch completes.
      continue;
    }

    invoices.push({
      id: invoiceIdFrom(viewUrl, dateText, i),
      dateText: dateText || `row-${i}`,
      viewUrl,
      rowIndex: i,
    });
  }

  return invoices;
}

/**
 * Fallback when the table markup no longer matches INVOICE_ROW_SELECTOR:
 * collect every Stripe hosted-invoice link on the page.
 */
async function scrapeStripeInvoiceLinks(page: Page, config: Config): Promise<InvoiceInfo[]> {
  const links = page.locator(STRIPE_INVOICE_LINK_SELECTOR);
  const count = await links.count();
  const limit = config.INVOICE_COUNT > 0 ? config.INVOICE_COUNT : Number.POSITIVE_INFINITY;
  const invoices: InvoiceInfo[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < count && invoices.length < limit; i++) {
    const href = await links.nth(i).getAttribute("href").catch(() => null);
    if (!href) continue;

    const viewUrl = new URL(href, page.url()).toString();
    if (seen.has(viewUrl)) continue;
    seen.add(viewUrl);

    const dateText = (
      await links
        .nth(i)
        .evaluate((el) => {
          const node = el as {
            closest?: (selector: string) => { querySelector?: (selector: string) => { textContent?: string } | null } | null;
            textContent?: string;
          };
          const row = node.closest?.("tr, [role='row']");
          const firstCell = row?.querySelector?.("td, [role='cell']");
          return (firstCell?.textContent || node.textContent || "").trim();
        })
        .catch(() => "")
    ).trim();

    invoices.push({
      id: invoiceIdFrom(viewUrl, dateText, i),
      dateText: dateText || `stripe-${i}`,
      viewUrl,
      rowIndex: i,
    });
  }

  return invoices;
}

/**
 * Scrapes the invoice table using the configurable selectors, returning
 * every matching row in DOM order (`INVOICE_COUNT` 0 = unlimited; N > 0
 * caps at the N newest). Falls back to Stripe hosted-invoice links if the
 * table rows are empty placeholders or the markup no longer matches.
 *
 * The dashboard is client-rendered: the table often has empty `<tr>`s at
 * `domcontentloaded`. Waiting for any row is not enough — we wait for a
 * real Stripe invoice link (or give up after {@link INVOICE_DATA_WAIT_MS}).
 * If the Invoices heading / column headers are visible but nothing usable
 * appears, this throws {@link InvoiceScrapeError} instead of returning [].
 */
export async function scrapeInvoices(page: Page, config: Config): Promise<InvoiceInfo[]> {
  const populated = page.locator(
    [
      `${config.INVOICE_ROW_SELECTOR} a[href*="invoice.stripe.com"]`,
      `${config.INVOICE_ROW_SELECTOR} a[href*="invoicedata.stripe.com"]`,
      STRIPE_INVOICE_LINK_SELECTOR,
    ].join(", "),
  );
  await populated.first().waitFor({ state: "attached", timeout: INVOICE_DATA_WAIT_MS }).catch(() => undefined);

  const fromRows = await scrapeConfiguredRows(page, config);
  const invoices = fromRows.length > 0 ? fromRows : await scrapeStripeInvoiceLinks(page, config);

  if (invoices.length === 0) {
    const diagnostics = await collectBillingDiagnostics(page);
    if (looksLikeBillingShell(diagnostics)) {
      throw new InvoiceScrapeError(
        `Billing page loaded but no invoice rows or Stripe invoice links appeared after ${INVOICE_DATA_WAIT_MS / 1000}s. ` +
          `The Invoices table chrome was visible (headers=${JSON.stringify(diagnostics.tables)}), ` +
          `so this is a failed billing-data fetch or selector mismatch, not an empty account. ` +
          `Check function logs for failed cursor.com API responses.`,
      );
    }
  }

  return invoices;
}

function safeDateSlug(invoice: InvoiceInfo): string {
  return invoice.dateText.replace(/[^\w-]+/g, "_") || invoice.id;
}

/**
 * Clicks a PDF download control on the hosted invoice page and saves the
 * resulting native `download` event. Stripe generates PDFs client-side and
 * rejects non-browser HTTP clients, so this must stay a real browser click.
 */
async function clickAndSavePdf(
  context: BrowserContext,
  page: Page,
  selector: string,
  filePath: string,
  label: string,
  viewUrl: string,
): Promise<void> {
  const pdfLink = page.locator(selector).first();
  await pdfLink.waitFor({ state: "visible", timeout: 20_000 }).catch(() => {
    throw new Error(
      `Could not find a ${label} download link on the hosted invoice page (${viewUrl}). ` +
        `Check the matching *_PDF_LINK_SELECTOR against that page's markup.`,
    );
  });

  // Listen on the context (not just this page) in case the link opens the
  // PDF in yet another tab rather than downloading in-place.
  const [download] = await Promise.all([
    context.waitForEvent("download", { timeout: 30_000 }),
    pdfLink.click(),
  ]);
  await download.saveAs(filePath);
}

/**
 * Downloads the invoice PDF and payment receipt PDF for a single billing row.
 *
 * Cursor's "View" link points to a Stripe Hosted Invoice Page (view/pay
 * page), not the PDFs themselves — Stripe only exposes the real download
 * controls on that hosted page. Stripe also explicitly rejects non-browser
 * HTTP clients requesting PDF URLs directly (documented anti-scraping
 * behavior), so this deliberately drives a real browser tab and clicks each
 * download control rather than fetching out-of-band, and captures the
 * resulting native `download` events.
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
  const slug = safeDateSlug(invoice);
  const invoiceFileName = `invoice-${slug}.pdf`;
  const receiptFileName = `receipt-${slug}.pdf`;
  const invoiceFilePath = path.join(destDir, invoiceFileName);
  const receiptFilePath = path.join(destDir, receiptFileName);

  const invoicePage = await context.newPage();
  try {
    await invoicePage.goto(invoice.viewUrl, { waitUntil: "domcontentloaded" });

    await clickAndSavePdf(
      context,
      invoicePage,
      config.INVOICE_PDF_LINK_SELECTOR,
      invoiceFilePath,
      "invoice",
      invoice.viewUrl,
    );
    await clickAndSavePdf(
      context,
      invoicePage,
      config.RECEIPT_PDF_LINK_SELECTOR,
      receiptFilePath,
      "receipt",
      invoice.viewUrl,
    );
  } finally {
    await invoicePage.close().catch(() => undefined);
  }

  return {
    ...invoice,
    files: [
      { kind: "invoice", filePath: invoiceFilePath, fileName: invoiceFileName },
      { kind: "receipt", filePath: receiptFilePath, fileName: receiptFileName },
    ],
  };
}
