#!/usr/bin/env tsx
/**
 * Local CLI entry point for manually running the full invoice mailer job —
 * the same src/job.ts used by the Vercel Cron route. Useful for verifying
 * selectors and email delivery before relying on the schedule.
 *
 * Usage:
 *   npm run run-once                 # real run (sends email if a new invoice is found)
 *   npm run run-once -- --dry-run    # scrapes + downloads but never sends or updates the ledger
 */
import "dotenv/config";
import { runJob } from "../src/job.js";

const dryRunFlag = process.argv.includes("--dry-run");

runJob({ dryRunOverride: dryRunFlag || undefined })
  .then((result) => {
    console.log("\nJob finished:");
    console.log(JSON.stringify(result, null, 2));
  })
  .catch((err) => {
    console.error("\nJob failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
