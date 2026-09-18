import type { Config } from "../config.js";
import type { RunLogger } from "../logger.js";
import { createMailer } from "./index.js";

/**
 * Emails the ops admin when the stored Cursor session is missing, expired,
 * or blocked. Uses the same mail provider as invoice delivery, but never
 * the invoice recipient list.
 */
export async function notifyAdminOfSessionFailure(options: {
  config: Config;
  logger: RunLogger;
  runId: string;
  dryRun: boolean;
  error: Error;
}): Promise<void> {
  const { config, logger, runId, dryRun, error } = options;

  if (dryRun) {
    logger.info(
      { wouldSendTo: config.adminEmails, reason: error.message },
      "DRY_RUN enabled — skipping admin session-failure alert",
    );
    return;
  }

  try {
    const mailer = await createMailer(config);
    await mailer.send({
      to: config.adminEmails,
      from: config.MAIL_FROM,
      subject: "Cursor invoice mailer — session expired or blocked",
      text: [
        "The Cursor invoice mailer could not reach the billing page.",
        "",
        `Run ID: ${runId}`,
        `Reason: ${error.message}`,
        "",
        "This alert goes to ADMIN_EMAIL, not the invoice recipient.",
        "",
        "How to log in again and refresh the session:",
        "  1. On your machine, open the cursor-invoice-mailer repo (with .env already configured).",
        "  2. Run: npm run bootstrap-login",
        "  3. A real Chrome window opens on the Cursor billing page. If you are sent to login, complete it there — email/password may auto-fill, but you must finish any 2FA, verification code, or CAPTCHA yourself.",
        "  4. When you can see the invoice/billing history table, go back to the terminal and press Enter. That encrypts the new session and uploads it to Vercel Blob.",
        "  5. Optional check: npm run run-once -- --dry-run",
        "  6. Trigger the cron again, or wait for the next scheduled run.",
        "",
        "If a fresh session still fails on Vercel, Cursor is blocking the headless browser and this job needs a real Chrome.",
      ].join("\n"),
      attachments: [],
    });
    logger.info({ sentTo: config.adminEmails }, "Emailed admin about session failure");
  } catch (sendErr) {
    const message = sendErr instanceof Error ? sendErr.message : String(sendErr);
    logger.error({ err: message }, "Failed to send admin session-failure alert");
  }
}
