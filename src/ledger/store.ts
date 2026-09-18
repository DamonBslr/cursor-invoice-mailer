import type { Config } from "../config.js";
import { readBlob, writeBlob } from "../blob.js";

export const CURRENT_LEDGER_VERSION = 2;
const LEDGER_MAX_IDS = 500;

export interface Ledger {
  /** Invoice ids that have already been emailed (or seeded as historical), most recent last. */
  sentInvoiceIds: string[];
  lastRunAt: string | null;
  /**
   * Schema version. Missing or below 2 means this ledger predates
   * per-invoice send-once tracking and still needs the one-time historical seed.
   */
  ledgerVersion?: number;
}

const EMPTY_LEDGER: Ledger = { sentInvoiceIds: [], lastRunAt: null };

/**
 * Loads the "already sent" ledger from Vercel Blob. This is what makes the
 * daily cron trigger safe to run against a monthly invoice cycle: invoices
 * already emailed are skipped rather than re-sent every day.
 */
export async function loadLedger(config: Config): Promise<Ledger> {
  const raw = await readBlob(config.LEDGER_BLOB_KEY, config.BLOB_READ_WRITE_TOKEN);
  if (!raw) return { ...EMPTY_LEDGER };

  try {
    const parsed = JSON.parse(raw) as Partial<Ledger>;
    return {
      sentInvoiceIds: Array.isArray(parsed.sentInvoiceIds) ? parsed.sentInvoiceIds : [],
      lastRunAt: parsed.lastRunAt ?? null,
      ledgerVersion: typeof parsed.ledgerVersion === "number" ? parsed.ledgerVersion : undefined,
    };
  } catch {
    // Corrupt ledger should never crash the job; treat as empty so a fresh
    // invoice still gets sent (worst case: one duplicate email, not silence).
    return { ...EMPTY_LEDGER };
  }
}

export function hasBeenSent(ledger: Ledger, invoiceId: string): boolean {
  return ledger.sentInvoiceIds.includes(invoiceId);
}

export function needsSeedMigration(ledger: Ledger): boolean {
  return (ledger.ledgerVersion ?? 0) < CURRENT_LEDGER_VERSION;
}

async function persistLedger(ledger: Ledger, config: Config): Promise<void> {
  await writeBlob(
    config.LEDGER_BLOB_KEY,
    JSON.stringify(ledger, null, 2),
    config.BLOB_READ_WRITE_TOKEN,
    "application/json",
  );
}

/**
 * One-time migration: mark every invoice currently visible on the billing
 * page as already handled, without emailing. Subsequent runs only email
 * invoices that appear after this seed. No-ops once `ledgerVersion` is 2+.
 */
export async function seedExistingInvoices(
  ledger: Ledger,
  invoiceIds: string[],
  config: Config,
): Promise<Ledger> {
  if (!needsSeedMigration(ledger)) return ledger;

  const updated: Ledger = {
    sentInvoiceIds: [...new Set([...ledger.sentInvoiceIds, ...invoiceIds])].slice(-LEDGER_MAX_IDS),
    lastRunAt: new Date().toISOString(),
    ledgerVersion: CURRENT_LEDGER_VERSION,
  };
  await persistLedger(updated, config);
  return updated;
}

/**
 * Marks an invoice as sent and persists the updated ledger. Caps history at
 * the most recent 500 ids to keep the blob small indefinitely.
 */
export async function recordSent(ledger: Ledger, invoiceId: string, config: Config): Promise<Ledger> {
  const updated: Ledger = {
    sentInvoiceIds: [...ledger.sentInvoiceIds, invoiceId].slice(-LEDGER_MAX_IDS),
    lastRunAt: new Date().toISOString(),
    ledgerVersion: ledger.ledgerVersion,
  };
  await persistLedger(updated, config);
  return updated;
}

/** Updates lastRunAt without marking any new invoice as sent (e.g. dry-run or no-op runs). */
export async function touchLedger(ledger: Ledger, config: Config): Promise<Ledger> {
  const updated: Ledger = { ...ledger, lastRunAt: new Date().toISOString() };
  await persistLedger(updated, config);
  return updated;
}
