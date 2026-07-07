import type { RunLogger } from "./logger.js";

export interface RetryOptions {
  /** Number of retry attempts after the first try (0 = no retries). */
  retries: number;
  /** Base delay in ms before the first retry; doubles each subsequent attempt. */
  delayMs: number;
  /** Multiplier applied to delayMs on each subsequent attempt. Default 2. */
  backoffFactor?: number;
  /** Label used in log lines, e.g. "loadSession", "navigateToInvoices". */
  label: string;
  logger: RunLogger;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `fn`, retrying with exponential backoff on failure. Logs every
 * attempt (and the final failure) via the provided run-scoped logger so
 * transient issues are visible without crashing the whole job unnecessarily.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const { retries, delayMs, backoffFactor = 2, label, logger } = options;
  let attempt = 0;
  let lastError: unknown;

  while (attempt <= retries) {
    try {
      if (attempt > 0) {
        logger.info({ step: label, attempt }, `Retrying "${label}" (attempt ${attempt + 1}/${retries + 1})`);
      }
      return await fn();
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ step: label, attempt, err: message }, `Step "${label}" failed on attempt ${attempt + 1}`);

      if (attempt === retries) break;

      const wait = delayMs * Math.pow(backoffFactor, attempt);
      await sleep(wait);
      attempt += 1;
    }
  }

  logger.error({ step: label, attempts: attempt + 1 }, `Step "${label}" exhausted all retries`);
  throw lastError instanceof Error ? lastError : new Error(`Step "${label}" failed: ${String(lastError)}`);
}
