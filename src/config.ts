import { z } from "zod";

const boolFromString = z
  .string()
  .optional()
  .transform((v) => v === "true" || v === "1");

const envSchema = z.object({
  // Cursor login — only ever read by the local bootstrap script.
  CURSOR_LOGIN_EMAIL: z.string().email().optional(),
  CURSOR_LOGIN_PASSWORD: z.string().optional(),

  // Invoice source. Defaults confirmed against Cursor's actual billing page
  // markup (a <table> of invoices whose last column links to a Stripe
  // Hosted Invoice Page — see src/browser/invoices.ts for why that's a
  // separate hop from the actual PDF).
  INVOICE_SOURCE_URL: z.string().url().default("https://cursor.com/dashboard/billing"),
  INVOICE_ROW_SELECTOR: z.string().default('table:has(th:has-text("Invoice")) tbody tr'),
  INVOICE_DATE_SELECTOR: z.string().default("td:nth-child(1)"),
  INVOICE_DOWNLOAD_SELECTOR: z.string().default("td:last-child a[href]"),
  // Selector for the actual PDF download link, evaluated on the Stripe
  // Hosted Invoice Page (not on the billing table row).
  INVOICE_PDF_LINK_SELECTOR: z
    .string()
    .default('button:has-text("Download invoice"), a[href*="/pdf"], a[href$=".pdf"]'),
  INVOICE_COUNT: z.coerce.number().int().positive().default(1),

  // Recipient(s) — comma separated
  RECIPIENT_EMAIL: z.string().min(1, "RECIPIENT_EMAIL is required"),

  // Mail provider
  MAIL_PROVIDER: z.enum(["smtp", "resend", "sendgrid"]).default("smtp"),
  MAIL_FROM: z.string().min(1, "MAIL_FROM is required"),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().optional(),
  SMTP_SECURE: boolFromString,
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),

  RESEND_API_KEY: z.string().optional(),
  SENDGRID_API_KEY: z.string().optional(),

  // Session storage & encryption
  SESSION_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, "SESSION_ENCRYPTION_KEY must be a 64-char hex string (32 bytes)"),
  BLOB_READ_WRITE_TOKEN: z.string().min(1, "BLOB_READ_WRITE_TOKEN is required"),
  SESSION_BLOB_KEY: z.string().default("cursor-invoice-mailer/session.enc"),
  LEDGER_BLOB_KEY: z.string().default("cursor-invoice-mailer/ledger.json"),

  // Cron security
  CRON_SECRET: z.string().optional(),

  // Behavior
  DRY_RUN: boolFromString,
  MAX_RETRIES: z.coerce.number().int().nonnegative().default(3),
  RETRY_DELAY_MS: z.coerce.number().int().positive().default(1000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

export type Config = z.infer<typeof envSchema> & {
  recipients: string[];
};

let cached: Config | null = null;

/**
 * Parses and validates process.env once, memoizing the result. Throws a
 * descriptive error listing every missing/invalid variable so misconfiguration
 * fails fast and loudly instead of causing a confusing runtime error deep in
 * a browser automation step.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (cached) return cached;

  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  const recipients = parsed.data.RECIPIENT_EMAIL.split(",")
    .map((e) => e.trim())
    .filter(Boolean);

  if (recipients.length === 0) {
    throw new Error("RECIPIENT_EMAIL must contain at least one address");
  }

  if (parsed.data.MAIL_PROVIDER === "smtp") {
    if (!parsed.data.SMTP_HOST || !parsed.data.SMTP_PORT) {
      throw new Error("SMTP_HOST and SMTP_PORT are required when MAIL_PROVIDER=smtp");
    }
  } else if (parsed.data.MAIL_PROVIDER === "resend") {
    if (!parsed.data.RESEND_API_KEY) {
      throw new Error("RESEND_API_KEY is required when MAIL_PROVIDER=resend");
    }
  } else if (parsed.data.MAIL_PROVIDER === "sendgrid") {
    if (!parsed.data.SENDGRID_API_KEY) {
      throw new Error("SENDGRID_API_KEY is required when MAIL_PROVIDER=sendgrid");
    }
  }

  cached = { ...parsed.data, recipients };
  return cached;
}

/** Test/CLI helper to bypass memoization. */
export function resetConfigCache(): void {
  cached = null;
}
