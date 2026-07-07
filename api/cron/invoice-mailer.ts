import type { VercelRequest, VercelResponse } from "@vercel/node";
import { runJob } from "../../src/job.js";
import { logger } from "../../src/logger.js";

/**
 * Vercel Cron entry point. Scheduled daily in vercel.json; the job itself is
 * idempotent (see src/ledger/store.ts) so repeated daily triggers only ever
 * result in an email when a genuinely new invoice appears.
 *
 * Vercel automatically sends `Authorization: Bearer $CRON_SECRET` on
 * cron-triggered requests when a CRON_SECRET env var is configured — we
 * verify it here to reject any other caller.
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const expectedSecret = process.env.CRON_SECRET;
  if (expectedSecret) {
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${expectedSecret}`) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
  }

  try {
    const result = await runJob();
    logger.info({ result }, "Cron run completed");
    res.status(200).json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, "Cron run failed");
    res.status(500).json({ error: message });
  }
}
