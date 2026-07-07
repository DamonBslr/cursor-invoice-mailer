#!/usr/bin/env tsx
/**
 * One-time, local, interactive login capture.
 *
 * Opens a real (headed) browser, navigates to the invoice source page (which
 * will redirect to Cursor's login flow if not authenticated), best-effort
 * auto-fills the email/password fields if provided via env, then PAUSES so
 * you can complete anything automation shouldn't handle unattended — a 2FA
 * code, a CAPTCHA, an unexpected prompt, etc.
 *
 * Once you confirm you're logged in, the resulting Playwright storageState
 * (cookies/localStorage) is encrypted and uploaded to Vercel Blob, where the
 * scheduled cron job will load it from on every run — no password is ever
 * stored or reused by the automated job itself.
 */
import { createInterface } from "node:readline/promises";
import { chromium } from "playwright";
import { loadConfig } from "../src/config.js";
import { saveSession } from "../src/session/store.js";

async function promptEnter(question: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question(question);
  rl.close();
}

async function main(): Promise<void> {
  const config = loadConfig();

  console.log(`Opening a browser to ${config.INVOICE_SOURCE_URL} ...`);
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(config.INVOICE_SOURCE_URL, { waitUntil: "domcontentloaded" });

  if (config.CURSOR_LOGIN_EMAIL) {
    try {
      const emailField = page.locator('input[type="email"], input[name="email"]').first();
      if (await emailField.isVisible({ timeout: 5000 })) {
        await emailField.fill(config.CURSOR_LOGIN_EMAIL);
        console.log("Auto-filled email address.");

        if (config.CURSOR_LOGIN_PASSWORD) {
          const passwordField = page.locator('input[type="password"]').first();
          if (await passwordField.isVisible({ timeout: 5000 }).catch(() => false)) {
            await passwordField.fill(config.CURSOR_LOGIN_PASSWORD);
            console.log("Auto-filled password.");
          }
        }

        const submitButton = page
          .locator('button[type="submit"], button:has-text("Continue"), button:has-text("Sign in"), button:has-text("Log in")')
          .first();
        if (await submitButton.isVisible({ timeout: 2000 }).catch(() => false)) {
          await submitButton.click();
          console.log("Submitted login form.");
        }
      }
    } catch {
      console.log("Could not auto-fill the login form (selectors may not match) — please log in manually below.");
    }
  }

  console.log("\n--------------------------------------------------------------");
  console.log("Complete login in the opened browser window, including any");
  console.log("verification code, 2FA prompt, or CAPTCHA.");
  console.log("Once you can see the billing/invoice history page, come back");
  console.log("here and press Enter to capture the session.");
  console.log("--------------------------------------------------------------\n");

  await promptEnter("Press Enter once logged in and viewing the billing page... ");

  const hasPasswordField = (await page.locator('input[type="password"]').count()) > 0;
  if (hasPasswordField) {
    console.warn(
      "Warning: a password field is still visible on the page — login may not have completed. " +
        "Continuing anyway; re-run this script if the captured session doesn't work.",
    );
  }

  const storageState = await context.storageState();
  await saveSession(JSON.stringify(storageState), config);

  console.log(`\nSession captured and encrypted to Vercel Blob at "${config.SESSION_BLOB_KEY}".`);
  console.log('You can now run "npm run run-once -- --dry-run" to verify the scheduled job can read it.');

  await browser.close();
}

main().catch((err) => {
  console.error("bootstrap-login failed:", err);
  process.exitCode = 1;
});
