/**
 * Thrown when the job cannot reach the billing page because the stored
 * Cursor session is missing, expired, or blocked (login redirect /
 * Cloudflare challenge). Callers treat this as an ops alert, not a
 * "no invoices today" result.
 */
export class SessionAccessError extends Error {
  readonly name = "SessionAccessError";

  constructor(message: string) {
    super(message);
    this.name = "SessionAccessError";
  }
}

/**
 * Thrown when the billing page shell loaded (logged in, invoice table
 * headers visible) but no invoice rows or Stripe invoice links appeared.
 * That is a failed data fetch or selector mismatch — not an empty account.
 */
export class InvoiceScrapeError extends Error {
  readonly name = "InvoiceScrapeError";

  constructor(message: string) {
    super(message);
    this.name = "InvoiceScrapeError";
  }
}
