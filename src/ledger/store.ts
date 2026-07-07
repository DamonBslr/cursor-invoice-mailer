import type { Config } from "../config.js";
import { readBlob, writeBlob } from "../blob.js";

export interface Ledger {
  /** Invoice ids that have already been emailed, most recent last. */
  sentInvoiceIds: string[];
  lastRunAt: string | null;
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

/**
 * Marks an invoice as sent and persists the updated ledger. Caps history at
 * the most recent 50 ids to keep the blob small indefinitely.
 */
export async function recordSent(ledger: Ledger, invoiceId: string, config: Config): Promise<Ledger> {
  const updated: Ledger = {
    sentInvoiceIds: [...ledger.sentInvoiceIds, invoiceId].slice(-50),
    lastRunAt: new Date().toISOString(),
  };
  await writeBlob(config.LEDGER_BLOB_KEY, JSON.stringify(updated, null, 2), config.BLOB_READ_WRITE_TOKEN, "application/json");
  return updated;
}

/** Updates lastRunAt without marking any new invoice as sent (e.g. dry-run or no-op runs). */
export async function touchLedger(ledger: Ledger, config: Config): Promise<Ledger> {
  const updated: Ledger = { ...ledger, lastRunAt: new Date().toISOString() };
  await writeBlob(config.LEDGER_BLOB_KEY, JSON.stringify(updated, null, 2), config.BLOB_READ_WRITE_TOKEN, "application/json");
  return updated;
}
