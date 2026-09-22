import type { Config } from "../config.js";
import { readBlob, writeBlob } from "../blob.js";

export const CURRENT_LEDGER_VERSION = 3;
const LEDGER_MAX_IDS = 500;

export interface Ledger {
  /** Invoice ids that have already been emailed (or seeded as historical), most recent last. */
  sentInvoiceIds: string[];
  /** Stable date|description|amount keys — survives rotating Stripe view URLs. */
  sentFingerprints: string[];
  lastRunAt: string | null;
  /**
   * Schema version. Below 3 means this ledger still hashes Stripe view URLs
   * (which rotate) and needs a re-seed with stable fingerprints.
   */
  ledgerVersion?: number;
}

const EMPTY_LEDGER: Ledger = { sentInvoiceIds: [], sentFingerprints: [], lastRunAt: null };

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
      sentFingerprints: Array.isArray(parsed.sentFingerprints) ? parsed.sentFingerprints : [],
      lastRunAt: parsed.lastRunAt ?? null,
      ledgerVersion: typeof parsed.ledgerVersion === "number" ? parsed.ledgerVersion : undefined,
    };
  } catch {
    // Corrupt ledger should never crash the job; treat as empty so a fresh
    // invoice still gets sent (worst case: one duplicate email, not silence).
    return { ...EMPTY_LEDGER };
  }
}

export function hasBeenSent(ledger: Ledger, invoiceId: string, fingerprint?: string): boolean {
  if (ledger.sentInvoiceIds.includes(invoiceId)) return true;
  if (fingerprint && ledger.sentFingerprints.includes(fingerprint)) return true;
  return false;
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
  invoices: Array<{ id: string; fingerprint: string }>,
  config: Config,
): Promise<Ledger> {
  if (!needsSeedMigration(ledger)) return ledger;

  const updated: Ledger = {
    sentInvoiceIds: [...new Set([...ledger.sentInvoiceIds, ...invoices.map((inv) => inv.id)])].slice(-LEDGER_MAX_IDS),
    sentFingerprints: [...new Set([...ledger.sentFingerprints, ...invoices.map((inv) => inv.fingerprint).filter(Boolean)])].slice(
      -LEDGER_MAX_IDS,
    ),
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
export async function recordSent(
  ledger: Ledger,
  invoice: { id: string; fingerprint?: string },
  config: Config,
): Promise<Ledger> {
  const fingerprints = invoice.fingerprint
    ? [...ledger.sentFingerprints, invoice.fingerprint]
    : ledger.sentFingerprints;
  const updated: Ledger = {
    sentInvoiceIds: [...ledger.sentInvoiceIds, invoice.id].slice(-LEDGER_MAX_IDS),
    sentFingerprints: [...new Set(fingerprints)].slice(-LEDGER_MAX_IDS),
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
