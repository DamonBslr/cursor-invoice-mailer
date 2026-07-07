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
 *
 * Bot-detection note: login/billing pages are frequently protected by
 * behavioral bot checks (Cloudflare Turnstile, Vercel BotID, etc.) that key
 * off two things Playwright's defaults trip almost immediately:
 *   1. Playwright's bundled Chromium build has a distinct, widely-fingerprinted
 *      automation signature — a real, already-installed Chrome is much less
 *      likely to be flagged, so we prefer `channel: "chrome"` when available.
 *   2. `locator.fill()` sets the DOM value directly without dispatching real
 *      key events, and clicking immediately after is an inhumanly fast
 *      sequence — we type character-by-character with randomized delay and
 *      pause before submitting instead.
 * None of this defeats every bot check, but it removes the most obvious
 * automation tells before falling back to you completing the flow by hand.
 */
import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { chromium } from "playwright";
import { loadConfig } from "../src/config.js";
import { saveSession } from "../src/session/store.js";

async function promptEnter(question: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question(question);
  rl.close();
}

function randomDelay(minMs: number, maxMs: number): Promise<void> {
  const ms = minMs + Math.random() * (maxMs - minMs);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function launchLeastDetectableBrowser() {
  const launchArgs = {
    headless: false,
    args: ["--disable-blink-features=AutomationControlled"],
  };

  try {
    // Prefer a real, already-installed Chrome — Playwright's own bundled
    // Chromium binary is far more commonly fingerprinted by bot detection.
    return await chromium.launch({ ...launchArgs, channel: "chrome" });
  } catch {
    console.log('No system Chrome found for channel "chrome" — falling back to Playwright\'s bundled Chromium.');
    return chromium.launch(launchArgs);
  }
}

async function main(): Promise<void> {
  const config = loadConfig();

  console.log(`Opening a browser to ${config.INVOICE_SOURCE_URL} ...`);
  const browser = await launchLeastDetectableBrowser();
  const context = await browser.newContext();

  // Mask the most commonly checked automation fingerprints. Applied before
  // any page script runs, in every frame.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    // @ts-expect-error - non-standard, only present when Chrome DevTools Protocol drives the page
    window.chrome = window.chrome || { runtime: {} };
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
  });

  const page = await context.newPage();

  await page.goto(config.INVOICE_SOURCE_URL, { waitUntil: "domcontentloaded" });

  if (config.CURSOR_LOGIN_EMAIL) {
    try {
      const emailField = page.locator('input[type="email"], input[name="email"]').first();
      if (await emailField.isVisible({ timeout: 5000 })) {
        await emailField.click();
        await randomDelay(150, 400);
        await emailField.pressSequentially(config.CURSOR_LOGIN_EMAIL, { delay: 60 + Math.random() * 80 });
        console.log("Auto-filled email address.");

        if (config.CURSOR_LOGIN_PASSWORD) {
          const passwordField = page.locator('input[type="password"]').first();
          if (await passwordField.isVisible({ timeout: 5000 }).catch(() => false)) {
            await randomDelay(200, 500);
            await passwordField.click();
            await randomDelay(150, 400);
            await passwordField.pressSequentially(config.CURSOR_LOGIN_PASSWORD, { delay: 60 + Math.random() * 80 });
            console.log("Auto-filled password.");
          }
        }

        const submitButton = page
          .locator('button[type="submit"], button:has-text("Continue"), button:has-text("Sign in"), button:has-text("Log in")')
          .first();
        if (await submitButton.isVisible({ timeout: 2000 }).catch(() => false)) {
          await randomDelay(400, 900);
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
