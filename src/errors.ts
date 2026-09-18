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
